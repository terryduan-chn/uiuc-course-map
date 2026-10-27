// The #plan page: your courses semester by semester, Gen Ed slots, Auto-plan, and what you
// can take next. Each course's own controls (← → ⋯, badges) come from plan-controls.js.

import { savedAudit } from "./audit-view.js";
import { buildAutoPlan, TARGET_HOURS } from "./auto-plan.js";
import { missingRequirements, readyNext } from "./graph-data.js";
import { focusKey, keepFocus, myCourses } from "./my-courses.js";
import { issueBadges, moveButton, nextTerm, planControls, planCourses, termChoices } from "./plan-controls.js";
import {
  courseIssues,
  degreeProgress,
  GEN_ED_SLOTS,
  seasonsText,
  semesterLoad,
  SLOT_HOURS,
  slotKind,
  slotNames,
  slotOptions,
  slotPart,
} from "./plan-insights.js";
import { courseFacts, requirementCourses } from "./requirement-courses.js";
import { creditHours, parseCourseCode, requirementLabel } from "./search.js";
import { currentTerm, doneBefore, nextMainTerm, planSemesters, termLabel, termOrder } from "./terms.js";

/** The Fall or Spring the plan starts from by default: this one, or the next after a summer. */
const currentMainTerm = () => (/^(FA|SP)/.test(currentTerm()) ? currentTerm() : nextMainTerm(currentTerm()));

const READY_SHOWN = 24;
const UNLOCKS_SHOWN = 6;
const NO_TERM = "none"; // the semester card for courses without a term yet
const DRAG_TYPE = "text/course-id"; // a course id, or a Gen Ed slot's id ("slot-3")
const SLOT_CANDIDATES = 300; // Gen Ed courses looked at when picking one for a slot

/**
 * @param {{ rows: Function, element: Function, getGraph: () => object }} helpers
 */
export function createPlanView({ rows, element, getGraph }) {
  const section = document.getElementById("plan-view");
  const expanded = new Set(); // course cards opened to show details, kept across redraws
  const [offeredSince] = rows("SELECT value FROM meta WHERE key = 'oldest_term_searched'").map((row) => {
    const [year, season] = row.value.split("/");
    return `${season[0].toUpperCase()}${season.slice(1)} ${year}`;
  });

  function courseInfo(ids) {
    if (ids.length === 0) return new Map();
    const found = rows(
      `SELECT courses.subject || ' ' || courses.number AS id, title, credit_hours, average_gpa
       FROM courses LEFT JOIN course_grades USING (subject, number)
       WHERE courses.subject || ' ' || courses.number IN (${ids.map(() => "?").join(", ")})`,
      ids,
    );
    return new Map(found.map((course) => [course.id, course]));
  }

  const courseHash = (id) => `#${id.replace(" ", "-")}`;
  // The hours your audit credited a course with, else the catalog's.
  const hoursOf = (id, info) => myCourses.hours(id) ?? creditHours(info.get(id)?.credit_hours);
  const hoursText = (hours) => `${hours} ${hours === 1 ? "hour" : "hours"}`;

  function actionButton(text, onclick, className = "") {
    return element("button", { type: "button", className: `plan-action ${className}`, textContent: text, onclick });
  }

  /** A course card that can be dragged onto a semester. */
  function draggableCard(id, props, ...children) {
    const card = element("li", { ...props, draggable: true }, ...children);
    card.addEventListener("dragstart", (event) => {
      event.dataTransfer.setData(DRAG_TYPE, id);
      event.dataTransfer.effectAllowed = "move";
      card.classList.add("dragging");
      section.classList.add("drag-active");
    });
    card.addEventListener("dragend", () => {
      card.classList.remove("dragging");
      section.classList.remove("drag-active");
    });
    return card;
  }

  /** Dropping a course on a semester moves it there (a ready course is planned there). */
  function acceptDrops(target, term) {
    target.addEventListener("dragover", (event) => {
      if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      target.classList.add("drop-here");
    });
    target.addEventListener("dragleave", (event) => {
      if (!target.contains(event.relatedTarget)) target.classList.remove("drop-here");
    });
    target.addEventListener("drop", (event) => {
      event.preventDefault();
      target.classList.remove("drop-here");
      section.classList.remove("drag-active");
      const id = event.dataTransfer.getData(DRAG_TYPE);
      const newTerm = term === NO_TERM ? null : term;
      if (id.startsWith("slot-")) myCourses.setSlotTerm(id, newTerm);
      else if (myCourses.status(id)) myCourses.setTerm(id, newTerm);
      else myCourses.set(id, "planned", newTerm);
    });
  }

  /** What a card shows when opened: GPA, seasons, prerequisites met or not, what it unlocks. */
  function courseDetails(id, term, info, graph, facts, courses) {
    const node = graph.byId.get(id);
    const fact = facts.get(id);
    const before = term
      ? doneBefore(courses, term)
      : new Set(courses.filter((course) => course.id !== id).map((course) => course.id));
    const groups = node?.requirements ?? [];
    return element(
      "div",
      { className: "plan-details" },
      element(
        "dl",
        { className: "plan-facts" },
        element("dt", { textContent: "Average GPA" }),
        element("dd", { textContent: info?.average_gpa ? info.average_gpa.toFixed(2) : "no grade data" }),
        element("dt", { textContent: "Runs" }),
        element("dd", { textContent: fact?.offered ? seasonsText(fact.seasons) : `not since ${offeredSince}` }),
      ),
      element("p", {
        className: "plan-details-label",
        textContent: groups.length === 0 ? "No prerequisites" : "Prerequisites",
      }),
      groups.length === 0
        ? ""
        : element(
            "ul",
            { className: "plan-prereqs" },
            ...groups.map((group) => {
              const have = group.ids.filter((prerequisite) => before.has(prerequisite)).length;
              const met = have >= group.required;
              return element(
                "li",
                { className: met ? "met" : "unmet" },
                element("span", {
                  className: "plan-prereq-mark",
                  textContent: met ? "✓" : "✗",
                  ariaLabel: met ? "met" : "not met",
                }),
                group.ids.length > 1 ? `${requirementLabel(group.required, group.ids.length)}: ` : "",
                ...group.ids.flatMap((prerequisite, i) => [
                  i > 0 ? ", " : "",
                  element("a", {
                    href: courseHash(prerequisite),
                    textContent: prerequisite,
                    className: before.has(prerequisite) ? "done" : "",
                  }),
                ]),
              );
            }),
          ),
      node?.dependents.length
        ? element(
            "p",
            { className: "plan-unlocks" },
            `Unlocks ${node.dependents.length}: `,
            ...node.dependents
              .slice(0, UNLOCKS_SHOWN)
              .flatMap((dependent, i) => [
                i > 0 ? ", " : "",
                element("a", { href: courseHash(dependent), textContent: dependent }),
              ]),
            node.dependents.length > UNLOCKS_SHOWN ? "…" : "",
          )
        : "",
      element("a", { href: courseHash(id), className: "plan-details-link", textContent: "Open course page →" }),
    );
  }

  /** One course in a semester: the course, its problems, ← → and ⋯; click to open details. */
  function courseCard(course, info, graph, facts, courses, issues) {
    const { id, status } = course;
    const hours = myCourses.hours(id) ?? (info ? creditHours(info.credit_hours) : null);
    const open = expanded.has(id);
    const head = focusKey(
      element(
        "button",
        {
          type: "button",
          className: "plan-course-head",
          title: open ? "Hide details" : "Show details",
          onclick: () => {
            if (expanded.has(id)) expanded.delete(id);
            else expanded.add(id);
            keepFocus(draw);
          },
        },
        element("span", { className: "code", textContent: id }),
        element("span", { className: "title", textContent: info?.title ?? "Not in the app's data" }),
        element("span", { className: "plan-chevron", ariaHidden: "true", textContent: open ? "▴" : "▾" }),
      ),
      `head-${id}`,
    );
    head.setAttribute("aria-expanded", String(open));
    // One line about it: taken or in progress, auto, hours, and why it's in the plan.
    const fills = myCourses.fills(id);
    const why = fills.length > 0 ? `Fills ${slotNames(fills)}` : myCourses.reason(id);
    const meta = element(
      "p",
      { className: "plan-meta" },
      status === "taken"
        ? myCourses.kind(id) === "registered"
          ? element("span", { className: "plan-status registered", textContent: "In progress" })
          : element("span", { className: "plan-status taken", textContent: "Taken" })
        : "",
      myCourses.isAuto(id)
        ? element("span", { className: "plan-auto", textContent: "auto", title: "Added by Auto-plan" })
        : "",
      hours === null ? "" : element("span", { className: "plan-hours", textContent: `${hours} hr` }),
      why ? element("span", { className: "plan-reason", textContent: `· ${why}`, title: why }) : "",
    );
    const controls = planControls({ element, rows, graph, id });
    return draggableCard(
      id,
      { className: `plan-course ${status}${myCourses.isAuto(id) ? " auto" : ""}${issues.length ? " has-issues" : ""}` },
      head,
      // A taken course has only ⋯, so it shares the line with its status and hours.
      status === "taken" ? element("div", { className: "plan-course-foot" }, meta, controls) : meta,
      issueBadges(element, issues),
      open ? courseDetails(id, course.term, info, graph, facts, courses) : "",
      status === "taken" ? "" : controls,
    );
  }

  /** A Gen Ed slot: a "pick a course" placeholder with ← →, a list of courses to pick, and ✕. */
  function slotCard(slot, graph, facts, courses, slots) {
    const kind = slotKind(slot.kind);
    const arrow = (direction) =>
      moveButton({
        element,
        direction,
        term: slot.term,
        what: `the ${kind.name} slot`,
        key: slot.id,
        move: (target) => myCourses.setSlotTerm(slot.id, target),
      });
    const picks = element("div", { className: "plan-slot-picks" });
    const picker = element(
      "details",
      { className: "plan-menu plan-slot-picker" },
      focusKey(
        element("summary", {
          className: "plan-action plan-slot-pick",
          textContent: "Pick a course",
          ariaLabel: `Pick a course for the ${kind.name} slot`,
        }),
        `pick-${slot.id}`,
      ),
      element("div", { className: "plan-menu-panel" }, picks),
    );
    // The course list is looked up only when it opens (it searches every course with the Gen Ed).
    picker.addEventListener("toggle", () => {
      if (!picker.open || picks.childElementCount > 0) return;
      const candidates = requirementCourses(rows, slotPart(kind), { genEdLimit: SLOT_CANDIDATES }).map(([id]) => id);
      const options = slotOptions({ slot, candidates, courses, slots, graph, facts });
      if (options.length === 0) {
        picks.append(element("p", { className: "plan-menu-label", textContent: "No recently offered courses found." }));
        return;
      }
      const info = courseInfo(options.map((option) => option.id));
      const alsoText = (option) =>
        option.covers.length === 0
          ? ""
          : `also ${option.covers.map((id) => slotKind(slots.find((other) => other.id === id).kind).name).join(", ")}`;
      picks.append(
        element("p", {
          className: "plan-menu-label",
          textContent: "Best first: fits this semester, fills another slot too, then higher GPA.",
        }),
        ...options.map((option) =>
          element(
            "button",
            {
              type: "button",
              className: `plan-menu-item plan-slot-option ${option.ready ? "ready" : ""}`,
              onclick: () => myCourses.fillSlot(slot.id, option.id, option.covers),
            },
            element("strong", { textContent: option.id }),
            element("span", { className: "plan-slot-option-title", textContent: info.get(option.id)?.title ?? "" }),
            element("span", {
              className: "plan-slot-option-meta",
              textContent: [
                option.gpa ? `${option.gpa.toFixed(2)} GPA` : "no grade data",
                alsoText(option),
                option.ready ? "" : "needs prerequisites or another season",
              ]
                .filter(Boolean)
                .join(" · "),
            }),
          ),
        ),
      );
    });
    return draggableCard(
      slot.id,
      { className: `plan-course plan-slot${slot.auto ? " auto" : ""}` },
      element(
        "p",
        { className: "plan-slot-head" },
        element("span", { className: "code", textContent: "Gen Ed" }),
        element("span", { className: "title", textContent: kind.name }),
      ),
      element(
        "p",
        { className: "plan-meta" },
        slot.auto ? element("span", { className: "plan-auto", textContent: "auto", title: "Added by Auto-plan" }) : "",
        element("span", { className: "plan-hours", textContent: `${SLOT_HOURS} hr` }),
        element("span", { className: "plan-reason", textContent: "· pick a course later" }),
      ),
      element(
        "div",
        { className: "plan-course-actions" },
        arrow(-1),
        arrow(1),
        element("span", { className: "plan-actions-gap" }),
        picker,
        focusKey(
          element("button", {
            type: "button",
            className: "plan-action",
            textContent: "✕",
            title: "Remove this slot",
            ariaLabel: `Remove the ${kind.name} slot`,
            onclick: () => myCourses.removeSlot(slot.id),
          }),
          `remove-${slot.id}`,
        ),
      ),
    );
  }

  /** The box for adding a course by its code, to a chosen term. */
  function addForm() {
    const input = element("input", {
      type: "search",
      className: "plan-add-input",
      placeholder: "Add a course, e.g. CS 225",
      autocomplete: "off",
      ariaLabel: "Course code to add",
    });
    const term = element(
      "select",
      { className: "term-menu", ariaLabel: "Semester for the course you add" },
      element("option", { value: "", textContent: "No term" }),
      ...termChoices([]).map((value) =>
        element("option", { value, textContent: termLabel(value), selected: value === nextTerm() }),
      ),
    );
    const message = element("p", { className: "plan-add-message", role: "status" });
    // "planned" or "taken" in the chosen semester, or "in progress": taking it this semester.
    const add = (status) => {
      const code = parseCourseCode(input.value);
      if (!code) {
        message.textContent = "Type a course code, like CS 225.";
        return;
      }
      const id = `${code.subject} ${code.number}`;
      if (courseInfo([id]).size === 0) {
        message.textContent = `${id} isn't in the course data. Check the code.`;
        return;
      }
      // Each redraws the page, with the box empty again.
      if (status === "in progress") myCourses.setInProgress(id);
      else myCourses.set(id, status, term.value || null);
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") add("planned");
    });
    return element(
      "div",
      { className: "plan-add" },
      input,
      term,
      element("button", {
        type: "button",
        className: "btn btn-primary",
        textContent: "Add as planned",
        onclick: () => add("planned"),
      }),
      element("button", {
        type: "button",
        className: "btn btn-ghost",
        textContent: "Add as in progress",
        title: `You're taking it now, in ${termLabel(currentTerm())}`,
        onclick: () => add("in progress"),
      }),
      element("button", {
        type: "button",
        className: "btn btn-ghost",
        textContent: "Add as taken",
        onclick: () => add("taken"),
      }),
      message,
      slotRow(term),
    );
  }

  /** "Or save a place for a Gen Ed": adds a slot of the chosen kind to the add box's semester. */
  function slotRow(term) {
    const kind = element(
      "select",
      { className: "term-menu plan-slot-kind", ariaLabel: "Gen Ed slot to add" },
      ...GEN_ED_SLOTS.map((slot) => element("option", { value: slot.key, textContent: slot.name })),
    );
    return element(
      "div",
      { className: "plan-add-slot" },
      element("span", { className: "plan-add-slot-label", textContent: "Or save a place for a Gen Ed:" }),
      kind,
      focusKey(
        element("button", {
          type: "button",
          className: "btn btn-ghost",
          textContent: "Add Gen Ed slot",
          onclick: () => myCourses.addSlot(kind.value, term.value || null),
        }),
        "add-slot",
      ),
    );
  }

  let lastResult = null; // what the latest Auto-plan did, shown until the page is left

  /** Fills the plan from the saved audit (see auto-plan.js). Returns false without an audit. */
  function generate() {
    const audit = savedAudit();
    if (!audit) return false;
    const lists = new Map();
    const candidates = (part) => {
      const key = JSON.stringify([part.title, part.selectFrom, part.notFrom]);
      if (!lists.has(key))
        lists.set(
          key,
          requirementCourses(rows, part).map(([id]) => id),
        );
      return lists.get(key);
    };
    const result = buildAutoPlan({
      sections: audit.sections,
      candidates,
      facts: courseFacts(rows),
      graph: getGraph(),
      taken: new Set(myCourses.ids("taken")),
      planned: myCourses
        .ids("planned")
        .filter((id) => !myCourses.isAuto(id))
        .map((id) => ({ id, term: myCourses.term(id) })),
      startTerm: nextTerm(),
      genEdSlots: true,
      slots: myCourses.slots().filter((slot) => !slot.auto),
    });
    lastResult = { ...result, program: audit.programName };
    myCourses.replaceAuto(result.courses, result.scheduled, result.slots);
    return true;
  }

  /** The Auto-plan box: fill the rest of the degree from the audit, or clear what it added. */
  function autoPanel() {
    const audit = savedAudit();
    const generated =
      myCourses.ids("planned").filter((id) => myCourses.isAuto(id)).length +
      myCourses.slots().filter((slot) => slot.auto).length;
    if (!audit) {
      return element(
        "div",
        { className: "plan-auto-panel" },
        element("h3", { textContent: "Auto-plan" }),
        element("p", {
          textContent:
            "Upload your degree audit and the plan fills itself with courses for every requirement you still need.",
        }),
        element("a", { href: "#audit", className: "btn btn-ghost", textContent: "Go to Audit →" }),
      );
    }
    return element(
      "div",
      { className: "plan-auto-panel" },
      element(
        "h3",
        {},
        "Auto-plan",
        element("span", {
          className: "plan-auto-source",
          textContent: ` from your ${audit.programName ?? "degree"} audit`,
        }),
      ),
      element("p", {
        textContent: `Fills ${termLabel(nextTerm())} onward with courses for every unmet requirement, about ${TARGET_HOURS} hours a semester. Gen Eds become slots you pick a course for. Your own planned courses stay.`,
      }),
      element(
        "div",
        { className: "plan-auto-actions" },
        focusKey(
          element("button", {
            type: "button",
            className: "btn btn-primary",
            textContent: generated ? "Re-plan" : "Auto-plan my degree",
            onclick: generate,
          }),
          "auto-plan",
        ),
        generated
          ? focusKey(
              element("button", {
                type: "button",
                className: "btn btn-ghost",
                textContent: `Clear generated (${generated})`,
                onclick: () => {
                  lastResult = null;
                  myCourses.clearAuto();
                },
              }),
              "auto-plan",
            )
          : "",
      ),
    );
  }

  /**
   * Courses marked taken this semester, saved before the app knew "in progress": none says how it
   * was earned. From an audit, ask for it again (it tells in-progress courses and AP credit
   * apart); marked by hand, they're the courses being taken now, so offer to mark them so.
   */
  function oldSaveNote(courses) {
    const taken = courses.filter((course) => course.status === "taken");
    const now = taken.filter((course) => course.term === currentTerm());
    if (now.length === 0 || taken.some((course) => course.kind)) return "";
    if (savedAudit()) {
      return element(
        "p",
        { className: "plan-result plan-old-save", role: "status" },
        "Upload your audit again so this semester's courses show as in progress and AP or transfer credit gets its own card. ",
        element("a", { href: "#audit", textContent: "Go to Audit →" }),
      );
    }
    return element(
      "p",
      { className: "plan-result plan-old-save", role: "status" },
      `${now.length} course${now.length === 1 ? " is" : "s are"} marked taken in ${termLabel(currentTerm())}. Taking ${now.length === 1 ? "it" : "them"} now? `,
      focusKey(
        element("button", {
          type: "button",
          className: "btn btn-primary",
          textContent: "Mark them in progress",
          onclick: () => now.forEach((course) => myCourses.setInProgress(course.id)),
        }),
        "mark-in-progress",
      ),
    );
  }

  /** What the latest Auto-plan added, and what it left for the student to pick. */
  function resultNote() {
    if (!lastResult) return "";
    const terms = new Set([...lastResult.courses, ...lastResult.slots].map((item) => item.term));
    const slotCount = lastResult.slots.length;
    const added = [
      lastResult.courses.length ? `${lastResult.courses.length} courses` : "",
      slotCount ? `${slotCount} Gen Ed slot${slotCount === 1 ? "" : "s"}` : "",
    ]
      .filter(Boolean)
      .join(" and ");
    return element(
      "section",
      { className: "plan-result", role: "status" },
      element("p", {
        className: "plan-result-lead",
        textContent: !added
          ? "Nothing to add: your plan already covers every requirement it can fill."
          : `Added ${added} over ${terms.size} semesters (marked “auto”). Open ⋯ on a course to swap it${slotCount ? "; press Pick a course on a slot to choose one" : ""}.`,
      }),
      lastResult.open.length > 0
        ? element(
            "div",
            {},
            element("p", { className: "plan-result-sub", textContent: "Still for you to pick:" }),
            element(
              "ul",
              {},
              ...lastResult.open.map((item) =>
                element("li", {}, element("strong", { textContent: `${item.title}: ` }), item.text),
              ),
            ),
          )
        : "",
      element("p", {
        className: "plan-result-note",
        textContent: "Unofficial: check the plan with your advisor and the official audit.",
      }),
    );
  }

  /** The degree at a glance: hours earned / planned / short, requirements, last semester. */
  function progressBar(courses, info, slots) {
    const audit = savedAudit();
    const progress = degreeProgress({
      courses: [...courses, ...slots.map((slot) => ({ id: slot.id, status: "planned", term: slot.term }))],
      hoursOf: (id) => (id.startsWith("slot-") ? SLOT_HOURS : hoursOf(id, info)),
      audit,
    });
    const percent = (hours) => `${Math.min(100, (hours / progress.total) * 100).toFixed(1)}%`;
    const shown = Math.min(progress.planned, Math.max(0, progress.total - progress.earned));
    const when = progress.lastTerm ? termLabel(progress.lastTerm) : null;
    const finish =
      progress.short > 0
        ? `${hoursText(progress.short)} still to plan`
        : when
          ? `On track to finish in ${when}`
          : "Every hour is covered";
    const bar = element(
      "div",
      {
        className: "plan-progress-bar",
        role: "img",
        ariaLabel: `${progress.earned} hours earned, ${progress.planned} planned, ${progress.short} still to plan, of ${progress.total}`,
      },
      element("span", { className: "earned", style: `width: ${percent(progress.earned)}` }),
      element("span", { className: "planned", style: `width: ${percent(shown)}` }),
    );
    return element(
      "section",
      { className: "plan-progress" },
      element(
        "div",
        { className: "plan-progress-numbers" },
        element("span", {}, element("strong", { textContent: progress.earned }), " earned"),
        element("span", {}, element("strong", { textContent: progress.planned }), " planned"),
        element(
          "span",
          { className: progress.short > 0 ? "short" : "done" },
          element("strong", { textContent: progress.short }),
          " still to plan",
        ),
        element("span", { className: "plan-progress-total", textContent: `of ${progress.total} hours` }),
      ),
      bar,
      element(
        "p",
        { className: "plan-progress-note" },
        progress.requirements
          ? `Requirements on your audit: ${progress.requirements.done} of ${progress.requirements.all} done · `
          : "No audit yet, so 120 hours (most UIUC degrees need 120–128) · ",
        element("strong", { textContent: finish }),
        progress.short > 0 && when ? ` · last planned semester ${when}` : "",
      ),
    );
  }

  /** One line on how the page works, with the colors. */
  function helpLine() {
    return element(
      "p",
      { className: "plan-help" },
      "Press + Plan on any course, drag cards between semesters or use ← →, click a card for details, ⋯ for more. ",
      element("span", { className: "plan-key taken", textContent: "taken" }),
      element("span", { className: "plan-key planned", textContent: "planned" }),
      element("span", { className: "plan-key auto", textContent: "auto-planned" }),
      element("span", { className: "plan-key slot", textContent: "Gen Ed slot" }),
      element("span", { className: "plan-key problem", textContent: "problem" }),
    );
  }

  /** Taken courses rarely need buttons: compact chips, with the full cards behind "Edit". */
  function takenChips(takenCourses, info, graph, facts, everything) {
    return takenCourses.length === 0
      ? ""
      : element(
          "div",
          { className: "plan-taken" },
          element(
            "ul",
            { className: "plan-taken-chips" },
            ...takenCourses.map((course) =>
              element(
                "li",
                {},
                element("a", {
                  href: courseHash(course.id),
                  className: "plan-taken-chip",
                  textContent: course.id,
                  title: `${course.id}: ${info.get(course.id)?.title ?? ""} (${hoursOf(course.id, info)} hr)`,
                }),
              ),
            ),
          ),
          element(
            "details",
            { className: "plan-taken-edit" },
            element("summary", {
              textContent: `Edit ${takenCourses.length} taken course${takenCourses.length === 1 ? "" : "s"}`,
            }),
            element(
              "ul",
              { className: "plan-list" },
              ...takenCourses.map((course) => courseCard(course, info.get(course.id), graph, facts, everything, [])),
            ),
          ),
        );
  }

  /** AP, proficiency and transfer credit: its own card, so no semester's load counts it. */
  function creditCard(credit, info, graph, facts, everything) {
    const hours = credit.reduce((sum, course) => sum + hoursOf(course.id, info), 0);
    return element(
      "section",
      { className: "plan-semester credit" },
      element(
        "h3",
        {},
        "Credit before UIUC",
        element("span", { className: "plan-load normal", textContent: `${hours} hr` }),
      ),
      element("p", {
        className: "plan-credit-note",
        textContent: "AP, proficiency and transfer credit: it counts toward your degree, not toward a semester.",
      }),
      takenChips(credit, info, graph, facts, everything),
    );
  }

  function semesterCard(term, courses, slots, info, graph, facts, everything, allSlots) {
    const now = currentTerm();
    const hours = courses.reduce((sum, course) => sum + hoursOf(course.id, info), 0) + slots.length * SLOT_HOURS;
    const when = term === NO_TERM ? "" : termOrder(term) < termOrder(now) ? "past" : term === now ? "now" : "future";
    // Courses you're registered for now are full cards ("In progress"); finished ones are chips.
    const registered = (course) => course.status === "taken" && course.kind === "registered";
    const takenBlock = takenChips(
      courses.filter((course) => course.status === "taken" && !registered(course)),
      info,
      graph,
      facts,
      everything,
    );
    let problems = 0;
    const cards = courses
      .filter((course) => course.status !== "taken" || registered(course))
      .map((course) => {
        if (course.status === "taken") return courseCard(course, info.get(course.id), graph, facts, everything, []);
        const issues = courseIssues({
          id: course.id,
          term: term === NO_TERM ? null : term,
          courses: everything,
          graph,
          facts,
          offeredSince,
        });
        problems += issues.length;
        return courseCard(course, info.get(course.id), graph, facts, everything, issues);
      });
    cards.push(...slots.map((slot) => slotCard(slot, graph, facts, everything, allSlots)));
    // Light / heavy is advice for semesters still to come, not for credit already earned.
    const load = when === "future" ? semesterLoad(hours) : "normal";
    const card = element(
      "section",
      { className: `plan-semester ${when}` },
      element(
        "h3",
        {},
        term === NO_TERM ? "No term yet" : termLabel(term),
        when === "now" ? element("span", { className: "plan-now", textContent: "now" }) : "",
        problems > 0
          ? element("span", {
              className: "plan-problems",
              textContent: `${problems} problem${problems === 1 ? "" : "s"}`,
            })
          : "",
        element("span", {
          className: `plan-load ${load}`,
          textContent: `${hours} hr${load === "light" && hours > 0 ? " · light" : load === "heavy" ? " · heavy" : ""}`,
          title: load === "heavy" ? "Over 18 hours" : load === "light" ? "Under 12 hours (below full time)" : "",
        }),
      ),
      takenBlock,
      cards.length > 0 ? element("ul", { className: "plan-list" }, ...cards) : "",
      courses.length + slots.length === 0
        ? element("p", {
            className: "plan-drop-hint",
            textContent:
              when === "now"
                ? "Add the courses you're taking this semester: type a code in Add a course and press Add as in progress."
                : "Drag a course here, or use ← → on a course.",
          })
        : "",
    );
    acceptDrops(card, term);
    return card;
  }

  /** Where "+ Plan" puts a course: next semester, or the one after its latest planned prerequisite. */
  function suggestedTerm(graph, id, courses) {
    let term = nextTerm();
    const node = graph.byId.get(id);
    for (const prerequisite of node?.prerequisites ?? []) {
      const planned = courses.find(
        (course) => course.id === prerequisite && course.status === "planned" && course.term,
      );
      if (planned && termOrder(planned.term) >= termOrder(term)) term = nextMainTerm(planned.term);
    }
    return term;
  }

  function readyColumn(graph, courses) {
    const taken = new Set(courses.filter((c) => c.status === "taken").map((c) => c.id));
    const ready = readyNext(graph, new Set(courses.map((c) => c.id))).slice(0, READY_SHOWN);
    const cards = ready.map((id) => {
      const node = graph.byId.get(id);
      const nowOrLater = missingRequirements(graph, id, taken).length === 0 ? "now" : "after your planned courses";
      const term = suggestedTerm(graph, id, courses);
      return draggableCard(
        id,
        { className: "plan-course ready", title: "Drag into a semester" },
        element(
          "a",
          { href: courseHash(id), className: "plan-course-link" },
          element("span", { className: "code", textContent: id }),
          element("span", { className: "title", textContent: node.title }),
        ),
        element(
          "div",
          { className: "plan-course-actions" },
          element("span", { className: "plan-hours", textContent: `Ready ${nowOrLater}` }),
          actionButton(`+ Plan for ${termLabel(term)}`, () => myCourses.set(id, "planned", term)),
        ),
      );
    });
    return element(
      "section",
      { className: "plan-ready" },
      element(
        "h3",
        {},
        "Ready to take next",
        element("span", { className: "plan-load", textContent: `${ready.length}` }),
      ),
      cards.length === 0
        ? element("p", {
            className: "plan-empty",
            textContent:
              courses.length === 0
                ? "Mark some courses and the courses they open up appear here."
                : "No more courses open up from these yet.",
          })
        : element("ul", { className: "plan-list plan-ready-list" }, ...cards),
    );
  }

  function draw() {
    const graph = getGraph();
    const facts = courseFacts(rows);
    const courses = planCourses();
    const slots = myCourses.slots();
    const info = courseInfo(courses.map((c) => c.id));
    const isCredit = (course) => course.status === "taken" && course.kind === "credit";
    const credit = courses.filter(isCredit);
    const inSemesters = courses.filter((course) => !isCredit(course));

    // One card per semester, in time order, with courses and slots lacking a term last.
    const group = (items) => {
      const byTerm = new Map();
      for (const item of items) {
        const key = item.term ?? NO_TERM;
        if (!byTerm.has(key)) byTerm.set(key, []);
        byTerm.get(key).push(item);
      }
      return byTerm;
    };
    const bySemester = group(inSemesters);
    const slotsBySemester = group(slots);
    const used = [...inSemesters, ...slots].map((item) => item.term).filter(Boolean);
    const semesters = planSemesters(used, currentMainTerm());
    if (bySemester.has(NO_TERM) || slotsBySemester.has(NO_TERM)) semesters.push(NO_TERM);

    section.replaceChildren(
      element(
        "header",
        { className: "plan-header" },
        element("h2", { textContent: "My plan" }),
        helpLine(),
        progressBar(courses, info, slots),
        element(
          "div",
          { className: "plan-tools" },
          autoPanel(),
          element("div", { className: "plan-add-panel" }, element("h3", { textContent: "Add a course" }), addForm()),
        ),
      ),
      oldSaveNote(courses),
      resultNote(),
      element(
        "div",
        { className: "plan-semesters" },
        credit.length > 0 ? creditCard(credit, info, graph, facts, courses) : "",
        ...semesters.map((term) =>
          semesterCard(
            term,
            bySemester.get(term) ?? [],
            slotsBySemester.get(term) ?? [],
            info,
            graph,
            facts,
            courses,
            slots,
          ),
        ),
      ),
      readyColumn(graph, courses),
    );
  }

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
      lastResult = null; // the note is about the moment it was made
    },
    /** Auto-plans from the saved audit (used by the Audit page's "Make a plan" button). */
    generate,
  };
}
