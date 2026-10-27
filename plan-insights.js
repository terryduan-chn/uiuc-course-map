// What the plan pages say about courses in a plan: their problems, each semester's load, the
// degree's progress, a course's best semester, and courses that could replace one.
// No DOM or database code here, so the tests can use it.

import { genEdCodesFor, partGroups, requirementSections, sectionIsMet, titleCase } from "./audit-reader.js";
import { missingRequirements } from "./graph-data.js";
import { requirementLabel } from "./search.js";
import { doneBefore, nextMainTerm, termLabel, termOrder } from "./terms.js";

/** The kinds of Gen Ed slot a plan can hold, with the Gen Ed codes that fill each. */
export const GEN_ED_SLOTS = [
  { key: "HUM", name: "Humanities & the Arts", codes: ["1HP", "1LA"] },
  { key: "SBS", name: "Social & Behavioral Sciences", codes: ["1BSC", "1SS"] },
  { key: "NAT", name: "Natural Sciences & Technology", codes: ["1LS", "1PS"] },
  { key: "QR", name: "Quantitative Reasoning", codes: ["1QR1", "1QR2"] },
  { key: "QR2", name: "Quantitative Reasoning II", codes: ["1QR2"] },
  { key: "WCC", name: "Western/Comparative Cultures", codes: ["1WCC"] },
  { key: "NW", name: "Non-Western Cultures", codes: ["1NW"] },
  { key: "US", name: "U.S. Minority Cultures", codes: ["1US"] },
  { key: "COMP", name: "Advanced Composition", codes: ["1CLL"] },
];
export const SLOT_HOURS = 3; // a Gen Ed slot counts as a typical 3-hour course
export const slotKind = (key) => GEN_ED_SLOTS.find((slot) => slot.key === key) ?? null;

/** The slot kind for an audit Gen Ed requirement ("NON-WESTERN CULTURES" -> "NW"), or null. */
export function slotKindFor(title) {
  const codes = genEdCodesFor(title).join();
  return GEN_ED_SLOTS.find((slot) => slot.codes.join() === codes)?.key ?? null;
}

/** "Humanities & the Arts + U.S. Minority Cultures" for slot kinds ["HUM", "US"]. */
export const slotNames = (kinds) =>
  kinds
    .map((kind) => slotKind(kind)?.name)
    .filter(Boolean)
    .join(" + ");

/** The slot kind a Gen Ed's name stands for ("Humanities & the Arts" -> its GEN_ED_SLOTS entry), or null. */
export const slotKindNamed = (name) => GEN_ED_SLOTS.find((slot) => slot.name === name) ?? null;

/** A requirement part for a slot kind, the shape requirementCourses takes, to list its Gen Ed courses. */
export const slotPart = (kind) => ({ title: kind.name.toUpperCase(), selectFrom: [], notFrom: [] });

/**
 * The slots (from `slots`, [{ id, kind, term }]) a course with these facts would fill: one of
 * each kind its Gen Eds count for, earliest first, so one course never fills two Humanities slots.
 */
export function slotsFilledBy(fact, slots) {
  const kinds = new Set();
  const filled = [];
  const order = (slot) => Math.min(termOrder(slot.term), Number.MAX_SAFE_INTEGER); // no term: last
  const byTerm = [...slots].sort((a, b) => order(a) - order(b));
  for (const slot of byTerm) {
    if (kinds.has(slot.kind) || !slotKind(slot.kind)?.codes.some((code) => fact?.genEds.has(code))) continue;
    kinds.add(slot.kind);
    filled.push(slot);
  }
  return filled;
}

const LIGHT_HOURS = 12; // fewer is a light semester (below full time)
const HEAVY_HOURS = 18; // more is a heavy one

/** "Choose 1 of 3: CS 126, CS 128, ECE 220" for each requirement not yet met. */
export function describeMissing(groups) {
  return groups
    .map((group) =>
      group.ids.length === 1
        ? group.ids[0]
        : `${requirementLabel(group.required, group.ids.length)}: ${group.ids.join(", ")}`,
    )
    .join("; ");
}

/** "Fall and Spring", "Fall only", "Spring only", or "summer or winter only". */
export function seasonsText(seasons) {
  if (seasons.has("FA") && seasons.has("SP")) return "Fall and Spring";
  if (seasons.has("FA")) return "Fall only";
  if (seasons.has("SP")) return "Spring only";
  return "summer or winter only";
}

/**
 * Problems with a planned course in its semester, as { kind, text }:
 * "prereq" (a prerequisite isn't taken or planned earlier), "season" (it doesn't run that
 * season), "stale" (not offered in any term searched).
 * `courses` is the whole plan ([{ id, status, term }]); `facts` from loadCourseFacts.
 */
export function courseIssues({ id, term, courses, graph, facts, offeredSince }) {
  const issues = [];
  const fact = facts?.get(id);
  if (fact && !fact.offered) issues.push({ kind: "stale", text: `Not offered since ${offeredSince ?? "a while"}` });
  if (term && fact?.offered && fact.seasons.size > 0 && /^(FA|SP)/.test(term) && !fact.seasons.has(term.slice(0, 2))) {
    issues.push({ kind: "season", text: `Runs ${seasonsText(fact.seasons)}, not ${termLabel(term).split(" ")[0]}` });
  }
  const before = term
    ? doneBefore(courses, term)
    : new Set(courses.filter((course) => course.id !== id).map((course) => course.id));
  const missing = missingRequirements(graph, id, before);
  if (missing.length > 0) {
    issues.push({
      kind: "prereq",
      text: `Needs ${describeMissing(missing)} ${term ? "in an earlier semester" : "first"}`,
    });
  }
  return issues;
}

/** How full a semester is: "light" (under 12 hours), "normal", or "heavy" (over 18). */
export function semesterLoad(hours) {
  if (hours > HEAVY_HOURS) return "heavy";
  if (hours > 0 && hours < LIGHT_HOURS) return "light";
  return "normal";
}

/**
 * The degree at a glance: hours needed in all, earned (the audit's own count, transfer credit
 * included, else the taken courses), planned, still short; requirements done; and the last
 * semester with a planned course.
 */
export function degreeProgress({ courses, hoursOf, audit }) {
  const sections = audit ? requirementSections(audit) : [];
  const totalSection = sections.find((section) => /MINIMUM OF \d+ HOURS/.test(section.title));
  const total = totalSection ? Number(totalSection.title.match(/MINIMUM OF (\d+) HOURS/)[1]) : 120;
  const takenHours = courses
    .filter((course) => course.status === "taken")
    .reduce((sum, course) => sum + hoursOf(course.id), 0);
  const earned = totalSection?.earned?.hours ?? takenHours;
  const planned = courses
    .filter((course) => course.status === "planned")
    .reduce((sum, course) => sum + hoursOf(course.id), 0);
  const plannedTerms = courses
    .filter((course) => course.status === "planned" && course.term)
    .map((course) => course.term)
    .sort((a, b) => termOrder(a) - termOrder(b));
  return {
    total,
    earned,
    planned,
    short: Math.max(0, total - earned - planned),
    requirements: audit ? { done: sections.filter(sectionIsMet).length, all: sections.length } : null,
    lastTerm: plannedTerms.at(-1) ?? null,
  };
}

/**
 * The first Fall or Spring from `startTerm` on where a course's prerequisites are done before
 * it and it runs that season (within four years), else `startTerm`.
 */
export function bestTerm({ id, courses, graph, facts, startTerm }) {
  const others = courses.filter((course) => course.id !== id);
  const seasons = facts?.get(id)?.seasons ?? new Set();
  let term = startTerm;
  for (let step = 0; step < 8; step += 1) {
    const seasonOk = seasons.size === 0 || seasons.has(term.slice(0, 2));
    if (seasonOk && missingRequirements(graph, id, doneBefore(others, term)).length === 0) return term;
    term = nextMainTerm(term);
  }
  return startTerm;
}

/** The audit requirement part Auto-plan added a course for, found by its reason ("Technical Electives"). */
export function requirementFor(audit, reason) {
  for (const section of audit?.sections ?? []) {
    for (const group of partGroups(section)) {
      for (const part of group) if (titleCase(part.title) === reason) return part;
    }
  }
  return null;
}

/**
 * Courses that could replace `id` for the same requirement, best first: ones that can be
 * taken in its semester (prerequisites done before it, right season), then ones that keep more
 * of the Gen Ed slots it fills (`fills`, like ["HUM", "US"]), then higher GPA. Each option says
 * which of those slot kinds it keeps. `candidates` are the requirement's course ids; courses
 * already taken or planned are left out.
 */
export function swapOptions({ id, term, candidates, courses, graph, facts, fills = [], limit = 8 }) {
  const inPlan = new Set(courses.map((course) => course.id));
  const others = courses.filter((course) => course.id !== id);
  const before = term ? doneBefore(others, term) : new Set(others.map((course) => course.id));
  return candidates
    .filter((option) => option !== id && !inPlan.has(option) && facts?.get(option)?.offered)
    .map((option) => {
      const seasons = facts.get(option).seasons;
      const seasonOk = !term || seasons.size === 0 || seasons.has(term.slice(0, 2));
      const ready = seasonOk && missingRequirements(graph, option, before).length === 0;
      const keeps = fills.filter((kind) => slotKind(kind)?.codes.some((code) => facts.get(option).genEds.has(code)));
      return { id: option, ready, keeps, gpa: facts.get(option).gpa };
    })
    .sort(
      (a, b) =>
        Number(b.ready) - Number(a.ready) ||
        b.keeps.length - a.keeps.length ||
        (b.gpa ?? 0) - (a.gpa ?? 0) ||
        a.id.localeCompare(b.id),
    )
    .slice(0, limit);
}

/**
 * Courses to fill a Gen Ed slot with, best first: ones that can be taken in its semester, then
 * ones that also fill other open slots (like Humanities and Western at once), then higher GPA.
 * `candidates` are course ids with the slot's Gen Eds; `slots` is every slot in the plan.
 * Each option lists the other slot ids it would also fill (at most one per kind).
 */
export function slotOptions({ slot, candidates, courses, slots, graph, facts, limit = 10 }) {
  const inPlan = new Set(courses.map((course) => course.id));
  const before = slot.term ? doneBefore(courses, slot.term) : inPlan;
  const others = slots.filter((other) => other.id !== slot.id && other.kind !== slot.kind);
  return candidates
    .filter((id) => !inPlan.has(id) && facts?.get(id)?.offered)
    .map((id) => {
      const fact = facts.get(id);
      const seasonOk = !slot.term || fact.seasons.size === 0 || fact.seasons.has(slot.term.slice(0, 2));
      const ready = seasonOk && missingRequirements(graph, id, before).length === 0;
      return { id, ready, covers: slotsFilledBy(fact, others).map((other) => other.id), gpa: fact.gpa };
    })
    .sort(
      (a, b) =>
        Number(b.ready) - Number(a.ready) ||
        b.covers.length - a.covers.length ||
        (b.gpa ?? 0) - (a.gpa ?? 0) ||
        a.id.localeCompare(b.id),
    )
    .slice(0, limit);
}
