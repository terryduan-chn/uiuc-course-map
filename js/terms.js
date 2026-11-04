// Semesters as the degree audit writes them: "FA26" (Fall 2026), "SP27", "SU27", "WI26".
// No DOM code here, so the tests can use it.

import { tr } from "./i18n.js";

const SEASONS = { WI: "Winter", SP: "Spring", SU: "Summer", FA: "Fall" };
const SEASONS_ZH = { WI: "冬季", SP: "春季", SU: "夏季", FA: "秋季" };
const SEASON_ORDER = { WI: 0, SP: 1, SU: 2, FA: 3 }; // Winter session comes before Spring of the same year
const TERM = /^(WI|SP|SU|FA)(\d\d)$/;

export const isTerm = (term) => TERM.test(term ?? "");

/** A number that sorts terms in time order; terms that aren't terms sort last. */
export function termOrder(term) {
  const match = String(term ?? "").match(TERM);
  return match ? Number(match[2]) * 10 + SEASON_ORDER[match[1]] : Infinity;
}

/** "FA26" -> "Fall 2026". */
export function termLabel(term) {
  const match = String(term ?? "").match(TERM);
  if (!match) return "";
  return tr(`${SEASONS[match[1]]} 20${match[2]}`, `20${match[2]} 年${SEASONS_ZH[match[1]]}`);
}

/** "FA26" -> "Fall". */
export function seasonName(term) {
  const season = String(term ?? "").slice(0, 2);
  return tr(SEASONS[season], SEASONS_ZH[season]);
}

/** The term a date falls in: Jan–May Spring, Jun–Jul Summer, Aug–Dec Fall. */
export function currentTerm(date = new Date()) {
  const year = String(date.getFullYear() % 100).padStart(2, "0");
  const month = date.getMonth() + 1;
  return `${month <= 5 ? "SP" : month <= 7 ? "SU" : "FA"}${year}`;
}

/** The next Fall or Spring after a term (summer is skipped): "FA26" -> "SP27", "SP27" -> "FA27". */
export function nextMainTerm(term) {
  const [, season, year] = term.match(TERM);
  if (season === "FA") return `SP${String(Number(year) + 1).padStart(2, "0")}`;
  if (season === "WI") return `SP${year}`;
  return `FA${year}`;
}

/** The Fall or Spring before a term (summer is skipped): "SP27" -> "FA26", "FA27" -> "SP27". */
export function previousMainTerm(term) {
  const [, season, year] = term.match(TERM);
  if (season === "SP" || season === "WI") return `FA${String(Number(year) - 1).padStart(2, "0")}`;
  return `SP${year}`;
}

/** Spring, Summer and Fall terms from `back` years before `term` to `ahead` years after, in order. */
export function termsAround(term, back = 4, ahead = 4) {
  const year = Number(term.match(TERM)[2]);
  const terms = [];
  for (let y = year - back; y <= year + ahead; y++) {
    const yy = String(y).padStart(2, "0");
    terms.push(`SP${yy}`, `SU${yy}`, `FA${yy}`);
  }
  return terms;
}

/**
 * Courses done before a term: taken ones with no term or an earlier one, and planned ones
 * in an earlier term. `courses` is [{ id, status, term }].
 */
export function doneBefore(courses, term) {
  const order = termOrder(term);
  return new Set(
    courses
      .filter((course) =>
        course.status === "taken"
          ? !course.term || termOrder(course.term) < order
          : course.term && termOrder(course.term) < order,
      )
      .map((course) => course.id),
  );
}

/**
 * What counts toward a course's prerequisites in a semester: `before`, the courses done before
 * it (see doneBefore), and `same`, the other courses in that same semester (they meet
 * "concurrent registration" prerequisites). With no term, everything else in the plan is before.
 */
export function doneBy(courses, term, exceptId = null) {
  const others = courses.filter((course) => course.id !== exceptId);
  if (!term) return { before: new Set(others.map((course) => course.id)), same: new Set() };
  return {
    before: doneBefore(others, term),
    same: new Set(others.filter((course) => course.term === term).map((course) => course.id)),
  };
}

/**
 * The semesters the plan shows: four years of Fall and Spring from Fall 2026 (or from the
 * earliest semester you have a course in), stretched to any later course, plus any
 * summer or winter you have courses in.
 */
export function planSemesters(usedTerms, startTerm, years = 4) {
  const used = usedTerms.filter((term) => termOrder(term) !== Infinity);
  const earliest = [startTerm, ...used].sort((a, b) => termOrder(a) - termOrder(b))[0];
  const latest = Math.max(...used.map(termOrder), -Infinity);
  const shown = new Set(used);
  let term = /^(FA|SP)/.test(earliest) ? earliest : nextMainTerm(earliest);
  for (let count = 0; count < years * 2 || termOrder(term) <= latest; count++) {
    shown.add(term);
    term = nextMainTerm(term);
  }
  return [...shown].sort((a, b) => termOrder(a) - termOrder(b));
}

/** "Spring 2027" -> "SP27"; anything else -> null. */
export function termFromLabel(label) {
  const match = String(label ?? "").match(/^(Winter|Spring|Summer|Fall) 20(\d\d)$/);
  if (!match) return null;
  const season = Object.entries(SEASONS).find(([, name]) => name === match[1])[0];
  return `${season}${match[2]}`;
}

/** A term as the database writes it ("Fall 2026"), in the page's language. Other text comes back as it is. */
export function termText(label) {
  const term = termFromLabel(label);
  return term ? termLabel(term) : label;
}

/** How a course's newest offered term reads now: "offered next", "offered now" or "last offered". */
export function offeredLabel(label, today = currentTerm()) {
  const term = termFromLabel(label);
  if (!term) return tr("last offered", "最近开课");
  const difference = termOrder(term) - termOrder(today);
  if (difference > 0) return tr("offered next", "下次开课");
  return difference === 0 ? tr("offered now", "本学期开课") : tr("last offered", "最近开课");
}
