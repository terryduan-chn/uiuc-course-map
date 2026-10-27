// Reads a uAchieve degree audit (the "Audit Results" page saved as a PDF) into a checklist.
// No DOM code here: it works on the PDF's text lines, so the tests can run it in Node.
// It keeps only requirements and course codes, never the student's name or ID.

const SECTION_INDENT = 104; // requirement titles and their EARNED/NEEDS lines start left of this
const COURSE_LINE =
  /^(FA|SP|SU|WI)(\d\d)\s+([A-Z]{2,5})\s+(\d{3}|\d--)\s+\S+\s+(\d+\.\d)\s+([A-Z]{1,2}[+-]?)(?:\s+>(\S))?/;
const NUMBERED = /^(\d+|OR)\)\s+(.+)$/;
const COURSE_ID = /^[A-Z]{2,5} \d{3}$/;
// What the browser prints on every page: "2026/9/17 09:26 My Audit - Audit Results Tab" at the
// top, and the page's address (with the audit's job id) and "1/5" at the bottom.
const PAGE_HEADER = /^\d{4}\/\d{1,2}\/\d{1,2},? \d{1,2}:\d\d/;
const PAGE_FOOTER = /^https?:\/\/\S+ \d+\/\d+$/;

/**
 * Text lines from pdf.js text items ({ str, transform }), one array of items per page:
 * items at the same height are joined left to right into { x, text }, pages top to bottom.
 */
export function linesFromPages(pages) {
  const lines = [];
  for (const items of pages) {
    const rows = [];
    for (const item of items) {
      if (!item.str.trim()) continue;
      const [x, y] = [item.transform[4], item.transform[5]];
      let row = rows.find((r) => Math.abs(r.y - y) <= 2);
      if (!row) rows.push((row = { y, items: [] }));
      row.items.push({ x, str: item.str });
    }
    for (const row of rows.sort((a, b) => b.y - a.y)) {
      row.items.sort((a, b) => a.x - b.x);
      lines.push({ x: row.items[0].x, text: row.items.map((item) => item.str.trim()).join(" ") });
    }
  }
  return lines;
}

/** Gen Ed requirements the audit names without a course list, as Gen Ed codes in the database. */
const GEN_ED_TITLES = [
  [/HUMANITIES/, ["1HP", "1LA"]],
  [/SOCIAL & BEHAVIORAL/, ["1BSC", "1SS"]],
  [/NATURAL SCIENCE/, ["1LS", "1PS"]],
  [/WESTERN\/COMPARATIVE/, ["1WCC"]],
  [/NON-WESTERN/, ["1NW"]],
  [/MINORITY/, ["1US"]],
  [/ADVANCED COMPOSITION/, ["1CLL"]],
  [/QUANTITATIVE REASONING II/, ["1QR2"]],
  [/QUANTITATIVE REASONING/, ["1QR1", "1QR2"]],
];

/** Gen Ed codes for a requirement title such as "NON-WESTERN CULTURES", or []. */
export function genEdCodesFor(title) {
  return GEN_ED_TITLES.find(([pattern]) => pattern.test(title))?.[1] ?? [];
}

/**
 * Course lists as the audit writes them, "CS 128 , 173 OR 341" or "CS 4" or "***** 4 , 5",
 * as patterns: { subject, number } where a number shorter than 3 digits is a prefix
 * ("4" = any 400-level) and subject "*" means any subject.
 */
export function parseCourseList(text) {
  const patterns = [];
  let subject = null;
  for (const token of text.split(/[\s,]+/)) {
    if (token === "" || token === "OR" || token === "AND") continue;
    if (/^\*+$/.test(token)) subject = "*";
    else if (/^[A-Z]{2,5}$/.test(token)) subject = token;
    else if (/^\d{1,3}$/.test(token) && subject) patterns.push({ subject, number: token });
  }
  return patterns;
}

/** Whether a course id ("CS 425") fits a pattern. */
export function matchesPattern(id, { subject, number }) {
  const [courseSubject, courseNumber] = id.split(" ");
  return (subject === "*" || subject === courseSubject) && courseNumber.startsWith(number);
}

/** "CS 225", "any CS 400-level course", "any 500-level course". */
export function describePattern({ subject, number }) {
  if (number.length === 3) return `${subject} ${number}`;
  const level = `${number.padEnd(3, "0")}-level`;
  return subject === "*" ? `any ${level} course` : `any ${subject} ${level} course`;
}

/** "NEEDS: 15.0 HOURS 5 COURSES" -> { hours: 15, courses: 5 }. */
function parseNeeds(text) {
  const needs = {};
  for (const [, amount, unit] of text.matchAll(/(\d+(?:\.\d+)?)\s+(HOURS?|COURSES?|SUB-GROUPS?)/g)) {
    if (unit.startsWith("HOUR")) needs.hours = Number(amount);
    else if (unit.startsWith("COURSE")) needs.courses = Number(amount);
    else needs.groups = Number(amount);
  }
  return needs;
}

/** A requirement title: capitals only ("PHYSICS SEQUENCE", "45 HOURS OF UIUC COURSEWORK"). */
function isTitle(text) {
  return (
    /^[A-Z0-9]/.test(text) &&
    !/[a-z]/.test(text) &&
    !/[.:]$|=/.test(text) &&
    !/^(NEEDS|EARNED|SELECT FROM|IN-PROGRESS)\b|HOURS? (ADDED|TAKEN)|^(FA|SP|SU|WI)\d\d |^\d+\.\d/.test(text)
  );
}

const newPart = (label, title) => ({ label, title, needs: null, selectFrom: [], notFrom: [], courses: [], notes: [] });

/**
 * Turns the audit's text lines ({ x, text }, top to bottom) into
 * { programName, program, catalogYear, preparedOn, sections, courses }.
 * Each section: { title, needs, notes, parts }; each part: { label, title, needs, selectFrom, notFrom, courses, notes }.
 * `courses` is every course in the summary of courses taken: { id, term, hours, grade, inProgress }.
 */
export function readAudit(lines) {
  const audit = { programName: null, program: null, catalogYear: null, preparedOn: null, sections: [], courses: [] };
  let section = null;
  let part = null;
  let listKind = null; // "selectFrom" or "notFrom" while a course list runs onto the next line
  let started = false;
  let previousText = "";

  for (const { x, text: raw } of lines) {
    const text = raw.trim().replace(/\s+/g, " ");
    if (!text || PAGE_HEADER.test(text) || PAGE_FOOTER.test(text)) continue;

    const program = text.match(/Program Code (.+?) Catalog Year (\d{6})/);
    if (program) {
      audit.program = program[1].trim();
      audit.catalogYear = program[2];
    }
    const prepared = text.match(/^Prepared On (\d\d\/\d\d\/\d{4})/);
    if (prepared) {
      audit.preparedOn = prepared[1];
      audit.programName = previousText; // the program's name sits just above (the student's name above that)
    }
    previousText = text;
    if (/LEGEND/.test(text)) break;
    if (/^SUMMARY OF COURSES/.test(text)) started = true;
    if (!started) continue;

    // A course list carried over from the line before: "CS 522 , 524 , 526".
    if (listKind && /^[A-Z*]{2,5} \d/.test(text) && part) {
      part[listKind].push(...parseCourseList(text));
      continue;
    }
    listKind = null;

    const course = text.match(COURSE_LINE);
    if (course) {
      const [, term, year, subject, number, hours, grade, flag] = course;
      const entry = {
        id: `${subject} ${number}`,
        term: `${term}${year}`,
        hours: Number(hours),
        grade,
        inProgress: grade === "IP" || flag === "I",
      };
      if (section?.title === "SUMMARY OF COURSES TAKEN") audit.courses.push(entry);
      else if (part) part.courses.push(entry.id);
      else section?.courses.push(entry.id);
      continue;
    }

    if (x < SECTION_INDENT && isTitle(text) && !NUMBERED.test(text)) {
      section = { title: text, needs: null, earned: null, notes: [], parts: [], courses: [] };
      audit.sections.push(section);
      part = null;
      continue;
    }
    if (!section) continue;

    const numbered = text.match(NUMBERED);
    const needs = text.match(/^NEEDS:\s*(.*)$/);
    const earned = text.match(/^EARNED:\s*(.*)$/);
    const select = text.match(/^SELECT FROM:\s*(.*)$/);
    const notFrom = text.match(/^-- NOT FROM:\s*(.*)$/);
    if (numbered) {
      part = newPart(numbered[1], numbered[2]);
      section.parts.push(part);
    } else if (needs && x < SECTION_INDENT) {
      section.needs = parseNeeds(needs[1]);
    } else if (earned && x < SECTION_INDENT) {
      section.earned = parseNeeds(earned[1]); // "EARNED: 58.0 HOURS" -> { hours: 58 }
    } else if (needs || select || notFrom) {
      // A requirement with no numbered parts ("ADVANCED COMPOSITION") gets one part of its own.
      if (!part) {
        part = newPart(null, section.title);
        section.parts.push(part);
      }
      if (needs) part.needs = parseNeeds(needs[1]);
      else {
        listKind = select ? "selectFrom" : "notFrom";
        part[listKind].push(...parseCourseList((select ?? notFrom)[1]));
      }
    } else if (isTitle(text) && !text.startsWith("(") && (!part || part.label === null)) {
      // An unnumbered sub-requirement, like "ADVANCED HOURS" under residency.
      part = newPart(null, text);
      section.parts.push(part);
    } else if (/[A-Za-z]/.test(text) && !/^EARNED:|^IN-PROGRESS|HOURS? (ADDED|TAKEN)|^\(\s*\d/.test(text)) {
      (part ?? section).notes.push(text);
    }
  }

  // The course summaries are lists, not requirements.
  audit.sections = audit.sections.filter((s) => !s.title.startsWith("SUMMARY OF COURSES"));
  return audit;
}

/** A part is unmet while the audit still says what it needs or lists courses to pick from. */
export function partIsMet(part) {
  return !part.needs && part.selectFrom.length === 0;
}

/**
 * The parts of a section grouped into choices: "1)", "2)" each stand alone,
 * and an "OR)" part joins the one before it (pick any one of the group).
 */
export function partGroups(section) {
  const groups = [];
  for (const part of section.parts) {
    if (part.label === "OR" && groups.length > 0) groups.at(-1).push(part);
    else groups.push([part]);
  }
  return groups;
}

export function sectionIsMet(section) {
  return !section.needs && partGroups(section).every((group) => group.some(partIsMet));
}

/** Sections worth showing: requirements, not GPA lines or the leftover-credit list. */
export function requirementSections(audit) {
  return audit.sections.filter(
    (s) =>
      !/GPA|^CREDIT /.test(s.title) && (s.needs || s.parts.length > 0 || s.courses.length > 0 || s.notes.length > 0),
  );
}

/**
 * Each taken course's term (the latest, if repeated), the hours the audit credits it with
 * (which can differ from the catalog's), and how it was earned (see courseKind):
 * { "RHET 105": { term: "FA26", hours: 4, kind: "credit" } }.
 */
export function takenCourseDetails(audit) {
  const details = {};
  for (const course of audit.courses) {
    if (!COURSE_ID.test(course.id)) continue;
    const before = details[course.id]?.hours ?? 0; // a course listed twice (split credit) adds up
    details[course.id] = {
      term: course.term, // the summary lists terms in order, so the latest wins
      hours: before + course.hours,
      kind: courseKind(course.grade, course.inProgress),
    };
  }
  return details;
}

/**
 * How a course on the audit was earned: "registered" (in progress this semester), "credit"
 * (proficiency, transfer or high-school credit: PS, TR, CR, HS), or null for a graded course.
 */
export function courseKind(grade, inProgress) {
  if (inProgress) return "registered";
  if (["PS", "TR", "CR", "HS"].includes(grade)) return "credit";
  return null;
}

/** Course ids from the audit to mark as taken: real courses only (no "ECON 1--" transfer credit). */
export function takenCourseIds(audit) {
  return [...new Set(audit.courses.map((course) => course.id).filter((id) => COURSE_ID.test(id)))].sort();
}

/** "1 course", "6 hours", "15 hours (5 courses)". */
export function describeNeeds(needs) {
  if (!needs) return "";
  const pieces = [];
  if (needs.hours) pieces.push(`${needs.hours} ${needs.hours === 1 ? "hour" : "hours"}`);
  if (needs.courses) pieces.push(`${needs.courses} ${needs.courses === 1 ? "course" : "courses"}`);
  if (needs.groups && pieces.length === 0) pieces.push(`${needs.groups} more ${needs.groups === 1 ? "part" : "parts"}`);
  return pieces.length === 2 ? `${pieces[0]} (${pieces[1]})` : pieces.join("");
}

/** "202608" -> "Fall 2026". */
export function catalogYearLabel(code) {
  const match = String(code ?? "").match(/^(\d{4})(\d\d)$/);
  if (!match) return "";
  const month = Number(match[2]);
  const term = month <= 4 ? "Spring" : month <= 7 ? "Summer" : "Fall";
  return `${term} ${match[1]}`;
}

/** "COMPUTER SCIENCE CORE REQUIREMENTS" -> "Computer Science Core Requirements" (short words kept small). */
export function titleCase(text) {
  const small = new Set(["AND", "OR", "OF", "THE", "TO", "FROM", "IN", "FOR"]);
  return text
    .split(" ")
    .map((word, i) => {
      if (/^(U\.S\.|UIUC|CS|GPA|BS)$/.test(word)) return word;
      if (i > 0 && small.has(word)) return word.toLowerCase();
      return word.charAt(0) + word.slice(1).toLowerCase();
    })
    .join(" ");
}
