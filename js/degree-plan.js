// Plans a whole degree from a catalog page, for students with no audit: its required courses,
// picks from its lists, campus Gen Eds and electives, up to the hours it takes to graduate.
// No DOM or database code here, so the tests can use it. The catalog states lists in words, so
// this reads what it safely can and leaves the rest as slots the student fills in. Unofficial.

import { tr } from "./i18n.js";
import { buildAutoPlan } from "./auto-plan.js";
import { SLOT_HOURS, slotKind, slotPart } from "./plan-insights.js";
import { countIn, focusAreas, hoursIn, requiredCourses, requirementRuns } from "./programs.js";

const DEFAULT_HOURS = 120; // most UIUC degrees; used when the catalog page states no total
const COURSE_HOURS = 3; // a typical course, for working out what's left of a requirement
const GEN_ED_ROOM = 24; // hours kept for Gen Eds no major course meets
const TOO_MANY_HOURS = 15; // a plan this far over the degree's hours gets a warning
// Assumed from high school, or a placement test: planning them would hold a first semester back.
const HIGH_SCHOOL_MATH = ["MATH 112", "MATH 115"];

// The campus Gen Ed requirements: every major's page repeats these, as slot kind and courses needed.
const CAMPUS_GEN_EDS = { COMP1: 1, COMP: 1, HUM: 2, NAT: 2, SBS: 2, WCC: 1, NW: 1, US: 1, QR: 1, QR2: 1 };

// Lines that aren't a requirement of their own: Gen Eds are planned above, the rest are totals.
const NOT_A_REQUIREMENT =
  /\b(total|free electives?|general education|gen eds?|composition|humanities|social|cultural|quantitative|language)\b/i;
const ELECTIVE_LINE = /\b(electives?|select|choose|additional)\b/i;
const SCIENCE_LINE = /\b(natural sciences?|science elective)\b/i;

const numbersFrom = (ids) =>
  ids.map((id) => {
    const [subject, number] = id.split(" ");
    return { subject, number };
  });

/** A requirement part meeting `needs` from a list of course ids, the shape Auto-plan takes. */
const listPart = (title, ids, needs, label = "1") => ({
  label,
  title,
  needs,
  selectFrom: numbersFrom(ids),
  notFrom: [],
  courses: [],
});

const sectionOf = (title, parts, needs = null) => ({ title, needs, notes: [], courses: [], parts });
const idsIn = (rows) => [...new Set(rows.flatMap((row) => row.options.flat()))];

/** What a list asks for: hours the line states, else a count it states, else its hours, else one course. */
function listNeeds({ intro, block, allMenu }, runsInBlock) {
  const text = intro?.text ?? "";
  const statedHours = text.match(/(\d+)(?:\s*-\s*\d+)?\s+(?:credit\s+)?hours?/i);
  if (statedHours) return { hours: Number(statedHours[1]) };
  const count = countIn(text);
  if (count) return { courses: count };
  const columnHours = hoursIn(intro?.hours);
  if (columnHours) return { hours: columnHours };
  const tableHours = hoursIn(block.total);
  return allMenu && runsInBlock === 1 && tableHours ? { hours: tableHours } : { courses: 1 };
}

const hoursNeeded = (needs) => needs.hours ?? needs.courses * COURSE_HOURS;

/** What's left of a list's needs after the courses already taken from it. */
function needsLeft(needs, ids, taken, hoursOf) {
  const done = ids.filter((id) => taken.has(id));
  if (needs.hours) return { hours: Math.max(0, needs.hours - done.reduce((sum, id) => sum + hoursOf(id), 0)) };
  return { courses: Math.max(0, needs.courses - done.length) };
}

/**
 * A catalog page as Auto-plan's requirement sections, and the slots for requirements stated only
 * in words. `focus` is the focus area chosen; with none, Auto-plan takes the easiest.
 * Some pages nest options (a primary field, each with its own lists) that can't be told apart
 * from requirements, so planning stops at `hoursLeft`; `skipped` names what that left out.
 */
export function degreeRequirements({ blocks, focus = null, statusOf, taken, hoursOf, hoursLeft }) {
  const areas = focusAreas(blocks);
  const areaHeaders = new Set(areas.map((area) => area.header));
  let room = hoursLeft - GEN_ED_ROOM;
  const skipped = new Set();
  /** Whether `hours` more fit the degree; if not, `heading` is left for the student. */
  const fits = (hours, heading) => {
    if (room <= 0) skipped.add(heading);
    else room -= hours;
    return !skipped.has(heading);
  };
  const required = requiredCourses(blocks, statusOf)
    .courses.filter(({ id, reason }) => fits(hoursOf(id), reason))
    .map(({ id, reason }) => listPart(reason, [id], { courses: 1 }));
  const sections = [sectionOf("PROGRAM", required)];
  const electiveSlots = [];
  const runs = requirementRuns(blocks).filter((run) => !areaHeaders.has(run.intro));
  const usedHours = new Map(); // table -> hours its lists will fill, so "18 hours of electives" isn't counted twice

  const lists = runs.filter((run) => run.menu && run.rows.length > 0);
  for (const [index, run] of lists.entries()) {
    const siblings = lists.filter((other) => other.block === run.block).length;
    const needs = listNeeds(run, siblings);
    const ids = idsIn(run.rows);
    usedHours.set(run.block, (usedHours.get(run.block) ?? 0) + hoursNeeded(needs));
    const left = needsLeft(needs, ids, taken, hoursOf);
    if ((left.courses > 0 || left.hours > 0) && fits(hoursNeeded(left), run.heading)) {
      sections.push(sectionOf(`LIST ${index}`, [listPart(run.heading, ids, left)]));
    }
  }

  if (areas.length > 0) {
    const owner = blocks.find((block) => block.rows?.includes(areas[0].header));
    usedHours.set(owner, (usedHours.get(owner) ?? 0) + areas[0].need * COURSE_HOURS);
    const chosen = areas.filter((area) => area.name === focus);
    const parts = (chosen.length > 0 ? chosen : areas).map((area, index) => {
      const ids = idsIn(area.rows);
      const left = needsLeft({ courses: area.need }, ids, taken, hoursOf);
      return listPart(`Focus Area: ${area.name}`, ids, left, index === 0 ? "1" : "OR");
    });
    const stillNeeded = parts.every((part) => part.needs.courses > 0);
    if (stillNeeded && fits(hoursNeeded(parts[0].needs), "Focus Area")) sections.push(sectionOf("FOCUS AREA", parts));
  }

  // Requirements stated only in words ("two advanced electives"): slots for the student to fill.
  for (const run of runs.filter((candidate) => candidate.rows.length === 0)) {
    const text = run.intro?.text ?? "";
    if (NOT_A_REQUIREMENT.test(run.heading) || NOT_A_REQUIREMENT.test(text)) continue;
    if (!run.allMenu && !ELECTIVE_LINE.test(text)) continue;
    const stated = hoursIn(run.intro?.hours) ?? (run.intro ? null : hoursIn(run.block.total));
    if (!stated) continue;
    const hours = Math.max(0, stated - (run.allMenu ? (usedHours.get(run.block) ?? 0) : 0));
    const kind = SCIENCE_LINE.test(text) ? "NAT" : "FREE";
    const reason = kind === "NAT" ? "Science Elective" : run.heading;
    const count = Math.ceil(hours / SLOT_HOURS);
    if (!fits(hours, run.heading)) continue;
    for (let n = 0; n < count; n += 1) electiveSlots.push({ kind, reason });
  }
  return { sections, electiveSlots, skipped: [...skipped] };
}

/** The campus Gen Eds still to meet, after the courses already taken. */
function genEdSection(taken, facts) {
  const parts = Object.entries(CAMPUS_GEN_EDS).flatMap(([key, count]) => {
    const kind = slotKind(key);
    const done = [...taken].filter((id) => kind.codes.some((code) => facts.get(id)?.genEds.has(code))).length;
    const left = count - done;
    return left > 0 ? [{ ...slotPart(kind), label: "1", needs: { courses: left }, courses: [] }] : [];
  });
  return sectionOf("GEN EDS", parts);
}

/**
 * Plans a degree from next semester to graduation, the same result as buildAutoPlan, plus
 * `focusArea`, the one the plan used.
 * @param {object} input
 * @param {object[]} input.blocks the catalog page's requirements
 * @param {number|null} input.totalHours hours to graduate
 * @param {string|null} [input.focus] the focus area chosen
 * @param {number} input.takenHours hours already earned
 * The rest are as buildAutoPlan takes them.
 */
export function planDegree({ blocks, totalHours, focus = null, takenHours, ...planInput }) {
  const { planned, facts } = planInput;
  const taken = new Set([...planInput.taken, ...HIGH_SCHOOL_MATH]);
  const inPlan = new Set(planned.map((course) => course.id));
  const statusOf = (id) => (taken.has(id) ? "taken" : inPlan.has(id) ? "planned" : null);
  const hoursOf = (id) => facts.get(id)?.hours ?? COURSE_HOURS;
  const hoursLeft = Math.max(0, (totalHours ?? DEFAULT_HOURS) - takenHours);
  const { sections, electiveSlots, skipped } = degreeRequirements({
    blocks,
    focus,
    statusOf,
    taken,
    hoursOf,
    hoursLeft,
  });
  const result = buildAutoPlan({
    ...planInput,
    taken,
    sections: [...sections, genEdSection(taken, facts), sectionOf("HOURS TO GRADUATE", [], { hours: hoursLeft })],
    genEdSlots: true,
    electiveSlots,
    coming: sections[0].parts.map(({ selectFrom: [{ subject, number }] }) => `${subject} ${number}`),
  });
  const areaReason = result.courses.find((course) => course.reason.startsWith("Focus Area: "))?.reason;
  const plannedHours = result.courses.reduce((sum, { id }) => sum + hoursOf(id), 0) + result.slots.length * SLOT_HOURS;
  return {
    ...result,
    focusArea: focus ?? areaReason?.replace("Focus Area: ", "") ?? null,
    open: [
      ...result.open,
      ...(plannedHours > hoursLeft + TOO_MANY_HOURS
        ? [
            {
              title: tr("Too many hours", "学分偏多"),
              text: tr(
                `This plan comes to ${plannedHours} hours, and you need ${hoursLeft}. The catalog page's lists are hard to read exactly, so check it with an advisor and drop what you don't need.`,
                `这份计划共 ${plannedHours} 学分，而你只需要 ${hoursLeft}。目录页面的列表很难完全读准，请和 advisor 核对，去掉不需要的课。`,
              ),
            },
          ]
        : []),
      ...skipped.map((title) => ({
        title,
        text: tr(
          "The catalog's options here are too involved to plan for you. Pick these from the official page.",
          "目录这部分的选项太复杂，无法替你规划。请到官方页面自己选。",
        ),
      })),
      {
        title: tr("Math placement", "数学分级"),
        text: tr(
          "The plan assumes you're ready for calculus. If your placement says otherwise, add MATH 112 or MATH 115 first.",
          "这份计划假定你可以直接修微积分。如果分级结果不够，请先加上 MATH 112 或 MATH 115。",
        ),
      },
      {
        title: tr("Language", "外语"),
        text: tr(
          "Most degrees need the third semester of a language other than English. High school study often covers it, so it isn't planned here.",
          "多数学位要求英语以外的一门语言达到第三学期水平。高中所学通常就能满足，所以这里没有排课。",
        ),
      },
    ],
  };
}
