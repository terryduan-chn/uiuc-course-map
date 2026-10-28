// The #audit page: upload a uAchieve degree audit (PDF) and get a checklist of what's left.
// The PDF is read in this browser with pdf.js and never sent anywhere; only the requirements
// and course codes are kept (in localStorage), never the student's name or ID.

import {
  catalogYearLabel,
  describeNeeds,
  describePattern,
  genEdCodesFor,
  linesFromPages,
  partGroups,
  partIsMet,
  readAudit,
  requirementSections,
  sectionIsMet,
  takenCourseIds,
  takenCourseDetails,
  titleCase,
} from "./audit-reader.js";
import { missingRequirements } from "./graph-data.js";
import { keepFocus, myCourses } from "./my-courses.js";
import { SLOT_HOURS, slotKindFor, slotTitle } from "./plan-insights.js";
import { courseFacts, requirementCourses } from "./requirement-courses.js";
import { termLabel, termOrder } from "./terms.js";

const PDFJS_CDN = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/";
const STORAGE_KEY = "degreeAudit";
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const OPTIONS_SHOWN = 8; // course chips shown per requirement before "show all"
const GEN_ED_OPTIONS = 40; // Gen Ed courses looked at (best GPA first) before the list is trimmed
const DEGREE_AUDIT_HELP = "https://registrar.illinois.edu/academic-records/dars-audit/";

/** The audit saved in this browser (requirements and course codes only), or null. */
export function savedAudit() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    return saved && Array.isArray(saved.sections) ? saved : null;
  } catch {
    return null;
  }
}

function save(audit) {
  try {
    if (audit) localStorage.setItem(STORAGE_KEY, JSON.stringify(audit));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage blocked: the checklist still shows for this visit.
  }
}

/**
 * The plan belongs to the audit: this removes both (audit, courses and Gen Ed slots) from this
 * browser, after asking. Returns whether it did.
 */
export function clearEverything() {
  const sure = window.confirm(
    "Clear everything? Your audit, your plan, your Gen Ed slots and every course you marked are removed from this browser. This can't be undone.",
  );
  if (!sure) return false;
  save(null);
  myCourses.startOver();
  return true;
}

/** The PDF's text lines, read in the browser. */
async function pdfLines(file) {
  const pdfjs = await import(`${PDFJS_CDN}pdf.min.mjs`);
  pdfjs.GlobalWorkerOptions.workerSrc = `${PDFJS_CDN}pdf.worker.min.mjs`;
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const pages = [];
  for (let number = 1; number <= pdf.numPages; number++) {
    pages.push((await (await pdf.getPage(number)).getTextContent()).items);
  }
  return linesFromPages(pages);
}

/**
 * @param {{ rows: Function, element: Function, getGraph: () => object, onMakePlan: () => void }} helpers
 *   onMakePlan auto-plans from the audit and opens My plan
 */
export function createAuditView({ rows, element, getGraph, onMakePlan }) {
  const section = document.getElementById("audit-view");
  let audit = savedAudit();
  let message = ""; // the latest upload result or error

  const courseHash = (id) => `#${id.replace(" ", "-")}`;

  /** How a course stands for you: taken, planned, ready (prerequisites met) or later. */
  function standing(id, graph, taken) {
    const status = myCourses.status(id);
    if (status) return status;
    return missingRequirements(graph, id, taken).length === 0 ? "ready" : "later";
  }

  const STANDING_ORDER = { taken: 0, planned: 1, ready: 2, later: 3 };
  const STANDING_TEXT = {
    taken: "taken",
    planned: "planned",
    ready: "you can take it now",
    later: "needs prerequisites first",
  };

  function chip(id, title, state) {
    return element(
      "a",
      { className: `audit-chip ${state}`, href: courseHash(id), title: `${id}: ${title} (${STANDING_TEXT[state]})` },
      state === "taken" ? "✓ " : "",
      id,
    );
  }

  /**
   * The courses that can meet a part, best first (can take now, then higher GPA), with the rest
   * behind "show all". Courses not offered lately are left out, and ones already taken are listed
   * once as counted rather than as choices.
   */
  function options(part, graph, taken, facts) {
    const genEd = part.selectFrom.length === 0 ? genEdCodesFor(part.title) : [];
    const courses = requirementCourses(rows, part, { genEdLimit: GEN_ED_OPTIONS });
    const anyLevel = part.selectFrom.filter((pattern) => pattern.subject === "*").map(describePattern);
    const counted = courses.filter(([id]) => myCourses.status(id) === "taken");
    const offered = courses.filter(([id]) => myCourses.status(id) !== "taken" && facts.get(id)?.offered);
    const hidden = courses.length - counted.length - offered.length;
    const ranked = offered.map(([id, title]) => ({ id, title, state: standing(id, graph, taken) }));
    ranked.sort(
      (a, b) =>
        STANDING_ORDER[a.state] - STANDING_ORDER[b.state] ||
        (facts.get(b.id)?.gpa ?? 0) - (facts.get(a.id)?.gpa ?? 0) ||
        a.id.localeCompare(b.id),
    );
    const chips = ranked.map(({ id, title, state }) => chip(id, title, state));

    const pieces = [];
    if (genEd.length > 0) pieces.push(planNote(part));
    if (counted.length > 0) {
      pieces.push(
        element(
          "p",
          { className: "audit-hint audit-counted" },
          "Counted already: ",
          ...counted.flatMap(([id], i) => [
            i > 0 ? ", " : "",
            element("a", { href: courseHash(id), textContent: `✓ ${id}` }),
          ]),
        ),
      );
    }
    if (chips.length > 0) {
      pieces.push(
        element("p", {
          className: "audit-hint",
          textContent: genEd.length > 0 ? "Gen Ed courses that count, best first:" : "Courses that count, best first:",
        }),
        element("div", { className: "audit-chips" }, ...chips.slice(0, OPTIONS_SHOWN)),
      );
      if (chips.length > OPTIONS_SHOWN) {
        pieces.push(
          element(
            "details",
            { className: "audit-more" },
            element("summary", { textContent: `Show all ${chips.length} courses` }),
            element("div", { className: "audit-chips" }, ...chips.slice(OPTIONS_SHOWN)),
          ),
        );
      }
    }
    if (hidden > 0) {
      pieces.push(
        element("p", {
          className: "audit-hint audit-old",
          textContent: `${hidden} older course${hidden === 1 ? "" : "s"} not offered lately ${hidden === 1 ? "is" : "are"} left out.`,
        }),
      );
    }
    if (anyLevel.length > 0)
      pieces.push(element("p", { className: "audit-hint", textContent: `Also counts: ${anyLevel.join(", ")}.` }));
    if (part.notFrom.length > 0) {
      pieces.push(
        element("p", {
          className: "audit-hint",
          textContent: `Doesn't count: ${part.notFrom.map(describePattern).join(", ")}.`,
        }),
      );
    }
    if (pieces.length === 0 && !part.needs?.hours) {
      pieces.push(
        element("p", {
          className: "audit-hint",
          textContent: "The audit lists no courses for this one. Ask your advisor what counts.",
        }),
      );
    }
    for (const note of part.notes) pieces.push(element("p", { className: "audit-note", textContent: note }));
    return pieces;
  }

  /**
   * How far the plan goes toward a part: planned courses that count (and, for a Gen Ed, open
   * slots, 3 hours each), as { state: "planned" | "partly" | "none", have, need, unit }.
   * "Any 400-level course" parts can't be checked, so they count only listed courses.
   */
  function coverage(part, facts) {
    const needCourses = part.needs?.courses ?? (part.needs?.hours ? 0 : 1);
    const needHours = part.needs?.hours ?? 0;
    // Counted only in hours, with no course list ("ADVANCED HOURS", "45 HOURS OF UIUC COURSEWORK"):
    // every planned hour counts (300-level and up for advanced hours).
    if (needHours > 0 && !needCourses && part.selectFrom.length === 0 && genEdCodesFor(part.title).length === 0) {
      return hoursCoverage(part.title, needHours, facts);
    }
    const planned = requirementCourses(rows, part)
      .map(([id]) => id)
      .filter((id) => myCourses.status(id) === "planned");
    const kind = slotKindFor(part.title);
    const slots = kind ? myCourses.slots().filter((slot) => [slot.kind, ...slot.also].includes(kind)) : [];
    const courses = planned.length + slots.length;
    const hours = planned.reduce((sum, id) => sum + (facts.get(id)?.hours ?? 3), 0) + slots.length * SLOT_HOURS;
    const byHours = needHours > 0 && !needCourses;
    const have = byHours ? hours : courses;
    const need = byHours ? needHours : needCourses;
    const state = have >= need && hours >= needHours ? "planned" : have > 0 ? "partly" : "none";
    return { state, have: Math.min(have, need), need, unit: byHours ? "hours" : "courses" };
  }

  /** How many of `needHours` the plan's planned courses (and Gen Ed slots) add up to. */
  function hoursCoverage(title, needHours, facts) {
    const advanced = /ADVANCED/.test(title);
    const planned = myCourses
      .ids("planned")
      .filter((id) => !advanced || Number(id.split(" ")[1]) >= 300)
      .reduce((sum, id) => sum + (facts.get(id)?.hours ?? 3), 0);
    const slots = advanced ? 0 : myCourses.slots().length * SLOT_HOURS;
    const have = planned + slots;
    return {
      state: have >= needHours ? "planned" : have > 0 ? "partly" : "none",
      have: Math.min(have, needHours),
      need: needHours,
      unit: "hours",
    };
  }

  const COVERAGE_TEXT = {
    planned: () => "✓ In your plan",
    partly: (c) => `Partly planned: ${c.have} of ${c.need} ${c.unit}`,
    none: () => "Not planned yet",
  };

  /** A small label saying how far the plan goes toward a part. */
  function coverageBadge(cover) {
    return element("span", { className: `audit-cover ${cover.state}`, textContent: COVERAGE_TEXT[cover.state](cover) });
  }

  /** The best option of a "pick one" choice: the one the plan gets furthest with. */
  function closestPart(group, facts) {
    const score = (part) => {
      const cover = coverage(part, facts);
      return cover.state === "planned" ? 2 : cover.have / Math.max(cover.need, 1);
    };
    return group.reduce((best, part) => (score(part) > score(best) ? part : best), group[0]);
  }

  /**
   * What the plan already holds for a Gen Ed part: planned courses that count for it ("CS 211,
   * Spring 2028"), and open slots, in semester order. "" when there are none.
   */
  function planNote(part) {
    const when = (term) => (term ? termLabel(term) : "no semester yet");
    const byTerm = (a, b) => Math.min(termOrder(a.term), 1e9) - Math.min(termOrder(b.term), 1e9);
    const planned = requirementCourses(rows, part)
      .map(([id]) => ({ id, term: myCourses.term(id) }))
      .filter(({ id }) => myCourses.status(id) === "planned")
      .sort(byTerm);
    const kind = slotKindFor(part.title);
    const open = kind
      ? myCourses
          .slots()
          .filter((slot) => [slot.kind, ...slot.also].includes(kind))
          .sort(byTerm)
      : [];
    if (planned.length === 0 && open.length === 0) return "";
    const pieces = [];
    if (planned.length > 0) {
      pieces.push(
        "Planned and counts for this: ",
        ...planned.flatMap(({ id, term }, i) => [
          i > 0 ? ", " : "",
          element("a", { href: courseHash(id), textContent: id }),
          ` (${when(term)})`,
        ]),
        ". ",
      );
    }
    if (open.length > 0) {
      // A shared slot is named with both Gen Eds: "Humanities & the Arts + Western/Comparative Cultures".
      const list = open.map((slot) => `${slotTitle(slot)}, ${when(slot.term)}`).join("; ");
      pieces.push(
        `Your plan has ${open.length === 1 ? "an open slot" : `${open.length} open slots`} for this (${list}). `,
        element("a", { href: "#plan", textContent: "Pick courses on My plan →" }),
      );
    }
    return element("p", { className: "audit-hint audit-plan-note" }, ...pieces);
  }

  const needsText = (needs) => (needs ? `Still needs ${describeNeeds(needs)}` : "Still needs one of these");

  /** "Pick 1 of 2 courses" for a part with a short list, else "Still needs 1 course". */
  function partNeedsText(part) {
    const listed = part.selectFrom.filter((pattern) => pattern.subject !== "*" && pattern.number.length === 3).length;
    const count = part.needs?.courses ?? (part.needs ? 0 : 1);
    if (count > 0 && !part.needs?.hours && listed > count && listed <= 6 && listed === part.selectFrom.length) {
      return `Pick ${count} of these ${listed}`;
    }
    return needsText(part.needs);
  }

  /** One unmet part, or a choice between parts ("pick one focus area"). */
  function groupItem(group, graph, taken, facts, anchor) {
    if (group.length === 1) {
      const [part] = group;
      return element(
        "li",
        { className: "audit-item", id: anchor },
        element(
          "div",
          { className: "audit-item-head" },
          element("h4", { textContent: titleCase(part.title) }),
          element("span", { className: "audit-needs", textContent: partNeedsText(part) }),
          coverageBadge(coverage(part, facts)),
        ),
        ...options(part, graph, taken, facts),
      );
    }
    const closest = closestPart(group, facts);
    return element(
      "li",
      { className: "audit-item", id: anchor },
      element(
        "div",
        { className: "audit-item-head" },
        element("h4", { textContent: `Pick one of ${group.length}` }),
        element("span", { className: "audit-needs", textContent: "Meet any one of these" }),
        coverageBadge(coverage(closest, facts)),
      ),
      element("p", {
        className: "audit-hint",
        textContent: `Only one of these ${group.length} is needed. The one your plan is closest to is open; open another to compare.`,
      }),
      ...group.map((part) => {
        const cover = coverage(part, facts);
        return element(
          "details",
          { className: `audit-choice${part === closest ? " closest" : ""}`, open: part === closest },
          element(
            "summary",
            {},
            element("span", { className: "audit-choice-title", textContent: titleCase(part.title) }),
            part === closest ? element("span", { className: "audit-closest", textContent: "closest" }) : "",
            element("span", { className: "audit-needs", textContent: describeNeeds(part.needs) }),
            coverageBadge(cover),
          ),
          ...options(part, graph, taken, facts),
        );
      }),
    );
  }

  /** One requirement section: its unfinished parts, with the finished ones folded away. */
  function sectionCard(requirement, graph, taken, facts, anchorFor) {
    const open = partGroups(requirement).filter((group) => !group.some(partIsMet));
    const done = requirement.parts.filter(partIsMet).map((part) => titleCase(part.title));
    return element(
      "section",
      { className: "audit-section" },
      element(
        "div",
        { className: "audit-section-head" },
        element("h3", { textContent: titleCase(requirement.title) }),
        requirement.needs
          ? element("span", { className: "audit-needs", textContent: needsText(requirement.needs) })
          : "",
      ),
      done.length > 0
        ? element(
            "details",
            { className: "audit-done-parts" },
            element("summary", { textContent: `✓ ${done.length} part${done.length === 1 ? "" : "s"} done` }),
            element("p", { textContent: done.join(" · ") }),
          )
        : "",
      open.length > 0
        ? element(
            "ul",
            { className: "audit-items" },
            ...open.map((group) => groupItem(group, graph, taken, facts, anchorFor(group))),
          )
        : "",
    );
  }

  /**
   * "What's left": one line per unfinished requirement, what it needs, and whether the plan
   * covers it yet. A line scrolls to its requirement below.
   */
  function overview(open, facts, anchorFor) {
    const rowsLeft = [];
    for (const requirement of open) {
      const groups = partGroups(requirement).filter((group) => !group.some(partIsMet));
      if (groups.length === 0) {
        const needHours = requirement.needs?.hours;
        rowsLeft.push({
          title: titleCase(requirement.title),
          needs: needsText(requirement.needs),
          cover: needHours ? hoursCoverage(requirement.title, needHours, facts) : null,
        });
      }
      for (const group of groups) {
        const part = group.length === 1 ? group[0] : closestPart(group, facts);
        rowsLeft.push({
          title:
            group.length === 1 ? titleCase(part.title) : `${titleCase(requirement.title)}: pick one of ${group.length}`,
          needs: group.length === 1 ? partNeedsText(part) : `Closest: ${titleCase(part.title)}`,
          cover: coverage(part, facts),
          anchor: anchorFor(group),
        });
      }
    }
    const inPlan = rowsLeft.filter((row) => row.cover?.state === "planned").length;
    return element(
      "section",
      { className: "audit-overview" },
      element(
        "div",
        { className: "audit-overview-head" },
        element("h3", { textContent: "What's left" }),
        element("span", {
          className: "audit-overview-count",
          textContent: `${rowsLeft.length} to go · ${inPlan} already in your plan · ${rowsLeft.length - inPlan} not yet`,
        }),
      ),
      element(
        "ul",
        { className: "audit-overview-list" },
        ...rowsLeft.map((row) =>
          element(
            "li",
            {},
            element(
              "button",
              {
                type: "button",
                className: "audit-overview-row",
                onclick: () =>
                  document.getElementById(row.anchor)?.scrollIntoView({ behavior: "smooth", block: "start" }),
                disabled: !row.anchor,
              },
              element("span", { className: "audit-overview-title", textContent: row.title }),
              element("span", { className: "audit-overview-needs", textContent: row.needs }),
              row.cover ? coverageBadge(row.cover) : "",
            ),
          ),
        ),
      ),
    );
  }

  function uploadBox() {
    const input = element("input", {
      type: "file",
      accept: "application/pdf,.pdf",
      className: "audit-file",
      id: "audit-file",
    });
    input.addEventListener("change", () => input.files[0] && readFile(input.files[0]));
    const box = element(
      "label",
      { className: "audit-drop", htmlFor: "audit-file" },
      input,
      element("span", {
        className: "audit-drop-title",
        textContent: audit ? "Upload a newer audit" : "Choose your audit PDF",
      }),
      element("span", { className: "audit-drop-hint", textContent: "or drop it here" }),
    );
    box.addEventListener("dragover", (event) => {
      event.preventDefault();
      box.classList.add("dragging");
    });
    box.addEventListener("dragleave", () => box.classList.remove("dragging"));
    box.addEventListener("drop", (event) => {
      event.preventDefault();
      box.classList.remove("dragging");
      const file = event.dataTransfer.files[0];
      if (file) readFile(file);
    });
    return box;
  }

  function howTo() {
    return element(
      "ol",
      { className: "audit-steps" },
      element(
        "li",
        {},
        "Open the ",
        element("a", {
          href: DEGREE_AUDIT_HELP,
          target: "_blank",
          rel: "noopener",
          textContent: "Degree Audit system",
        }),
        " and sign in with your NetID.",
      ),
      element("li", { textContent: "Run an audit for your program and open its Audit Results." }),
      element("li", { textContent: "Print it and choose “Save as PDF”, then upload that file here." }),
    );
  }

  async function readFile(file) {
    if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") {
      message = "That isn't a PDF. Save the audit with Print → Save as PDF, then upload it.";
      draw();
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      message = "That file is over 10 MB, too big to be an audit.";
      draw();
      return;
    }
    message = "Reading your audit…";
    draw();
    try {
      const parsed = readAudit(await pdfLines(file));
      if (requirementSections(parsed).length === 0) {
        message = "This PDF doesn't look like a uAchieve degree audit. Upload the Audit Results page saved as a PDF.";
        draw();
        return;
      }
      const takenIds = takenCourseIds(parsed);
      const { programName, program, catalogYear, preparedOn } = parsed;
      audit = { programName, program, catalogYear, preparedOn, sections: requirementSections(parsed), takenIds };
      save(audit);
      const details = takenCourseDetails(parsed);
      // A new audit starts a fresh plan: the old plan was made for the old audit.
      myCourses.startOver(takenIds.map((id) => ({ id, status: "taken", ...details[id] })));
      message = `Read your audit. My plan starts fresh with your ${takenIds.length} course${takenIds.length === 1 ? "" : "s"} from it.`;
    } catch (error) {
      console.error(error);
      message = "Couldn't read that PDF (or couldn't load the PDF reader; check your internet connection).";
    }
    draw();
  }

  function clearAll() {
    if (!clearEverything()) return;
    audit = null;
    message = "Cleared: your audit and your plan were removed from this browser.";
    draw();
  }

  function draw() {
    const intro = element(
      "header",
      { className: "audit-header" },
      element("h2", { textContent: "Degree audit" }),
      element("p", {
        className: "audit-lead",
        textContent:
          "Upload your uAchieve audit to see what's left for your degree and which of those courses you can take now.",
      }),
      element("p", {
        className: "audit-privacy",
        textContent:
          "🔒 Your PDF is read in this browser and never uploaded. Only the requirements and course codes are kept here, not your name or ID. Unofficial: your advisor and the official audit have the final word.",
      }),
    );
    const upload = element(
      "div",
      { className: "audit-upload" },
      audit ? "" : howTo(),
      uploadBox(),
      message ? element("p", { className: "audit-message", role: "status", textContent: message }) : "",
    );
    // With an audit, uploading a newer one is folded away (open when there's news about it).
    const uploadArea = audit
      ? element(
          "details",
          { className: "audit-upload-fold", open: Boolean(message) && !/^Read your audit/.test(message) },
          element("summary", { textContent: "Upload a newer audit" }),
          upload,
        )
      : upload;
    if (!audit) {
      section.replaceChildren(intro, uploadArea);
      return;
    }

    const graph = getGraph();
    const facts = courseFacts(rows);
    const taken = new Set([...audit.takenIds, ...myCourses.ids("taken")]);
    // Each unfinished part (or "pick one" choice) gets an id, so the overview can scroll to it.
    const anchors = new Map();
    const anchorFor = (group) => {
      if (!anchors.has(group[0])) anchors.set(group[0], `audit-item-${anchors.size + 1}`);
      return anchors.get(group[0]);
    };
    const open = audit.sections.filter((requirement) => !sectionIsMet(requirement));
    const met = audit.sections.filter(sectionIsMet);
    const program = [audit.programName, audit.program && `(${audit.program})`].filter(Boolean).join(" ");
    const catalog = catalogYearLabel(audit.catalogYear);
    section.replaceChildren(
      intro,
      element(
        "div",
        { className: "audit-summary" },
        element(
          "div",
          {},
          element("strong", { textContent: program || "Your program" }),
          element("span", {
            textContent: [catalog && ` · ${catalog} catalog`, audit.preparedOn && ` · audit from ${audit.preparedOn}`]
              .filter(Boolean)
              .join(""),
          }),
          element("p", {
            textContent: `${met.length} of ${audit.sections.length} requirements done, ${open.length} to go.`,
          }),
        ),
        element(
          "div",
          { className: "audit-summary-actions" },
          element("button", {
            type: "button",
            className: "btn btn-primary",
            textContent: "Make a plan from this audit →",
            onclick: onMakePlan,
          }),
          element("button", {
            type: "button",
            className: "btn btn-ghost",
            textContent: "Clear everything",
            title: "Remove your audit and your plan from this browser",
            onclick: clearAll,
          }),
        ),
      ),
      message && /^Read your audit/.test(message)
        ? element("p", { className: "audit-message", role: "status", textContent: message })
        : "",
      open.length > 0 ? overview(open, facts, anchorFor) : "",
      element(
        "p",
        { className: "audit-legend" },
        element("span", { className: "audit-chip taken", textContent: "✓ taken" }),
        element("span", { className: "audit-chip planned", textContent: "planned" }),
        element("span", { className: "audit-chip ready", textContent: "can take now" }),
        element("span", { className: "audit-chip later", textContent: "needs prerequisites first" }),
      ),
      open.length > 0
        ? element(
            "div",
            { className: "audit-sections" },
            ...open.map((requirement) => sectionCard(requirement, graph, taken, facts, anchorFor)),
          )
        : element("p", { className: "audit-all-done", textContent: "Every requirement on this audit is met. 🎉" }),
      met.length > 0
        ? element(
            "details",
            { className: "audit-met" },
            element("summary", { textContent: `✓ ${met.length} requirement${met.length === 1 ? "" : "s"} done` }),
            element(
              "ul",
              {},
              ...met.map((requirement) => element("li", { textContent: `✓ ${titleCase(requirement.title)}` })),
            ),
          )
        : "",
      uploadArea,
    );
  }

  // Marking a course on another page changes its chip here.
  // Clear everything on My plan removes the audit too: an empty plan means look again. (Otherwise
  // the one in memory stays, so the page still works for this visit when storage is blocked.)
  const syncAudit = () => {
    if (myCourses.ids().length === 0 && myCourses.slots().length === 0) audit = savedAudit();
  };
  myCourses.onChange(() => {
    syncAudit();
    if (!section.hidden) keepFocus(draw);
  });

  return {
    show() {
      section.hidden = false;
      syncAudit();
      draw();
    },
    hide() {
      section.hidden = true;
    },
  };
}
