// Search and text helpers shared by the page and the tests. No DOM code here.

export const MAX_RESULTS = 60;

function escapeLike(text) {
  return text.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/**
 * SQL that finds courses matching what the user typed: a code such as
 * "CS 225", "cs225" or "225", or words from a title such as "linear algebra".
 * Exact code matches come first.
 */
export function buildSearchQuery(input) {
  const words = input.trim().replace(/\s+/g, " ");
  const compact = escapeLike(words.replace(/ /g, "").toUpperCase());
  const titleWords = escapeLike(words);

  // Lower rank = shown first. Ties go by subject, then number.
  const sql = `
    SELECT subject, number, title,
      CASE
        WHEN subject || number = :exact THEN 0
        WHEN subject = :exact THEN 1
        WHEN subject || number LIKE :code ESCAPE '\\' THEN 2
        WHEN subjects.name LIKE :namePrefix ESCAPE '\\' THEN 3
        WHEN title LIKE :titlePrefix ESCAPE '\\' THEN 4
        WHEN ' ' || title LIKE :titleWord ESCAPE '\\' THEN 5
        WHEN number LIKE :code ESCAPE '\\' THEN 6
        ELSE 7
      END AS rank
    FROM courses JOIN subjects ON subjects.code = courses.subject
    WHERE subject || number LIKE :code ESCAPE '\\'
       OR number LIKE :code ESCAPE '\\'
       OR subjects.name LIKE :namePrefix ESCAPE '\\'
       OR title LIKE :title ESCAPE '\\'
    ORDER BY rank, subject, number
    LIMIT ${MAX_RESULTS}`;
  const params = {
    ":code": `${compact}%`,
    ":title": `%${titleWords}%`,
    ":titlePrefix": `${titleWords}%`,
    ":titleWord": `% ${titleWords}%`,
    ":namePrefix": `${titleWords}%`,
    ":exact": compact.replace(/\\/g, ""),
  };
  return { sql, params };
}

/**
 * Splits official prerequisite wording into plain text and course codes,
 * so the page can turn codes into links without rewriting the wording.
 */
export function splitCourseCodes(text) {
  const parts = [];
  const codePattern = /\b([A-Z]{2,5}) (\d{3})\b/g;
  let lastEnd = 0;
  for (const match of text.matchAll(codePattern)) {
    if (match.index > lastEnd) parts.push({ text: text.slice(lastEnd, match.index) });
    parts.push({ text: match[0], subject: match[1], number: match[2] });
    lastEnd = match.index + match[0].length;
  }
  if (lastEnd < text.length) parts.push({ text: text.slice(lastEnd) });
  return parts;
}

/**
 * What the address bar's #part asks to show:
 * ""  -> { view: "home" }, "#CS" -> { view: "subject", subject: "CS" },
 * "#CS-225" -> { view: "course", subject: "CS", number: "225" }.
 */
export function parseRoute(hash) {
  if (hash === "#plan") return { view: "plan" };
  if (hash === "#audit") return { view: "audit" };
  // "#docs" or "#docs/my-plan" (one section); the old "#help" opens the docs too.
  const docs = hash.match(/^#(?:docs|help)(?:\/([a-z0-9-]+))?$/);
  if (docs) return { view: "docs", section: docs[1] ?? null };
  // "#graph" or "#graph/CS-225" (the graph, focused on a course).
  const graph = hash.match(/^#graph(?:\/([A-Z]+)-(\d+))?$/);
  if (graph) {
    return graph[1] ? { view: "graph", subject: graph[1], number: graph[2] } : { view: "graph" };
  }
  const course = hash.match(/^#([A-Z]+)-(\d+)$/);
  if (course) return { view: "course", subject: course[1], number: course[2] };
  const subject = hash.match(/^#([A-Z]+)$/);
  if (subject) return { view: "subject", subject: subject[1] };
  return { view: "home" };
}

/**
 * Subjects matching what was typed, best first: exact code, code prefix, a word in the
 * name starting with it, then (from 3 letters on, so "cs" skips "Physics") the name
 * containing it. An empty query keeps every subject.
 * @param {{ code: string, name: string }[]} subjects in code order
 */
export function filterSubjects(subjects, query) {
  const typed = query.trim().toLowerCase();
  if (typed === "") return subjects;
  const rankOf = ({ code, name }) => {
    const lowerCode = code.toLowerCase();
    const lowerName = name.toLowerCase();
    if (lowerCode === typed) return 0;
    if (lowerCode.startsWith(typed)) return 1;
    if (` ${lowerName}`.includes(` ${typed}`)) return 2;
    // Several words, each starting a word of the name: "comp sci" -> Computer Science.
    const nameWords = lowerName.split(/[\s&,-]+/);
    if (typed.includes(" ") && typed.split(/\s+/).every((word) => nameWords.some((name) => name.startsWith(word))))
      return 2;
    if (typed.length >= 3 && lowerName.includes(typed)) return 3;
    return null;
  };
  return subjects
    .map((subject) => ({ subject, rank: rankOf(subject) }))
    .filter(({ rank }) => rank !== null)
    .sort((a, b) => a.rank - b.rank) // stable, so code order is kept within a rank
    .map(({ subject }) => subject);
}

/**
 * The first course number (in a sorted list) that starts with what was typed, or null.
 * Spaces and anything but digits are ignored, so "MATH 24" works like "24".
 */
export function findJumpTarget(numbers, typed) {
  const digits = typed.replace(/\D/g, "");
  if (digits === "") return null;
  return numbers.find((number) => number.startsWith(digits)) ?? null;
}

/** "cs225", "CS 225" or "Cs  225" -> { subject: "CS", number: "225" }; anything else -> null. */
export function parseCourseCode(text) {
  const match = text.trim().match(/^([A-Za-z]{2,5})\s*(\d{3})$/);
  return match ? { subject: match[1].toUpperCase(), number: match[2] } : null;
}

/** How a requirement group reads: "Required", "Choose 1 of 3", "Choose 2 of 3". */
export function requirementLabel(required, total) {
  if (total === 1) return "Required";
  return `Choose ${required} of ${total}`;
}

/** "3 hours" -> 3, "3 OR 4 hours" -> 3, "" -> 0 (the smallest number the catalog gives). */
export function creditHours(text) {
  const match = String(text ?? "").match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : 0;
}

/** The catalog's credit hours, read naturally: "1 hours" -> "1 hour", "3 OR 4 hours" -> "3 or 4 hours". */
export function formatCreditHours(text) {
  const words = String(text ?? "")
    .trim()
    .replace(/\b(OR|TO)\b/g, (word) => word.toLowerCase());
  return words.replace(/^1 hours$/, "1 hour");
}

/** "225" -> "200-level", "598" -> "500-level". */
export function courseLevel(number) {
  return `${number[0]}00-level`;
}

/** The description without its closing "Prerequisite: ..." sentence, which is shown separately. */
export function descriptionWithoutPrerequisite(description) {
  return description.replace(/\s*Prerequisites?:[\s\S]*$/, "").trim();
}

/** Course Explorer's page for a course, from the catalog XML address we stored. */
export function courseExplorerPage(sourceUrl) {
  return sourceUrl.replace("/cisapp/explorer/catalog/", "/schedule/").replace(/\.xml$/, "");
}

// ---- Gen Ed requirements ----

/** A short colored tag and a color for each Gen Ed category, used in the Gen Ed menu. */
export const GEN_ED_CATEGORIES = {
  "Humanities & the Arts": { tag: "HUM", hue: 330 },
  "Cultural Studies": { tag: "CULT", hue: 30 },
  "Natural Sciences & Technology": { tag: "NAT", hue: 140 },
  "Quantitative Reasoning": { tag: "QR", hue: 200 },
  "Social & Behavioral Sciences": { tag: "SBS", hue: 270 },
  "Advanced Composition": { tag: "COMP", hue: 50 },
  "Composition I": { tag: "COMP", hue: 50 },
};
export const GEN_ED_MAX_RESULTS = 400;

/**
 * The short name of a Gen Ed requirement for buttons:
 * "Humanities – Lit & Arts" -> "Lit & Arts", "Quantitative Reasoning II" -> "QR II".
 */
export function genEdShortName(name) {
  const parts = name.split(/\s+[–-]\s+/);
  if (parts.length > 1) return parts.at(-1);
  return name.replace(/^Quantitative Reasoning\b/, "QR");
}

/**
 * Courses that meet every one of the given Gen Ed requirements (by code, e.g. "1LA"),
 * optionally narrowed by search text, highest average GPA first (courses without GPA data last).
 */
export function buildGenEdQuery(codes, text = "") {
  const params = { ":count": codes.length };
  codes.forEach((code, i) => (params[`:genEd${i}`] = code));
  const words = text.trim().replace(/\s+/g, " ");
  let textFilter = "";
  if (words) {
    textFilter = `AND (courses.subject || courses.number LIKE :code ESCAPE '\\'
                   OR courses.title LIKE :title ESCAPE '\\'
                   OR subjects.name LIKE :namePrefix ESCAPE '\\')`;
    params[":code"] = `${escapeLike(words.replace(/ /g, "").toUpperCase())}%`;
    params[":title"] = `%${escapeLike(words)}%`;
    params[":namePrefix"] = `${escapeLike(words)}%`;
  }
  const sql = `
    SELECT courses.subject, courses.number, courses.title, course_grades.average_gpa AS gpa
    FROM courses
    JOIN subjects ON subjects.code = courses.subject
    LEFT JOIN course_grades
      ON course_grades.subject = courses.subject AND course_grades.number = courses.number
    WHERE (SELECT COUNT(DISTINCT gen_eds.code) FROM gen_eds
           WHERE gen_eds.subject = courses.subject AND gen_eds.number = courses.number
             AND gen_eds.code IN (${codes.map((_, i) => `:genEd${i}`).join(", ")})) = :count
      ${textFilter}
    ORDER BY gpa IS NULL, gpa DESC, courses.subject, courses.number
    LIMIT ${GEN_ED_MAX_RESULTS}`;
  return { sql, params };
}
