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
import { slotKind, slotKindFor } from "./plan-insights.js";
import { requirementCourses } from "./requirement-courses.js";
import { termLabel, termOrder } from "./terms.js";

const PDFJS_CDN = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/";
const STORAGE_KEY = "degreeAudit";
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const OPTIONS_SHOWN = 18; // course chips shown per requirement before "show all"
const GEN_ED_OPTIONS = 12;
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

  /** The courses that can meet a part, best first, with the rest behind "show all". */
  function options(part, graph, taken) {
    const genEd = part.selectFrom.length === 0 ? genEdCodesFor(part.title) : [];
    const courses = requirementCourses(rows, part, { genEdLimit: GEN_ED_OPTIONS });
    const anyLevel = part.selectFrom.filter((pattern) => pattern.subject === "*").map(describePattern);
    const ranked = courses.map(([id, title]) => ({ id, title, state: standing(id, graph, taken) }));
    ranked.sort((a, b) => STANDING_ORDER[a.state] - STANDING_ORDER[b.state]);
    const chips = ranked.map(({ id, title, state }) => chip(id, title, state));

    const pieces = [];
    if (genEd.length > 0) {
      pieces.push(planNote(part));
      pieces.push(
        element("p", { className: "audit-hint", textContent: "Gen Ed courses that count, highest average GPA first:" }),
      );
    }
    if (chips.length > 0) {
      pieces.push(element("div", { className: "audit-chips" }, ...chips.slice(0, OPTIONS_SHOWN)));
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
          .filter((slot) => slot.kind === kind)
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
      const slots = `${open.length === 1 ? "an open" : `${open.length} open`} ${slotKind(kind).name} slot${open.length === 1 ? "" : "s"}`;
      pieces.push(
        `Your plan has ${slots} (${open.map((slot) => when(slot.term)).join(", ")}). `,
        element("a", { href: "#plan", textContent: "Pick courses on My plan →" }),
      );
    }
    return element("p", { className: "audit-hint audit-plan-note" }, ...pieces);
  }

  const needsText = (needs) => (needs ? `Still needs ${describeNeeds(needs)}` : "Still needs one of these");

  /** One unmet part, or a choice between parts ("pick one focus area"). */
  function groupItem(group, graph, taken) {
    if (group.length === 1) {
      const [part] = group;
      return element(
        "li",
        { className: "audit-item" },
        element(
          "div",
          { className: "audit-item-head" },
          element("h4", { textContent: titleCase(part.title) }),
          element("span", { className: "audit-needs", textContent: needsText(part.needs) }),
        ),
        ...options(part, graph, taken),
      );
    }
    return element(
      "li",
      { className: "audit-item" },
      element(
        "div",
        { className: "audit-item-head" },
        element("h4", { textContent: `Pick one of ${group.length}` }),
        element("span", { className: "audit-needs", textContent: needsText(group[0].needs) }),
      ),
      element("p", { className: "audit-hint", textContent: "Meet any one of these. Open one to see its courses." }),
      ...group.map((part) =>
        element(
          "details",
          { className: "audit-choice" },
          element(
            "summary",
            {},
            titleCase(part.title),
            element("span", { className: "audit-needs", textContent: describeNeeds(part.needs) }),
          ),
          ...options(part, graph, taken),
        ),
      ),
    );
  }

  function sectionCard(requirement, graph, taken) {
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
      done.length > 0 ? element("p", { className: "audit-done-parts", textContent: `Done: ${done.join(" · ")}` }) : "",
      open.length > 0
        ? element("ul", { className: "audit-items" }, ...open.map((group) => groupItem(group, graph, taken)))
        : "",
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
      const added = takenIds.filter((id) => myCourses.status(id) !== "taken");
      myCourses.setMany(takenIds.map((id) => ({ id, status: "taken", ...details[id] })));
      message =
        added.length > 0
          ? `Read your audit. ${added.length} course${added.length === 1 ? "" : "s"} added to My plan as taken.`
          : "Read your audit. Your taken courses were already in My plan.";
    } catch (error) {
      console.error(error);
      message = "Couldn't read that PDF (or couldn't load the PDF reader; check your internet connection).";
    }
    draw();
  }

  function removeAudit() {
    audit = null;
    save(null);
    message = "Audit removed from this browser. Your courses in My plan were kept.";
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
    if (!audit) {
      section.replaceChildren(intro, upload);
      return;
    }

    const graph = getGraph();
    const taken = new Set([...audit.takenIds, ...myCourses.ids("taken")]);
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
            textContent: "Remove audit",
            onclick: removeAudit,
          }),
        ),
      ),
      upload,
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
            ...open.map((requirement) => sectionCard(requirement, graph, taken)),
          )
        : element("p", { className: "audit-all-done", textContent: "Every requirement on this audit is met. 🎉" }),
      met.length > 0
        ? element(
            "section",
            { className: "audit-met" },
            element("h3", { textContent: "Done" }),
            element(
              "ul",
              {},
              ...met.map((requirement) => element("li", { textContent: `✓ ${titleCase(requirement.title)}` })),
            ),
          )
        : "",
    );
  }

  // Marking a course on another page changes its chip here.
  myCourses.onChange(() => {
    if (!section.hidden) keepFocus(draw);
  });

  return {
    show() {
      section.hidden = false;
      draw();
    },
    hide() {
      section.hidden = true;
    },
  };
}
