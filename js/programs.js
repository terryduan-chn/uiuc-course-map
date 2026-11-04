// Majors and concentrations: finding one, and checking its requirements against your courses.
// No DOM or database code here, so the tests can use it. Blocks and rows are described in
// scripts/catalog-programs.js.

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

/**
 * The courses a program requires that aren't in the plan yet, as { id, reason }, reason being the
 * section they're for; and `menus`, how many lists to pick from were left out. A menu runs from
 * "select one of the following" to the next header, and a heading like "Technical Electives"
 * makes its whole table one. An "or" line takes the option closest to done, else the first.
 */
export function requiredCourses(blocks, statusOf) {
  const courses = new Map();
  let heading = "Requirements";
  let menus = 0;
  for (const block of blocks) {
    if (block.heading) heading = block.heading;
    if (!block.rows) continue;
    const allMenu = MENU_WORDS.test(heading);
    let inMenu = allMenu;
    let counted = false;
    for (const row of block.rows) {
      if (row.type !== "course") {
        // A short line introduces a list; a long note may only mention electives in passing.
        const startsMenu = MENU_WORDS.test(row.text) && (row.text.length <= MENU_LINE_LENGTH || row.text.endsWith(":"));
        if (row.type === "header" || startsMenu) {
          inMenu = allMenu || startsMenu;
          counted = allMenu && counted;
        }
      } else if (inMenu) {
        if (!counted) menus += 1;
        counted = true;
      } else if (!rowStatus(row, statusOf)) {
        const inPlan = (option) => option.filter(statusOf).length;
        const best = row.options.reduce((closest, option) => (inPlan(option) > inPlan(closest) ? option : closest));
        for (const id of best) {
          if (!statusOf(id) && !courses.has(id)) courses.set(id, heading);
        }
      }
    }
  }
  return { courses: [...courses].map(([id, reason]) => ({ id, reason })), menus };
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
