// Builds a semester plan from a degree audit's unmet requirements.
// No DOM or database code here: the page passes in what it knows, so the tests can run it.
//
// The easiest path: for each unmet requirement it counts courses already in the plan first,
// then picks the courses that need the fewest extra prerequisites, then the highest average
// GPA (and, for Gen Eds, the ones that meet the most unmet Gen Eds at once). It adds the
// prerequisites those courses need, then places every course in the earliest semester where
// its prerequisites come before it, it is offered that season, and the semester stays near
// 15 hours.

import {
  describeNeeds,
  describePattern,
  genEdCodesFor,
  partGroups,
  partIsMet,
  sectionIsMet,
  titleCase,
} from "./audit-reader.js";
import { missingRequirements } from "./graph-data.js";
import { SLOT_HOURS, slotKindFor } from "./plan-insights.js";
import { nextMainTerm, termOrder } from "./terms.js";

export const TARGET_HOURS = 15; // a semester is full at about this many hours
const MAX_HOURS = 18; // a course that runs only one season may stretch a semester this far
const MAX_SEMESTERS = 16; // eight years, far more than any plan should need
const PREREQUISITE_DEPTH = 6; // how far back a chain of prerequisites is followed

/** A requirement the audit lists no courses for, met by Gen Ed courses (and they may also count elsewhere). */
const isGenEdPart = (part) => part.selectFrom.length === 0 && genEdCodesFor(part.title).length > 0;

/**
 * @param {object} input
 * @param {object[]} input.sections the audit's requirement sections
 * @param {(part: object) => string[]} input.candidates course ids that can meet a requirement part
 * @param {Map<string, {hours: number, gpa: number|null, offered: boolean, seasons: Set<string>, genEds: Set<string>}>} input.facts
 * @param {object} input.graph the prerequisite graph (buildGraph)
 * @param {Set<string>} input.taken courses taken (or in progress)
 * @param {{id: string, term: string|null}[]} input.planned the student's own planned courses
 * @param {string} input.startTerm the first semester to fill, e.g. "SP27"
 * @param {boolean} [input.genEdSlots] leave Gen Eds as "pick a course" slots instead of choosing courses
 * @param {{kind: string, term: string|null}[]} [input.slots] the student's own Gen Ed slots
 * @returns {{
 *   courses: {id: string, term: string, reason: string}[],
 *   scheduled: {id: string, term: string}[],
 *   slots: {kind: string, term: string, reason: string}[],
 *   open: {title: string, text: string}[],
 * }} new courses with a semester and why each is there; the student's unscheduled planned
 *   courses given a semester; new Gen Ed slots; requirements the plan can't fill by itself
 */
export function buildAutoPlan({
  sections,
  candidates,
  facts,
  graph,
  taken,
  planned,
  startTerm,
  targetHours = TARGET_HOURS,
  genEdSlots = false,
  slots = [],
}) {
  const mine = new Set(planned.map((course) => course.id));
  const picked = new Map(); // new course id -> why it's in the plan
  const owner = new Map(); // course id -> the requirement section it counts for (Gen Eds can share)
  const genEdPicks = new Set(); // courses picked for a Gen Ed, scheduled after the major's chains
  const newSlots = new Map(); // placeholder id ("slot:HUM:1") -> { kind, reason }
  const ownSlots = slots.map((slot) => ({ ...slot, used: false }));
  const have = () => new Set([...taken, ...mine, ...picked.keys()]);
  const hoursOf = (id) => facts.get(id)?.hours ?? 3;
  const usable = (id) => Boolean(facts.get(id)?.offered) && !taken.has(id);

  /** The courses to add so that `id`'s prerequisites are met, following chains back. */
  function prerequisitesToAdd(id, known, depth = 0) {
    const added = [];
    if (depth >= PREREQUISITE_DEPTH) return added;
    for (const group of missingRequirements(graph, id, known)) {
      const options = group.ids
        .filter((option) => !known.has(option) && usable(option))
        .map((option) => ({ option, missing: missingRequirements(graph, option, known).length }))
        .sort((a, b) => a.missing - b.missing || a.option.localeCompare(b.option));
      for (const { option } of options.slice(0, group.required - group.have)) {
        known.add(option);
        added.push(option, ...prerequisitesToAdd(option, known, depth + 1));
      }
    }
    return added;
  }
  const extraCost = (id) => prerequisitesToAdd(id, have()).length;

  // Unmet Gen Ed requirements, so a course meeting two of them at once can be preferred.
  const openGenEds = sections
    .filter((section) => !sectionIsMet(section))
    .flatMap((section) => section.parts.filter((part) => isGenEdPart(part) && !partIsMet(part)))
    .map((part) => genEdCodesFor(part.title));
  const genEdCount = (id) => openGenEds.filter((codes) => codes.some((code) => facts.get(id)?.genEds.has(code))).length;

  /** How a requirement part would be met: courses already in the plan, plus new picks. */
  function choose(part, sectionTitle) {
    const genEd = isGenEdPart(part);
    const exactCourses = part.selectFrom.filter((pattern) => pattern.number.length === 3 && pattern.subject !== "*");
    // No "NEEDS" line but a list (like "SELECT FROM: PHYS 212"): one course from it.
    const needCourses = part.needs?.courses ?? (part.needs?.hours ? 0 : Math.min(1, exactCourses.length || 1));
    const needHours = part.needs?.hours ?? 0;
    const pool = candidates(part).filter(
      (id) => usable(id) && (genEd || !owner.has(id) || owner.get(id) === sectionTitle),
    );
    const counted = pool.filter((id) => mine.has(id) || picked.has(id));
    let courses = counted.length;
    let hours = counted.reduce((sum, id) => sum + hoursOf(id), 0);
    // Slots: the student's own slots of this kind count first, then new slots fill the rest.
    const slotKind = genEd && genEdSlots ? slotKindFor(part.title) : null;
    if (slotKind) {
      const slotsNeeded = () =>
        Math.max(needCourses - courses, Math.ceil(Math.max(needHours - hours, 0) / SLOT_HOURS), 0);
      for (const slot of ownSlots.filter((own) => own.kind === slotKind && !own.used).slice(0, slotsNeeded())) {
        slot.used = true;
        courses += 1;
        hours += SLOT_HOURS;
      }
      const count = slotsNeeded();
      return { genEd, counted, chosen: [], slotKind, slotCount: count, met: true, cost: count, short: {} };
    }
    const ranked = pool
      .filter((id) => !counted.includes(id))
      .map((id) => ({
        id,
        cost: extraCost(id),
        genEds: genEd ? genEdCount(id) : 0,
        graduate: Number(id.split(" ")[1]) >= 500, // 500-level courses are graduate courses: last resort
        gpa: facts.get(id)?.gpa ?? 0,
      }))
      .sort(
        (a, b) =>
          a.cost - b.cost ||
          b.genEds - a.genEds ||
          Number(a.graduate) - Number(b.graduate) ||
          b.gpa - a.gpa ||
          a.id.localeCompare(b.id),
      );
    const chosen = [];
    for (const { id } of ranked) {
      if (courses >= needCourses && hours >= needHours) break;
      chosen.push(id);
      courses += 1;
      hours += hoursOf(id);
    }
    const met = courses >= needCourses && hours >= needHours;
    const cost = chosen.reduce((sum, id) => sum + 1 + extraCost(id), 0);
    return { genEd, counted, chosen, met, cost, short: { courses: needCourses - courses, hours: needHours - hours } };
  }

  function commit(choice, sectionTitle, reason) {
    for (let n = 0; n < (choice.slotCount ?? 0); n += 1) {
      newSlots.set(`slot:${choice.slotKind}:${newSlots.size}`, { kind: choice.slotKind, reason });
    }
    for (const id of [...choice.counted, ...choice.chosen]) {
      if (!choice.genEd && !owner.has(id)) owner.set(id, sectionTitle);
      // A course first added as someone's prerequisite is really here for this requirement.
      if (picked.get(id)?.startsWith("Prerequisite for")) picked.set(id, reason);
    }
    for (const id of choice.chosen) {
      if (picked.has(id) || mine.has(id)) continue;
      picked.set(id, reason);
      if (choice.genEd) genEdPicks.add(id);
      for (const prerequisite of prerequisitesToAdd(id, have())) {
        if (!picked.has(prerequisite)) picked.set(prerequisite, `Prerequisite for ${id}`);
      }
    }
  }

  const open = [];
  const hourParts = []; // hours-only requirements, checked against the finished plan
  for (const section of sections) {
    if (sectionIsMet(section)) continue;
    if (section.parts.length === 0 && section.needs) {
      open.push({
        title: titleCase(section.title),
        text: `Needs ${describeNeeds(section.needs)} in all.`,
        hoursNeeded: section.needs.hours ?? 0,
      });
      continue;
    }
    for (const group of partGroups(section)) {
      if (group.some(partIsMet)) continue;
      const withCourses = group.filter((part) => candidates(part).length > 0);
      if (withCourses.length === 0) {
        const part = group[0];
        // Hours of a kind the plan's own courses add up to ("ADVANCED HOURS", "45 HOURS OF UIUC COURSEWORK"):
        // checked once the plan is built.
        if (!part.selectFrom.length && part.needs?.hours && !part.needs.courses) {
          hourParts.push(part);
          continue;
        }
        // Only "any 400-level course": the student picks.
        const anyLevel = part.selectFrom.filter((pattern) => pattern.subject === "*").map(describePattern);
        const what = anyLevel.length > 0 ? ` from ${anyLevel.join(" or ")}` : "";
        open.push({
          title: titleCase(part.title),
          text: `Needs ${describeNeeds(part.needs) || "courses"}${what}. Pick these yourself.`,
        });
        continue;
      }
      // "Pick one of these" (like a focus area): the one that needs the fewest new courses.
      const options = withCourses.map((part) => ({ part, choice: choose(part, section.title) }));
      options.sort((a, b) => Number(b.choice.met) - Number(a.choice.met) || a.choice.cost - b.choice.cost);
      const { part, choice } = options[0];
      commit(choice, section.title, titleCase(part.title));
      if (!choice.met) {
        const left = describeNeeds({
          courses: Math.max(choice.short.courses, 0),
          hours: Math.max(choice.short.hours, 0),
        });
        const choices = part.selectFrom.map(describePattern);
        open.push({
          title: titleCase(part.title),
          text: part.selectFrom.some((pattern) => pattern.subject === "*")
            ? `Pick ${left} from ${choices.join(", ")}.`
            : `Not enough recently offered courses to choose from; still ${left}. Ask your advisor.`,
        });
      }
    }
  }

  // ---- Semesters ----
  const semesters = [startTerm];
  while (semesters.length < MAX_SEMESTERS) semesters.push(nextMainTerm(semesters.at(-1)));
  const load = semesters.map(() => 0);
  const fixedTerm = new Map(planned.filter((course) => course.term).map((course) => [course.id, course.term]));
  for (const [id, term] of fixedTerm) {
    const index = semesters.indexOf(term);
    if (index >= 0) load[index] += hoursOf(id);
  }
  for (const slot of slots) {
    const index = semesters.indexOf(slot.term);
    if (index >= 0) load[index] += SLOT_HOURS;
  }
  // New slots are placed like Gen Ed courses with no prerequisites (no facts: 3 hours, any season).
  for (const id of newSlots.keys()) genEdPicks.add(id);
  const toPlace = [
    ...picked.keys(),
    ...planned.filter((course) => !course.term).map((course) => course.id),
    ...newSlots.keys(),
  ];
  const placing = new Set(toPlace);
  const universe = have();
  const placed = new Map(); // id -> semester index

  /** Whether a course is done before semester `index`. */
  function doneBefore(id, index) {
    if (taken.has(id)) return true;
    if (placed.has(id)) return placed.get(id) < index;
    const term = fixedTerm.get(id);
    return Boolean(term) && termOrder(term) < termOrder(semesters[index]);
  }

  /** Every prerequisite group that the plan can meet is met before semester `index`. */
  function readyAt(id, index) {
    for (const group of graph.byId.get(id)?.requirements ?? []) {
      const inPlan = group.ids.filter((member) => universe.has(member));
      if (inPlan.length === 0) continue; // nothing in the plan can meet it (e.g. "consent of instructor")
      const needed = Math.min(group.required, inPlan.length);
      if (inPlan.filter((member) => doneBefore(member, index)).length < needed) return false;
    }
    return true;
  }

  // How long a chain of courses in the plan depends on each course: the longest chains start first.
  const heightMemo = new Map();
  function height(id, seen = new Set()) {
    if (heightMemo.has(id)) return heightMemo.get(id);
    if (seen.has(id)) return 0;
    seen.add(id);
    const after = (graph.byId.get(id)?.dependents ?? []).filter((dependent) => placing.has(dependent));
    const value = 1 + Math.max(0, ...after.map((dependent) => height(dependent, seen)));
    heightMemo.set(id, value);
    return value;
  }
  const genEdOnly = (id) => genEdPicks.has(id);
  const priority = (a, b) => height(b) - height(a) || Number(genEdOnly(a)) - Number(genEdOnly(b)) || a.localeCompare(b);

  // Fill one semester at a time: of the courses whose prerequisites are done and that run that
  // season, the ones starting the longest chains go first; Gen Eds fill what's left.
  let waiting = [...toPlace];
  for (let index = 0; index < semesters.length && waiting.length > 0; index += 1) {
    const last = index === semesters.length - 1;
    const season = semesters[index].slice(0, 2);
    const ready = waiting
      .filter((id) => {
        const seasons = facts.get(id)?.seasons ?? new Set();
        return last || ((seasons.size === 0 || seasons.has(season)) && readyAt(id, index));
      })
      .sort(priority);
    for (const id of ready) {
      const hours = hoursOf(id);
      // A course offered only in Fall or only in Spring would wait a whole year: let it stretch the semester.
      const limit = (facts.get(id)?.seasons.size ?? 2) === 1 ? Math.max(targetHours, MAX_HOURS) : targetHours;
      if (!last && load[index] > 0 && load[index] + hours > limit) continue;
      placed.set(id, index);
      load[index] += hours;
    }
    waiting = waiting.filter((id) => !placed.has(id));
  }

  // The plan's total hours, for requirements counted only in hours (like 128 in all).
  const plannedHours =
    [...mine, ...picked.keys()].reduce((sum, id) => sum + hoursOf(id), 0) + (slots.length + newSlots.size) * SLOT_HOURS;
  const advancedHours = [...mine, ...picked.keys()]
    .filter((id) => Number(id.split(" ")[1]) >= 300)
    .reduce((sum, id) => sum + hoursOf(id), 0);
  for (const part of hourParts) {
    // "Advanced hours" means 300-level and above; other hour counts take any course in the plan.
    const advanced = /ADVANCED/.test(part.title);
    const covered = advanced ? advancedHours : plannedHours;
    if (covered >= part.needs.hours) continue;
    open.push({
      title: titleCase(part.title),
      text: `Needs ${describeNeeds(part.needs)}${advanced ? " at the 300 level or above" : ""}; the plan adds ${covered}. Add more to cover it.`,
    });
  }
  for (const item of open) {
    if (item.hoursNeeded) item.text += ` The plan adds ${plannedHours} hours; fill the rest with electives.`;
    delete item.hoursNeeded;
  }

  return {
    courses: [...picked].map(([id, reason]) => ({ id, term: semesters[placed.get(id)], reason })),
    scheduled: planned
      .filter((course) => !course.term)
      .map((course) => ({ id: course.id, term: semesters[placed.get(course.id)] })),
    slots: [...newSlots].map(([id, { kind, reason }]) => ({ kind, term: semesters[placed.get(id)], reason })),
    open,
  };
}
