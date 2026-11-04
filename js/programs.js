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
