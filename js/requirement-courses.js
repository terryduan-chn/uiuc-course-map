// Database lookups for degree requirements: which courses can meet a requirement, and the
// facts the planner needs about every course (hours, GPA, seasons offered, Gen Eds).

import { genEdCodesFor, matchesPattern } from "./audit-reader.js";
import { creditHours } from "./search.js";

/**
 * The courses that can meet an audit requirement part, as [id, title] pairs: the courses its
 * "select from" list names (minus its "not from" list), or, for a Gen Ed requirement the
 * audit lists no courses for, every course with that Gen Ed, highest average GPA first
 * (only the first `genEdLimit` of them, if given). "Any 400-level course" isn't listed.
 */
export function requirementCourses(rows, part, { genEdLimit } = {}) {
  const genEds = part.selectFrom.length === 0 ? genEdCodesFor(part.title) : [];
  if (genEds.length > 0) {
    const params = Object.fromEntries(genEds.map((code, i) => [`:code${i}`, code]));
    return rows(
      `SELECT DISTINCT courses.subject || ' ' || courses.number AS id, courses.title, course_grades.average_gpa AS gpa
       FROM gen_eds
       JOIN courses ON courses.subject = gen_eds.subject AND courses.number = gen_eds.number
       LEFT JOIN course_grades ON course_grades.subject = courses.subject AND course_grades.number = courses.number
       WHERE gen_eds.code IN (${genEds.map((_, i) => `:code${i}`).join(", ")})
       ORDER BY gpa IS NULL, gpa DESC, id
       ${genEdLimit ? `LIMIT ${Number(genEdLimit)}` : ""}`,
      params,
    ).map((course) => [course.id, course.title]);
  }
  const found = new Map();
  // "CS 397, any 400-level course" (Advanced Electives): any subject counts, but the courses the
  // requirement has in mind are the ones in the subjects it names, so those are looked up.
  const named = [...new Set(part.selectFrom.map((pattern) => pattern.subject).filter((subject) => subject !== "*"))];
  const patterns = part.selectFrom.flatMap((pattern) =>
    pattern.subject === "*" ? named.map((subject) => ({ ...pattern, subject })) : [pattern],
  );
  for (const pattern of patterns) {
    const matches = rows(
      `SELECT subject || ' ' || number AS id, title FROM courses
       WHERE subject = :subject AND number LIKE :number ORDER BY number`,
      { ":subject": pattern.subject, ":number": `${pattern.number}%` },
    );
    for (const course of matches) found.set(course.id, course.title);
  }
  for (const id of found.keys()) {
    if (part.notFrom.some((pattern) => matchesPattern(id, pattern))) found.delete(id);
  }
  return [...found];
}

/**
 * What the planner needs to know about every course, by id: { hours, gpa, offered, seasons, genEds }.
 * `offered` is whether it ran in any term the import searched (since Spring 2024); `seasons` holds
 * "FA" and/or "SP" when it ran in those (empty: only summer or winter).
 */
export function loadCourseFacts(rows) {
  const facts = new Map();
  for (const course of rows("SELECT subject || ' ' || number AS id, credit_hours FROM courses")) {
    facts.set(course.id, {
      hours: creditHours(course.credit_hours),
      gpa: null,
      offered: false,
      seasons: new Set(),
      genEds: new Set(),
    });
  }
  for (const grade of rows("SELECT subject || ' ' || number AS id, average_gpa FROM course_grades")) {
    const fact = facts.get(grade.id);
    if (fact) fact.gpa = grade.average_gpa;
  }
  for (const offering of rows("SELECT subject || ' ' || number AS id, term FROM terms_offered")) {
    const fact = facts.get(offering.id);
    if (!fact) continue;
    fact.offered = true;
    if (offering.term.startsWith("Fall")) fact.seasons.add("FA");
    if (offering.term.startsWith("Spring")) fact.seasons.add("SP");
  }
  for (const genEd of rows("SELECT subject || ' ' || number AS id, code FROM gen_eds")) {
    facts.get(genEd.id)?.genEds.add(genEd.code);
  }
  return facts;
}

let cachedFacts = null;
/** loadCourseFacts, read from the database once per visit (the data doesn't change while the page is open). */
export function courseFacts(rows) {
  cachedFacts ??= loadCourseFacts(rows);
  return cachedFacts;
}
