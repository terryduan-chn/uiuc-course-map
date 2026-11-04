// The #plan page: your courses semester by semester, Gen Ed slots, Auto-plan, and what you
// can take next. Each course's own controls (← → ⋯, badges) come from plan-controls.js.

import { tr } from "./i18n.js";
import { clearEverything, gpaCard, savedAudit } from "./audit-view.js";
import { buildAutoPlan, TARGET_HOURS } from "./auto-plan.js";
import { missingRequirements, readyNext } from "./graph-data.js";
import { focusKey, keepFocus, myCourses } from "./my-courses.js";
import { changeImpact, changeSummary, planChange } from "./plan-change.js";
import { issueBadges, moveButton, nextTerm, planControls, planCourses, termChoices } from "./plan-controls.js";
import {
  courseIssues,
  degreeProgress,
  GEN_ED_SLOTS,
  seasonsText,
  semesterLoad,
  SLOT_HOURS,
  reasonText,
  slotKind,
  slotKindsOf,
  slotLabel,
  slotNames,
  slotOptions,
  slotPart,
  slotShortLabel,
  slotTitle,
} from "./plan-insights.js";
import { courseFacts, requirementCourses } from "./requirement-courses.js";
import { creditHours, gradeText, parseCourseCode, requirementLabel } from "./search.js";
import { currentTerm, doneBy, nextMainTerm, planSemesters, termLabel, termOrder, termText } from "./terms.js";

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
  let savedPlan = { courses: planCourses(), snapshot: myCourses.snapshot() }; // the plan before the next change
  let lastChange = null; // the latest move or removal: { summary, undo, affected }
  const expanded = new Set(); // course cards opened to show details, kept across redraws
  const [offeredSince] = rows("SELECT value FROM meta WHERE key = 'oldest_term_searched'").map((row) => {
    const [year, season] = row.value.split("/");
    return `${season[0].toUpperCase()}${season.slice(1)} ${year}`;
  });

  function courseInfo(ids) {
    if (ids.length === 0) return new Map();
    const found = rows(
      `SELECT courses.subject || ' ' || courses.number AS id, title, credit_hours, average_gpa, four_point_rate
       FROM courses LEFT JOIN course_grades USING (subject, number)
       WHERE courses.subject || ' ' || courses.number IN (${ids.map(() => "?").join(", ")})`,
      ids,
    );
    return new Map(found.map((course) => [course.id, course]));
  }

  const courseHash = (id) => `#${id.replace(" ", "-")}`;
  // The hours your audit credited a course with, else the catalog's.
  const hoursOf = (id, info) => myCourses.hours(id) ?? creditHours(info.get(id)?.credit_hours);
  const hoursText = (hours) => tr(`${hours} ${hours === 1 ? "hour" : "hours"}`, `${hours} 学分`);

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
    const { before, same } = doneBy(courses, term, id);
    const counts = (group, prerequisite) => before.has(prerequisite) || (group.concurrent && same.has(prerequisite));
    const groups = node?.requirements ?? [];
    return element(
      "div",
      { className: "plan-details" },
      element(
        "dl",
        { className: "plan-facts" },
        element("dt", { textContent: tr("Grades", "成绩") }),
        element("dd", { textContent: gradeText(info?.average_gpa, info?.four_point_rate) }),
        element("dt", { textContent: tr("Runs", "开课") }),
        element("dd", {
          textContent: fact?.offered
            ? seasonsText(fact.seasons)
            : tr(`not since ${offeredSince}`, `${termText(offeredSince)}以来未开课`),
        }),
      ),
      element("p", {
        className: "plan-details-label",
        textContent: groups.length === 0 ? tr("No prerequisites", "没有先修课") : tr("Prerequisites", "先修课"),
      }),
      groups.length === 0
        ? ""
        : element(
            "ul",
            { className: "plan-prereqs" },
            ...groups.map((group) => {
              const have = group.ids.filter((prerequisite) => counts(group, prerequisite)).length;
              const met = have >= group.required;
              return element(
                "li",
                { className: met ? "met" : "unmet" },
                element("span", {
                  className: "plan-prereq-mark",
                  textContent: met ? "✓" : "✗",
                  ariaLabel: met ? tr("met", "已满足") : tr("not met", "未满足"),
                }),
                group.ids.length > 1
                  ? tr(
                      `${requirementLabel(group.required, group.ids.length)}: `,
                      `${requirementLabel(group.required, group.ids.length)}：`,
                    )
                  : "",
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
            tr(`Unlocks ${node.dependents.length}: `, `解锁 ${node.dependents.length} 门：`),
            ...node.dependents
              .slice(0, UNLOCKS_SHOWN)
              .flatMap((dependent, i) => [
                i > 0 ? ", " : "",
                element("a", { href: courseHash(dependent), textContent: dependent }),
              ]),
            node.dependents.length > UNLOCKS_SHOWN ? "…" : "",
          )
        : "",
      element("a", {
        href: courseHash(id),
        className: "plan-details-link",
        textContent: tr("Open course page →", "打开课程页 →"),
      }),
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
          title: open ? tr("Hide details", "收起详情") : tr("Show details", "展开详情"),
          onclick: () => {
            if (expanded.has(id)) expanded.delete(id);
            else expanded.add(id);
            keepFocus(draw);
          },
        },
        element("span", { className: "code", textContent: id }),
        element("span", { className: "title", textContent: info?.title ?? tr("Not in the app's data", "数据里没有") }),
        element("span", { className: "plan-chevron", ariaHidden: "true", textContent: open ? "▴" : "▾" }),
      ),
      `head-${id}`,
    );
    head.setAttribute("aria-expanded", String(open));
    // One line about it: taken or in progress, auto, hours, its Gen Eds, and why it's in the plan.
    const fills = myCourses.fills(id);
    const why =
      fills.length > 0 ? tr(`Fills ${slotNames(fills)}`, `填补${slotNames(fills)}`) : reasonText(myCourses.reason(id));
    // The Gen Eds this course counts for: one course can meet two (Humanities and Western).
    const genEds = slotKindsOf(facts.get(id)).map(slotKind);
    const genEdText =
      genEds.length === 0
        ? ""
        : tr(`Counts for ${genEds.map((kind) => kind.name).join(" and ")}`, `计入${genEds.map(slotLabel).join("和")}`);
    const meta = element(
      "p",
      { className: "plan-meta", title: [genEdText, why].filter(Boolean).join(". ") },
      status === "taken"
        ? myCourses.kind(id) === "registered"
          ? element("span", { className: "plan-status registered", textContent: tr("In progress", "在修") })
          : element("span", { className: "plan-status taken", textContent: tr("Taken", "已修") })
        : "",
      myCourses.isAuto(id)
        ? element("span", {
            className: "plan-auto",
            textContent: tr("auto", "自动"),
            title: tr("Added by Auto-plan", "由自动规划加入"),
          })
        : "",
      hours === null
        ? ""
        : element("span", { className: "plan-hours", textContent: tr(`${hours} hr`, `${hours} 学分`) }),
      ...genEds.map((kind) => element("span", { className: "plan-gened", textContent: slotShortLabel(kind) })),
      why ? element("span", { className: "plan-reason", textContent: `· ${why}` }) : "",
    );
    // ✕ in the corner takes it out of the plan in one click (the ⋯ menu has the same).
    const remove = focusKey(
      element("button", {
        type: "button",
        className: "plan-remove",
        textContent: "✕",
        title: tr("Remove from plan", "从计划中移除"),
        ariaLabel: tr(`Remove ${id} from the plan`, `把 ${id} 从计划中移除`),
        onclick: () => myCourses.set(id, null),
      }),
      `remove-${id}`,
    );
    // Its line and its buttons share one row, so every card in a semester is the same small size.
    return draggableCard(
      id,
      {
        className: `plan-course ${status}${myCourses.isAuto(id) ? " auto" : ""}${issues.length ? " has-issues" : ""}${
          lastChange?.affected.has(id) ? " affected" : ""
        }`,
      },
      head,
      remove,
      element("div", { className: "plan-course-foot" }, meta, planControls({ element, rows, graph, id })),
      issueBadges(element, issues),
      open ? courseDetails(id, course.term, info, graph, facts, courses) : "",
    );
  }

  /** A Gen Ed slot: a "pick a course" placeholder with ← →, a list of courses to pick, and ✕. */
  function slotCard(slot, graph, facts, courses, slots) {
    const kind = slotKind(slot.kind);
    const title = slotTitle(slot); // "Humanities & the Arts + Western/Comparative Cultures" for a shared slot
    // The card shows short names ("Humanities + Western") so it stays as small as a course card.
    const shortTitle = [slot.kind, ...slot.also].map((other) => slotShortLabel(slotKind(other))).join(" + ");
    const arrow = (direction) =>
      moveButton({
        element,
        direction,
        term: slot.term,
        what: tr(`the ${title} slot`, `${title}空位`),
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
          textContent: tr("Pick", "选课"),
          title: tr("Pick a course for this slot", "为这个空位选一门课"),
          ariaLabel: tr(`Pick a course for the ${title} slot`, `为${title}空位选一门课`),
        }),
        `pick-${slot.id}`,
      ),
      element("div", { className: "plan-menu-panel" }, picks),
    );
    // The course list is looked up only when it opens (it searches every course with the Gen Ed).
    picker.addEventListener("toggle", () => {
      if (!picker.open || picks.childElementCount > 0) return;
      // A shared slot looks through every course of its main Gen Ed, so the ones meeting both are found.
      const limit = slot.also.length > 0 ? undefined : SLOT_CANDIDATES;
      // A free elective can be any undergraduate course of 3 hours or more.
      const candidates =
        slot.kind === "FREE"
          ? [...facts]
              .filter(([id, fact]) => fact.offered && fact.hours >= 3 && Number(id.split(" ")[1]) < 500)
              .map(([id]) => id)
          : requirementCourses(rows, slotPart(kind), { genEdLimit: limit }).map(([id]) => id);
      const options = slotOptions({ slot, candidates, courses, slots, graph, facts });
      if (options.length === 0) {
        picks.append(
          element("p", {
            className: "plan-menu-label",
            textContent: tr("No recently offered courses found.", "没有找到最近开过的课。"),
          }),
        );
        return;
      }
      const info = courseInfo(options.map((option) => option.id));
      const alsoText = (option) =>
        option.covers.length === 0
          ? ""
          : tr(
              `also ${option.covers.map((id) => slotLabel(slotKind(slots.find((other) => other.id === id).kind))).join(", ")}`,
              `同时满足${option.covers.map((id) => slotLabel(slotKind(slots.find((other) => other.id === id).kind))).join("、")}`,
            );
      // In a shared slot, say when a course meets only some of its Gen Eds (the rest stay open).
      const sharedText = (option) => {
        if (slot.also.length === 0) return "";
        const missed = slot.also.filter((other) => !option.meetsAlso.includes(other));
        if (missed.length > 0) return tr(`${slotNames(missed)} stays open`, `${slotNames(missed)}仍然空着`);
        return slot.also.length === 1
          ? tr("counts for both", "两项都计入")
          : tr(`counts for all ${slot.also.length + 1}`, `${slot.also.length + 1} 项都计入`);
      };
      picks.append(
        element("p", {
          className: "plan-menu-label",
          textContent:
            slot.also.length > 0
              ? tr(
                  "Best first: fits this semester, counts for every Gen Ed in this slot, then higher GPA.",
                  "优先顺序：适合本学期，能计入这个空位的所有通识要求，然后是 GPA 更高的。",
                )
              : tr(
                  "Best first: fits this semester, fills another slot too, then higher GPA.",
                  "优先顺序：适合本学期，还能填另一个空位，然后是 GPA 更高的。",
                ),
        }),
        ...options.map((option) =>
          element(
            "button",
            {
              type: "button",
              className: `plan-menu-item plan-slot-option ${option.ready ? "ready" : ""}`,
              onclick: () => myCourses.fillSlot(slot.id, option.id, option.covers, slotKindsOf(facts.get(option.id))),
            },
            element("strong", { textContent: option.id }),
            element("span", { className: "plan-slot-option-title", textContent: info.get(option.id)?.title ?? "" }),
            element("span", {
              className: "plan-slot-option-meta",
              textContent: [
                gradeText(option.gpa, option.fourRate),
                sharedText(option),
                alsoText(option),
                option.ready ? "" : tr("needs prerequisites or another season", "需要先修课，或要换开课季节"),
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
        { className: "plan-slot-head", title: tr(`${title}: pick a course later`, `${title}：之后再选课`) },
        element("span", {
          className: "code",
          textContent: slot.kind === "FREE" ? tr("Elective slot", "选修空位") : tr("Gen Ed slot", "通识空位"),
        }),
        slot.auto
          ? element("span", {
              className: "plan-auto",
              textContent: tr("auto", "自动"),
              title: tr("Added by Auto-plan", "由自动规划加入"),
            })
          : "",
        element("span", { className: "plan-hours", textContent: tr(`${SLOT_HOURS} hr`, `${SLOT_HOURS} 学分`) }),
        element("span", { className: "title", textContent: shortTitle }),
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
            title: tr("Remove this slot", "移除这个空位"),
            ariaLabel: tr(`Remove the ${title} slot`, `移除${title}空位`),
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
      placeholder: tr("Add a course, e.g. CS 225", "添加课程，例如 CS 225"),
      autocomplete: "off",
      ariaLabel: tr("Course code to add", "要添加的课程代码"),
    });
    const term = element(
      "select",
      { className: "term-menu", ariaLabel: tr("Semester for the course you add", "所添加课程的学期") },
      element("option", { value: "", textContent: tr("No term", "未定学期") }),
      ...termChoices([]).map((value) =>
        element("option", { value, textContent: termLabel(value), selected: value === nextTerm() }),
      ),
    );
    const message = element("p", { className: "plan-add-message", role: "status" });
    // "planned" or "taken" in the chosen semester, or "in progress": taking it this semester.
    const add = (status) => {
      const code = parseCourseCode(input.value);
      if (!code) {
        message.textContent = tr("Type a course code, like CS 225.", "请输入课程代码，例如 CS 225。");
        return;
      }
      const id = `${code.subject} ${code.number}`;
      if (courseInfo([id]).size === 0) {
        message.textContent = tr(
          `${id} isn't in the course data. Check the code.`,
          `课程数据里没有 ${id}，请检查代码。`,
        );
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
        textContent: tr("Add as planned", "加入计划"),
        onclick: () => add("planned"),
      }),
      element("button", {
        type: "button",
        className: "btn btn-ghost",
        textContent: tr("Add as in progress", "添加为在修"),
        title: tr(
          `You're taking it now, in ${termLabel(currentTerm())}`,
          `你正在修这门课（${termLabel(currentTerm())}）`,
        ),
        onclick: () => add("in progress"),
      }),
      element("button", {
        type: "button",
        className: "btn btn-ghost",
        textContent: tr("Add as taken", "添加为已修"),
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
      { className: "term-menu plan-slot-kind", ariaLabel: tr("Gen Ed slot to add", "要添加的通识空位") },
      ...GEN_ED_SLOTS.map((slot) => element("option", { value: slot.key, textContent: slotLabel(slot) })),
    );
    return element(
      "div",
      { className: "plan-add-slot" },
      element("span", {
        className: "plan-add-slot-label",
        textContent: tr("Or save a place for a Gen Ed:", "或者先给通识课留个位置："),
      }),
      kind,
      focusKey(
        element("button", {
          type: "button",
          className: "btn btn-ghost",
          textContent: tr("Add Gen Ed slot", "添加通识空位"),
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
        element("h3", { textContent: tr("Auto-plan", "自动规划") }),
        element("p", {
          textContent: tr(
            "Upload your degree audit and the plan fills itself with courses for every requirement you still need.",
            "上传学位 audit 后，计划会自动填入你还需要的每项要求对应的课程。",
          ),
        }),
        element("a", {
          href: "#audit",
          className: "btn btn-ghost",
          textContent: tr("Go to Audit →", "前往学位审核 →"),
        }),
      );
    }
    return element(
      "div",
      { className: "plan-auto-panel" },
      element(
        "h3",
        {},
        tr("Auto-plan", "自动规划"),
        element("span", {
          className: "plan-auto-source",
          textContent: tr(
            ` from your ${audit.programName ?? "degree"} audit`,
            `（来自你的 ${audit.programName ?? "学位"} audit）`,
          ),
        }),
      ),
      element("p", {
        textContent: tr(
          `Fills ${termLabel(nextTerm())} onward with courses for every unmet requirement, about ${TARGET_HOURS} hours a semester. Gen Eds become slots you pick a course for. Your own planned courses stay.`,
          `从 ${termLabel(nextTerm())} 起，为每项未满足的要求排课，每学期约 ${TARGET_HOURS} 学分。通识要求会变成空位，由你自己选课。你自己计划的课保持不变。`,
        ),
      }),
      element(
        "div",
        { className: "plan-auto-actions" },
        focusKey(
          element("button", {
            type: "button",
            className: "btn btn-primary",
            textContent: generated ? tr("Re-plan", "重新规划") : tr("Auto-plan my degree", "自动规划我的学位"),
            onclick: generate,
          }),
          "auto-plan",
        ),
        generated
          ? focusKey(
              element("button", {
                type: "button",
                className: "btn btn-ghost",
                textContent: tr(`Clear generated (${generated})`, `清除自动生成的（${generated}）`),
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
        tr(
          "Upload your audit again so this semester's courses show as in progress and AP or transfer credit gets its own card. ",
          "请重新上传 audit，这样本学期的课会显示为在修，AP 和转学分也会有自己的卡片。",
        ),
        element("a", { href: "#audit", textContent: tr("Go to Audit →", "前往学位审核 →") }),
      );
    }
    return element(
      "p",
      { className: "plan-result plan-old-save", role: "status" },
      tr(
        `${now.length} course${now.length === 1 ? " is" : "s are"} marked taken in ${termLabel(currentTerm())}. Taking ${now.length === 1 ? "it" : "them"} now? `,
        `${termLabel(currentTerm())}有 ${now.length} 门课标记为已修。是正在修吗？`,
      ),
      focusKey(
        element("button", {
          type: "button",
          className: "btn btn-primary",
          textContent: tr("Mark them in progress", "标记为在修"),
          onclick: () => now.forEach((course) => myCourses.setInProgress(course.id)),
        }),
        "mark-in-progress",
      ),
    );
  }

  /** What the latest move or removal did to the rest of the plan, with Undo. */
  function changeNote() {
    if (!lastChange) return "";
    const { title, lines } = lastChange.summary;
    return element(
      "section",
      { className: "plan-change", role: "status" },
      element(
        "div",
        { className: "plan-change-text" },
        element("strong", { textContent: title }),
        ...lines.map((line) => element("p", { textContent: line })),
      ),
      element(
        "div",
        { className: "plan-change-actions" },
        focusKey(
          element("button", {
            type: "button",
            className: "btn btn-primary",
            textContent: tr("Undo", "撤销"),
            onclick: () => myCourses.restore(lastChange.undo),
          }),
          "plan-change-undo",
        ),
        element("button", {
          type: "button",
          className: "plan-remove",
          textContent: "✕",
          title: tr("Close this note", "关闭这条提示"),
          ariaLabel: tr("Close this note", "关闭这条提示"),
          onclick: () => {
            lastChange = null;
            keepFocus(draw);
          },
        }),
      ),
    );
  }

  /** What the latest Auto-plan added, and what it left for the student to pick. */
  function resultNote() {
    if (!lastResult) return "";
    const terms = new Set([...lastResult.courses, ...lastResult.slots].map((item) => item.term));
    const slotCount = lastResult.slots.length;
    const count = (n, what, inChinese) => (n ? tr(`${n} ${what}${n === 1 ? "" : "s"}`, `${n} ${inChinese}`) : "");
    const electives = lastResult.slots.filter((slot) => slot.kind === "FREE").length;
    // "19 courses, 3 Gen Ed slots and 1 elective slot"
    const added = new Intl.ListFormat(tr("en", "zh")).format(
      [
        count(lastResult.courses.length, "course", "门课"),
        count(slotCount - electives, "Gen Ed slot", "个通识空位"),
        count(electives, "elective slot", "个选修空位"),
      ].filter(Boolean),
    );
    return element(
      "section",
      { className: "plan-result", role: "status" },
      element("p", {
        className: "plan-result-lead",
        textContent: !added
          ? tr(
              "Nothing to add: your plan already covers every requirement it can fill.",
              "没有可添加的：你的计划已经覆盖了所有能填的要求。",
            )
          : tr(
              `Added ${added} over ${terms.size} semesters (marked “auto”). Open ⋯ on a course to swap it${slotCount ? "; press Pick on a slot to choose one" : ""}.`,
              `已在 ${terms.size} 个学期里加入${added}（标记为“自动”）。点课程上的 ⋯ 可以替换${slotCount ? "；点空位上的“选课”可以选一门" : ""}。`,
            ),
      }),
      lastResult.open.length > 0
        ? element(
            "div",
            {},
            element("p", {
              className: "plan-result-sub",
              textContent: tr("Still for you to pick:", "还需要你自己选："),
            }),
            element(
              "ul",
              {},
              ...lastResult.open.map((item) =>
                element(
                  "li",
                  {},
                  element("strong", { textContent: tr(`${item.title}: `, `${item.title}：`) }),
                  item.text,
                ),
              ),
            ),
          )
        : "",
      element("p", {
        className: "plan-result-note",
        textContent: tr(
          "Unofficial: check the plan with your advisor and the official audit.",
          "非官方：请和 advisor 及官方 audit 核对这份计划。",
        ),
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
        ? tr(`${hoursText(progress.short)} still to plan`, `还有 ${hoursText(progress.short)} 待规划`)
        : when
          ? tr(`On track to finish in ${when}`, `预计 ${when} 修完`)
          : tr("Every hour is covered", "所有学分都已覆盖");
    const bar = element(
      "div",
      {
        className: "plan-progress-bar",
        role: "img",
        ariaLabel: tr(
          `${progress.earned} hours earned, ${progress.planned} planned, ${progress.short} still to plan, of ${progress.total}`,
          `共 ${progress.total} 学分：已获得 ${progress.earned}，已计划 ${progress.planned}，待规划 ${progress.short}`,
        ),
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
        element("span", {}, element("strong", { textContent: progress.earned }), tr(" earned", " 已获得")),
        element("span", {}, element("strong", { textContent: progress.planned }), tr(" planned", " 已计划")),
        element(
          "span",
          { className: progress.short > 0 ? "short" : "done" },
          element("strong", { textContent: progress.short }),
          tr(" still to plan", " 待规划"),
        ),
        element("span", {
          className: "plan-progress-total",
          textContent: tr(`of ${progress.total} hours`, `共 ${progress.total} 学分`),
        }),
      ),
      bar,
      gpaCard(element, audit),
      element(
        "p",
        { className: "plan-progress-note" },
        progress.requirements
          ? tr(
              `Requirements on your audit: ${progress.requirements.done} of ${progress.requirements.all} done · `,
              `audit 上的要求：${progress.requirements.all} 项已完成 ${progress.requirements.done} 项 · `,
            )
          : tr(
              "No audit yet, so 120 hours (most UIUC degrees need 120–128) · ",
              "还没有 audit，先按 120 学分算（UIUC 多数学位需要 120–128）· ",
            ),
        element("strong", { textContent: finish }),
        progress.short > 0 && when ? tr(` · last planned semester ${when}`, ` · 最后一个计划学期 ${when}`) : "",
      ),
    );
  }

  /** One line on how the page works, with the colors. */
  function helpLine() {
    return element(
      "p",
      { className: "plan-help" },
      tr(
        "Press + Plan on any course, drag cards between semesters or use ← →, click a card for details, ⋯ for more. ",
        "在任意课程上点“+ 计划”，在学期之间拖动卡片或用 ← →，点击卡片看详情，点 ⋯ 看更多操作。",
      ),
      element("span", { className: "plan-key taken", textContent: tr("taken", "已修") }),
      element("span", { className: "plan-key planned", textContent: tr("planned", "已计划") }),
      element("span", { className: "plan-key auto", textContent: tr("auto-planned", "自动规划") }),
      element("span", { className: "plan-key slot", textContent: tr("Gen Ed slot", "通识空位") }),
      element("span", { className: "plan-key problem", textContent: tr("problem", "有问题") }),
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
                  title: `${course.id}: ${info.get(course.id)?.title ?? ""} (${hoursOf(course.id, info)} ${tr("hr", "学分")})`,
                }),
              ),
            ),
          ),
          element(
            "details",
            { className: "plan-taken-edit" },
            element("summary", {
              textContent: tr(
                `Edit ${takenCourses.length} taken course${takenCourses.length === 1 ? "" : "s"}`,
                `编辑 ${takenCourses.length} 门已修课程`,
              ),
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
      semesterHead(
        tr("Credit before UIUC", "入学前学分"),
        element("span", { className: "plan-load normal", textContent: tr(`${hours} hr`, `${hours} 学分`) }),
      ),
      element(
        "div",
        { className: "plan-semester-body" },
        element("p", {
          className: "plan-credit-note",
          textContent: tr(
            "AP, proficiency and transfer credit: it counts toward your degree, not toward a semester.",
            "AP、水平考试和转学分：计入学位，但不算在某个学期里。",
          ),
        }),
        takenChips(credit, info, graph, facts, everything),
      ),
    );
  }

  /** A semester row's left column: its name, then its badges (now, hours, problems). */
  function semesterHead(name, ...badges) {
    return element(
      "div",
      { className: "plan-semester-head" },
      element("h3", { textContent: name }),
      element("div", { className: "plan-semester-badges" }, ...badges),
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
      semesterHead(
        term === NO_TERM ? tr("No term yet", "未定学期") : termLabel(term),
        when === "now" ? element("span", { className: "plan-now", textContent: tr("now", "本学期") }) : "",
        element("span", {
          className: `plan-load ${load}`,
          textContent: tr(
            `${hours} hr${load === "light" && hours > 0 ? " · light" : load === "heavy" ? " · heavy" : ""}`,
            `${hours} 学分${load === "light" && hours > 0 ? " · 偏少" : load === "heavy" ? " · 偏重" : ""}`,
          ),
          title:
            load === "heavy"
              ? tr("Over 18 hours", "超过 18 学分")
              : load === "light"
                ? tr("Under 12 hours (below full time)", "不足 12 学分（低于全日制）")
                : "",
        }),
        problems > 0
          ? element("span", {
              className: "plan-problems",
              textContent: tr(`${problems} problem${problems === 1 ? "" : "s"}`, `${problems} 个问题`),
            })
          : "",
      ),
      element(
        "div",
        { className: "plan-semester-body" },
        takenBlock,
        cards.length > 0 ? element("ul", { className: "plan-list" }, ...cards) : "",
        courses.length + slots.length === 0
          ? element("p", {
              className: "plan-drop-hint",
              textContent:
                when === "now"
                  ? tr(
                      "Add the courses you're taking this semester: type a code in Add a course and press Add as in progress.",
                      "添加你这学期正在修的课：在添加课程框里输入代码，然后点“添加为在修”。",
                    )
                  : tr("Drag a course here, or use ← → on a course.", "把课程拖到这里，或用课程上的 ← →。"),
            })
          : "",
      ),
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
      const nowOrLater =
        missingRequirements(graph, id, taken).length === 0
          ? tr("now", "现在")
          : tr("after your planned courses", "修完计划中的课后");
      const term = suggestedTerm(graph, id, courses);
      return draggableCard(
        id,
        { className: "plan-course ready", title: tr("Drag into a semester", "拖到某个学期") },
        element(
          "a",
          { href: courseHash(id), className: "plan-course-link" },
          element("span", { className: "code", textContent: id }),
          element("span", { className: "title", textContent: node.title }),
        ),
        element(
          "div",
          { className: "plan-course-actions" },
          element("span", { className: "plan-hours", textContent: tr(`Ready ${nowOrLater}`, `${nowOrLater}可修`) }),
          actionButton(tr(`+ Plan for ${termLabel(term)}`, `+ 计划在 ${termLabel(term)}`), () =>
            myCourses.set(id, "planned", term),
          ),
        ),
      );
    });
    return element(
      "section",
      { className: "plan-ready" },
      element(
        "h3",
        {},
        tr("Ready to take next", "接下来可以修"),
        element("span", { className: "plan-load", textContent: `${ready.length}` }),
      ),
      cards.length === 0
        ? element("p", {
            className: "plan-empty",
            textContent:
              courses.length === 0
                ? tr(
                    "Mark some courses and the courses they open up appear here.",
                    "标记一些课程后，它们解锁的课会出现在这里。",
                  )
                : tr("No more courses open up from these yet.", "这些课暂时没有解锁更多课程。"),
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
        element(
          "div",
          { className: "plan-title-row" },
          element("h2", { textContent: tr("My plan", "我的计划") }),
          courses.length + slots.length > 0 || savedAudit()
            ? element("button", {
                type: "button",
                className: "btn btn-ghost plan-clear",
                textContent: tr("Clear everything", "全部清除"),
                title: tr("Remove your plan and your audit from this browser", "从这个浏览器删除你的计划和 audit"),
                onclick: () => {
                  // Auto-plan's note goes with the plan (set first: clearing redraws the page).
                  const shown = lastResult;
                  lastResult = null;
                  if (!clearEverything()) {
                    lastResult = shown;
                    return;
                  }
                  lastChange = null; // Undo can't bring the audit back, so it isn't offered
                  keepFocus(draw);
                },
              })
            : "",
        ),
        helpLine(),
        progressBar(courses, info, slots),
        element(
          "div",
          { className: "plan-tools" },
          autoPanel(),
          element(
            "div",
            { className: "plan-add-panel" },
            element("h3", { textContent: tr("Add a course", "添加课程") }),
            addForm(),
          ),
        ),
      ),
      oldSaveNote(courses),
      resultNote(),
      changeNote(),
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

  /** After a change on this page, works out what one course moved or removed did to the plan. */
  function noticeChange() {
    const before = savedPlan;
    savedPlan = { courses: planCourses(), snapshot: myCourses.snapshot() };
    // Undo (or moving the course back by hand) is the plan as it was: there's nothing to report.
    const undone = savedPlan.snapshot === lastChange?.undo;
    const change = section.hidden || undone ? null : planChange(before.courses, savedPlan.courses);
    if (!change) {
      lastChange = null;
      return;
    }
    const impact = changeImpact({
      change,
      before: before.courses,
      after: savedPlan.courses,
      graph: getGraph(),
      facts: courseFacts(rows),
      offeredSince,
      slotTerms: myCourses.slots().map((slot) => slot.term),
    });
    lastChange = {
      summary: changeSummary(impact),
      undo: before.snapshot,
      affected: new Set([...impact.delayed, ...impact.blocked].map((course) => course.id)),
    };
  }

  myCourses.onChange(() => {
    noticeChange();
    if (!section.hidden) keepFocus(draw);
  });

  return {
    show() {
      section.hidden = false;
      draw();
    },
    hide() {
      section.hidden = true;
      lastResult = null; // the notes are about the moment they were made
      lastChange = null;
    },
    /** Auto-plans from the saved audit (used by the Audit page's "Make a plan" button). */
    generate,
  };
}
