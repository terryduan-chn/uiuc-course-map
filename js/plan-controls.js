// The plan controls every page shows for a course: tr("+ Plan", "+ 计划"), ← → to move it a semester, the
// "⋯" menu (semester, taken / planned, swap, back to a slot, remove) and its problem badges.

import { tr } from "./i18n.js";
import { savedAudit } from "./audit-view.js";
import { focusKey, myCourses } from "./my-courses.js";
import { reasonText, requirementFor, slotKindNamed, slotNames, slotPart, swapOptions } from "./plan-insights.js";
import { courseFacts, requirementCourses } from "./requirement-courses.js";
import { gradeText } from "./search.js";
import { currentTerm, nextMainTerm, previousMainTerm, termLabel, termOrder, termsAround } from "./terms.js";

/** The next Fall or Spring to plan for: Spring 2027 while Fall 2026 is on. */
export const nextTerm = () => nextMainTerm(currentTerm());

/** The plan as a list ([{ id, status, term, kind }]), the shape the plan helpers take. */
export const planCourses = () =>
  myCourses
    .ids()
    .map((id) => ({ id, status: myCourses.status(id), term: myCourses.term(id), kind: myCourses.kind(id) }));

/**
 * A tr("+ Plan", "+ 计划") button for any course: adds it to next semester's plan. Once added it shows the
 * semester (pressing it again takes it out); a taken course just says so.
 */
export function planButton(element, id, extraClass = "") {
  const status = myCourses.status(id);
  if (status === "taken") {
    const kind = myCourses.kind(id);
    return element("span", {
      className: `plan-button taken ${extraClass}`,
      textContent:
        kind === "registered"
          ? tr("In progress", "在修")
          : kind === "credit"
            ? tr("✓ Credit", "✓ 已有学分")
            : tr("✓ Taken", "✓ 已修"),
      title:
        kind === "registered"
          ? tr(`You're taking ${id} now`, `你正在修 ${id}`)
          : kind === "credit"
            ? tr(`You have credit for ${id} from before UIUC`, `你入学前已有 ${id} 的学分`)
            : tr(`You've taken ${id}`, `你修过 ${id}`),
    });
  }
  const term = myCourses.term(id);
  const button = element("button", {
    type: "button",
    className: `plan-button ${status ?? ""} ${extraClass}`,
    textContent: status ? `✓ ${term ? termLabel(term) : tr("Planned", "已计划")}` : tr("+ Plan", "+ 计划"),
    title: status
      ? tr(`${id} is in your plan. Press to take it out.`, `${id} 已在你的计划里，点一下可以移除。`)
      : tr(`Add ${id} to your plan for ${termLabel(nextTerm())}`, `把 ${id} 加入 ${termLabel(nextTerm())} 的计划`),
  });
  focusKey(button, `plan-${id}`);
  button.addEventListener("click", (event) => {
    event.preventDefault(); // the button can sit on a course card link
    event.stopPropagation();
    if (status) myCourses.set(id, null);
    else myCourses.set(id, "planned", nextTerm());
  });
  return button;
}

/** The terms a course can be put in: about four years either side of now, plus any already used. */
export function termChoices(used) {
  const terms = new Set([...termsAround(currentTerm()), ...used]);
  return [...terms].sort((a, b) => termOrder(a) - termOrder(b));
}

/** A menu that moves a marked course to another term. */
function termMenu(element, id, extraClass = "") {
  const term = myCourses.term(id);
  const select = element(
    "select",
    {
      className: `term-menu ${extraClass}`,
      ariaLabel: tr(`Semester for ${id}`, `${id} 的学期`),
      title: tr("Which semester", "选择学期"),
    },
    element("option", { value: "", textContent: tr("No term", "未定学期") }),
    ...termChoices(term ? [term] : []).map((value) =>
      element("option", { value, textContent: termLabel(value), selected: value === term }),
    ),
  );
  focusKey(select, `term-${id}-${extraClass}`);
  select.addEventListener("change", () => myCourses.setTerm(id, select.value || null));
  return select;
}

// An open "⋯" menu (or a slot's course list) closes when you click anywhere else, or press
// Escape, which also puts the keyboard back on its button. One listener each for every menu.
document.addEventListener("click", (event) => {
  for (const menu of document.querySelectorAll("details.plan-menu[open]")) {
    if (!menu.contains(event.target)) menu.open = false;
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  for (const menu of document.querySelectorAll("details.plan-menu[open]")) {
    const hadFocus = menu.contains(document.activeElement);
    menu.open = false;
    if (hadFocus) menu.querySelector("summary").focus();
  }
});

/**
 * A ← (direction -1) or → (+1) button that moves a course or slot one Fall/Spring semester;
 * one with no semester yet goes to next semester. `what` names it for screen readers.
 */
export function moveButton({ element, direction, term, what, key, move }) {
  const earlier = direction < 0;
  return focusKey(
    element("button", {
      type: "button",
      className: "plan-action plan-arrow",
      textContent: earlier ? "←" : "→",
      title: earlier ? tr("One semester earlier", "提前一个学期") : tr("One semester later", "推后一个学期"),
      ariaLabel: tr(
        `Move ${what} one semester ${earlier ? "earlier" : "later"}`,
        `把${what}${earlier ? "提前" : "推后"}一个学期`,
      ),
      disabled: !term && earlier,
      onclick: () => move(term ? (earlier ? previousMainTerm(term) : nextMainTerm(term)) : nextTerm()),
    }),
    `${earlier ? "earlier" : "later"}-${key}`,
  );
}

/** Problem badges for a planned course ("Needs CS 225 in an earlier semester", "Runs Fall only…"). */
export function issueBadges(element, issues) {
  if (issues.length === 0) return "";
  return element(
    "ul",
    { className: "plan-badges" },
    ...issues.map((issue) => element("li", { className: `plan-badge ${issue.kind}`, textContent: issue.text })),
  );
}

/**
 * The controls for a planned (or taken) course, used on My plan and on every course page:
 * ← and → move it one semester; "⋯" opens its semester menu, Mark taken / planned, Swap (for a
 * course planned for a requirement or a Gen Ed slot: other courses that meet it), Back to an
 * open slot (for a course picked for a slot), and Remove.
 * @param {{ element: Function, rows: Function, graph: object, id: string, label?: string }} options
 */
export function planControls({ element, rows, graph, id, extraClass = "" }) {
  const status = myCourses.status(id);
  const term = myCourses.term(id);
  const arrow = (direction) =>
    moveButton({
      element,
      direction,
      term,
      what: id,
      key: `${id}-${extraClass}`,
      move: (target) => myCourses.setTerm(id, target),
    });

  const swapArea = element("div", { className: "plan-swap" });
  const other = status === "taken" ? "planned" : "taken";
  const menu = element(
    "details",
    { className: "plan-menu" },
    focusKey(
      element("summary", {
        className: "plan-action",
        title: tr("More", "更多"),
        ariaLabel: tr(`More for ${id}`, `${id} 的更多操作`),
        textContent: "⋯",
      }),
      `menu-${id}-${extraClass}`,
    ),
    element(
      "div",
      { className: "plan-menu-panel" },
      element("label", { className: "plan-menu-label" }, tr("Semester", "学期"), termMenu(element, id, extraClass)),
      element("button", {
        type: "button",
        className: "plan-menu-item",
        textContent:
          status === "taken" ? tr("Mark as planned instead", "改为已计划") : tr("Mark as taken", "标记为已修"),
        onclick: () => myCourses.set(id, other),
      }),
      // A course planned or marked taken this semester may be one you're taking now.
      term === currentTerm() && myCourses.kind(id) !== "registered"
        ? element("button", {
            type: "button",
            className: "plan-menu-item",
            textContent: tr("Mark as in progress", "标记为在修"),
            onclick: () => myCourses.setInProgress(id),
          })
        : "",
      swapArea,
      myCourses.fills(id).length > 0 && status === "planned"
        ? element("button", {
            type: "button",
            className: "plan-menu-item",
            textContent: tr(
              `Back to an open slot (${slotNames(myCourses.fills(id))})`,
              `退回为空位（${slotNames(myCourses.fills(id))}）`,
            ),
            onclick: () => myCourses.backToSlot(id),
          })
        : "",
      element("button", {
        type: "button",
        className: "plan-menu-item remove",
        textContent: tr("Remove from plan", "从计划中移除"),
        onclick: () => myCourses.set(id, null),
      }),
    ),
  );
  // Swap choices are looked up only when the menu opens (it searches the requirement's courses).
  menu.addEventListener("toggle", () => {
    if (!menu.open || swapArea.childElementCount > 0) return;
    const reason = myCourses.reason(id);
    const genEd = slotKindNamed(reason);
    const part = reason ? (requirementFor(savedAudit(), reason) ?? (genEd ? slotPart(genEd) : null)) : null;
    if (!part || status !== "planned") return;
    const facts = courseFacts(rows);
    const options = swapOptions({
      id,
      term,
      candidates: requirementCourses(rows, part).map(([option]) => option),
      courses: planCourses(),
      graph,
      facts,
      fills: myCourses.fills(id),
    });
    // A Gen Ed slot the replacement doesn't fill reopens, so say which ones it keeps.
    const lost = (option) => myCourses.fills(id).filter((kind) => !option.keeps.includes(kind));
    if (options.length === 0) return;
    swapArea.append(
      element("p", {
        className: "plan-menu-label",
        textContent: tr(`Swap for another ${reason} course:`, `换成另一门${reasonText(reason)}的课：`),
      }),
      ...options.map((option) =>
        element("button", {
          type: "button",
          className: `plan-menu-item swap ${option.ready ? "ready" : ""}`,
          textContent: [
            option.id,
            option.gpa ? gradeText(option.gpa, option.fourRate) : "",
            option.ready ? "" : tr("needs prerequisites", "需要先修课"),
            lost(option).length
              ? tr(`reopens ${slotNames(lost(option))} slot`, `${slotNames(lost(option))}空位会重新打开`)
              : "",
          ]
            .filter(Boolean)
            .join(" · "),
          onclick: () => myCourses.swap(id, option.id, option.keeps),
        }),
      ),
    );
  });
  return element(
    "div",
    { className: "plan-course-actions" },
    status === "planned" ? arrow(-1) : "",
    status === "planned" ? arrow(1) : "",
    element("span", { className: "plan-actions-gap" }),
    menu,
  );
}
