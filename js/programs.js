// Majors and concentrations: finding one, and checking its requirements against your courses.
// No DOM or database code here, so the tests can use it. Blocks and rows are described in
// scripts/catalog-programs.js.

const FEWEST_DEGREE_HOURS = 100; // a smaller "total" on a catalog page is one table's, not the degree's

/** The hours a program takes to graduate, or null if the catalog page doesn't really say. */
export const degreeHours = (total) => (total >= FEWEST_DEGREE_HOURS ? total : null);

/** Whether a requirement row is "taken", "planned" or null: the best of its options, each needing all its courses. */
export function rowStatus(row, statusOf) {
  const states = row.options.map((courses) => {
    const each = courses.map(statusOf);
    if (each.every((status) => status === "taken")) return "taken";
    return each.every(Boolean) ? "planned" : null;
  });
  return states.includes("taken") ? "taken" : states.includes("planned") ? "planned" : null;
}

// Catalog wording that starts a list to pick from, rather than courses everyone takes.
const MENU_WORDS =
  /\b(select|choose|choice|options?|electives?|one of|two of|following|at least|minimum of|from the)\b/i;

const MENU_LINE_LENGTH = 80;
const MOST_OF_A_LIST = 0.8; // a line stating less than this share of its rows' hours is a list to pick from

/** Whether a line starts a list to pick from. A long note may only mention electives in passing. */
const startsMenu = (row) =>
  MENU_WORDS.test(row.text) && (row.text.length <= MENU_LINE_LENGTH || row.text.endsWith(":"));

/** Whether a line asks for less than the rows under it: "Three (3) Supporting Courses" above 79 courses. */
function asksForFewer({ intro, rows }) {
  if (!intro || rows.length < 2) return false;
  const count = /\bcourses?\b/i.test(intro.text) ? countIn(intro.text) : null;
  if (count && count < rows.length) return true;
  const stated = hoursIn(intro.hours);
  const listed = rows.reduce((sum, row) => sum + (hoursIn(row.hours) ?? 0), 0);
  return Boolean(stated) && stated < listed * MOST_OF_A_LIST;
}

/**
 * A program's tables cut into runs of course rows, as { heading, block, intro, rows, menu, allMenu }.
 * `intro` is the line above the run. A run is a menu, a list to pick from, when that line says so
 * ("select one of the following") or asks for fewer courses than it lists, and a heading like
 * "Technical Electives" makes a whole table menus.
 */
export function requirementRuns(blocks) {
  const runs = [];
  let heading = "Requirements";
  for (const block of blocks) {
    if (block.heading) heading = block.heading;
    if (!block.rows) continue;
    const allMenu = MENU_WORDS.test(heading);
    let run = { heading, block, intro: null, rows: [], menu: allMenu, allMenu };
    runs.push(run);
    for (const row of block.rows) {
      if (row.type === "course") run.rows.push(row);
      else if (row.type === "header" || startsMenu(row)) {
        run = { heading, block, intro: row, rows: [], menu: allMenu || startsMenu(row), allMenu };
        runs.push(run);
      }
    }
  }
  for (const run of runs) run.menu ||= asksForFewer(run);
  return runs;
}

/**
 * The courses a program requires that aren't in the plan yet, as { id, reason }, reason being the
 * section they're for; and `menus`, how many lists to pick from were left out. An "or" line takes
 * the option closest to done, else the first.
 */
export function requiredCourses(blocks, statusOf) {
  const courses = new Map();
  const menus = new Set();
  for (const run of requirementRuns(blocks)) {
    if (run.menu) {
      if (run.rows.length > 0) menus.add(run.allMenu ? run.block : run);
      continue;
    }
    for (const row of run.rows.filter((candidate) => !rowStatus(candidate, statusOf))) {
      const inPlan = (option) => option.filter(statusOf).length;
      const best = row.options.reduce((closest, option) => (inPlan(option) > inPlan(closest) ? option : closest));
      for (const id of best) {
        if (!statusOf(id) && !courses.has(id)) courses.set(id, run.heading);
      }
    }
  }
  return { courses: [...courses].map(([id, reason]) => ({ id, reason })), menus: menus.size };
}

const COUNT_WORDS = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

/** The number a line asks for: "two of", "(6) six", "3 courses"; or null. */
export function countIn(text) {
  const digits = text.match(/\((\d+)\)|\b(\d+)\s+(?:additional\s+)?courses?\b/i);
  if (digits) return Number(digits[1] ?? digits[2]);
  const word = text.match(new RegExp(`\\b(${COUNT_WORDS.join("|")})\\b`, "i"));
  return word ? COUNT_WORDS.indexOf(word[1].toLowerCase()) + 1 : null;
}

/** The first whole number in a catalog hours cell ("3 or 4", "24-25"), or null. */
export function hoursIn(text) {
  const found = String(text ?? "").match(/\d+/);
  return found ? Number(found[0]) : null;
}

/**
 * The lists a program says to pick one focus area from, as { name, need, rows, header }: the
 * headers ending in ":" after a line like "chosen from a single focus area". [] for most programs.
 */
export function focusAreas(blocks) {
  for (const block of blocks) {
    const rows = block.rows ?? [];
    const start = rows.findIndex((row) => row.type === "header" && /single focus area/i.test(row.text));
    if (start < 0) continue;
    const areas = [];
    for (const row of rows.slice(start + 1)) {
      if (row.type === "header" && row.text.endsWith(":")) {
        areas.push({ name: row.text.slice(0, -1).trim(), need: countIn(rows[start].text) ?? 1, rows: [], header: row });
      } else if (row.type === "course") areas.at(-1)?.rows.push(row);
    }
    return areas;
  }
  return [];
}

/** How many of a program's listed course rows are taken and planned, of how many. */
export function programProgress(blocks, statusOf) {
  const rows = blocks.flatMap((block) => block.rows ?? []).filter((row) => row.type === "course");
  const count = (status) => rows.filter((row) => rowStatus(row, statusOf) === status).length;
  return { taken: count("taken"), planned: count("planned"), listed: rows.length };
}

/**
 * The majors matching what was typed, in order, each with its concentrations: by the major's
 * name, or the name of one of its concentrations.
 */
export function filterPrograms(programs, query) {
  const typed = query.trim().toLowerCase();
  const concentrationsOf = (major) => programs.filter((program) => program.parent === major.path);
  return programs
    .filter((program) => !program.parent)
    .map((major) => ({ ...major, concentrations: concentrationsOf(major) }))
    .filter((major) => [major, ...major.concentrations].some((program) => program.name.toLowerCase().includes(typed)));
}

/** Majors in groups ({ label, majors }), groups and majors in dictionary order. */
function grouped(majors, labelOf) {
  const inOrder = (a, b) => a.localeCompare(b, "en", { sensitivity: "base" });
  const groups = new Map();
  for (const major of [...majors].sort((a, b) => inOrder(a.name, b.name))) {
    const label = labelOf(major);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(major);
  }
  return [...groups].sort(([a], [b]) => inOrder(a, b)).map(([label, members]) => ({ label, majors: members }));
}

export const byCollege = (majors) => grouped(majors, (major) => major.college);

export const byLetter = (majors) =>
  grouped(majors, (major) => {
    const letter = major.name[0].toUpperCase();
    return /[A-Z]/.test(letter) ? letter : "#";
  });
