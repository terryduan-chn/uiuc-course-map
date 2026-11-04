// What moving or removing one course does to the rest of a plan: the courses that would have to
// wait, the ones that can't be taken any more, and the finish date. Nothing in the plan is
// changed here. No DOM or database code, so the tests can use it.

import { tr } from "./i18n.js";
import { bestTerm, courseIssues } from "./plan-insights.js";
import { termLabel, termOrder } from "./terms.js";

/**
 * The one course moved or removed between two plans ([{ id, status, term }]), as
 * { id, from, to, removed }; null for anything else (nothing changed, a course added, several
 * changed, or a course marked taken).
 */
export function planChange(before, after) {
  const now = new Map(after.map((course) => [course.id, course]));
  const known = new Set(before.map((course) => course.id));
  if (after.some((course) => !known.has(course.id))) return null;
  const changed = before.filter((course) => {
    const current = now.get(course.id);
    return current?.term !== course.term || current?.status !== course.status;
  });
  if (changed.length !== 1) return null;
  const [{ id, term: from }] = changed;
  const current = now.get(id);
  if (current && current.status !== changed[0].status) return null;
  return { id, from, to: current?.term ?? null, removed: !current };
}

/** The last semester with anything planned, or null. */
function finishTerm(courses, slotTerms) {
  const terms = [...courses.filter((course) => course.status === "planned").map((course) => course.term), ...slotTerms];
  return (
    terms
      .filter(Boolean)
      .sort((a, b) => termOrder(a) - termOrder(b))
      .at(-1) ?? null
  );
}

/**
 * What a change does: `delayed` courses ({ id, from, to }) that would have to wait for it, each
 * pushing back whatever depends on it in turn; `blocked` courses ({ id, term, text }) that waiting
 * can't fix; `ownProblems`, new problems with the moved course itself; and the finish date before
 * and after. Problems the plan already had aren't counted. `slotTerms` are the semesters of its
 * Gen Ed slots, which count toward the finish date.
 */
export function changeImpact({ change, before, after, graph, facts, offeredSince, slotTerms = [] }) {
  const problems = (course, courses, kinds = ["prereq"]) =>
    courseIssues({ ...course, courses, graph, facts, offeredSince }).filter((issue) => kinds.includes(issue.kind));
  const hadProblem = new Set(before.filter((course) => problems(course, before).length > 0).map((course) => course.id));

  const plan = after.map((course) => ({ ...course }));
  const delayed = new Map();
  const blocked = new Map();
  const waiting = () =>
    plan
      .filter((course) => course.status === "planned" && course.term && course.id !== change.id)
      .filter((course) => !hadProblem.has(course.id) && !blocked.has(course.id))
      .filter((course) => problems(course, plan).length > 0)
      .sort((a, b) => termOrder(a.term) - termOrder(b.term) || a.id.localeCompare(b.id));

  for (let course = waiting()[0]; course; course = waiting()[0]) {
    const from = course.term;
    const later = bestTerm({ id: course.id, courses: plan, graph, facts, startTerm: from });
    const [stillMissing] = problems({ ...course, term: later }, plan);
    if (stillMissing) blocked.set(course.id, { id: course.id, term: from, text: stillMissing.text });
    else {
      course.term = later;
      delayed.set(course.id, { id: course.id, from: delayed.get(course.id)?.from ?? from, to: later });
    }
  }

  const moved = change.removed ? null : after.find((course) => course.id === change.id);
  const kinds = ["prereq", "season"];
  const earlier = before.find((course) => course.id === change.id);
  const known = new Set(problems(earlier, before, kinds).map((issue) => issue.text));
  return {
    change,
    delayed: [...delayed.values()],
    blocked: [...blocked.values()],
    ownProblems: moved
      ? problems(moved, after, kinds)
          .map((issue) => issue.text)
          .filter((text) => !known.has(text))
      : [],
    finishBefore: finishTerm(before, slotTerms),
    finishAfter: finishTerm(plan, slotTerms),
  };
}

/** A change's impact in words: { title, lines }. */
export function changeSummary({ change, delayed, blocked, ownProblems, finishBefore, finishAfter }) {
  const { id, to, removed } = change;
  const title = removed
    ? tr(`Removed ${id}`, `已移除 ${id}`)
    : to
      ? tr(`Moved ${id} to ${termLabel(to)}`, `已把 ${id} 移到 ${termLabel(to)}`)
      : tr(`Moved ${id} to no term`, `已把 ${id} 移到“未定学期”`);
  const lines = [
    ...ownProblems.map((text) => tr(`${id}: ${text}.`, `${id}：${text}。`)),
    ...delayed.map((course) =>
      tr(
        `${course.id} would have to wait until ${termLabel(course.to)}.`,
        `${course.id} 要推迟到 ${termLabel(course.to)}。`,
      ),
    ),
    ...blocked.map((course) => tr(`${course.id}: ${course.text}.`, `${course.id}：${course.text}。`)),
  ];
  const finish = finishAfter && termLabel(finishAfter);
  if (finishAfter !== finishBefore && finishBefore && finishAfter) {
    const since = delayed.length === 0 ? "You now" : `If ${delayed.length === 1 ? "it waits" : "they wait"}, you`;
    lines.push(
      tr(
        `${since} finish in ${finish} instead of ${termLabel(finishBefore)}.`,
        `${delayed.length === 0 ? "" : "如果推迟，"}修完时间会从 ${termLabel(finishBefore)} 变成 ${finish}。`,
      ),
    );
  } else if (lines.length === 0) {
    lines.push(
      finish
        ? tr(`No other courses affected. You still finish in ${finish}.`, `其他课程不受影响，你仍然在 ${finish} 修完。`)
        : tr("No other courses affected.", "其他课程不受影响。"),
    );
  } else if (finish) {
    lines.push(tr(`You still finish in ${finish}.`, `你仍然在 ${finish} 修完。`));
  }
  return { title, lines };
}
