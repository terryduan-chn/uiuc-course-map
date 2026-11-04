// The major you chose, and the focus area picked on a program, saved in this browser. Planning
// from it is what students with no audit use in place of Auto-plan's audit.

import { planDegree } from "./degree-plan.js";
import { myCourses } from "./my-courses.js";
import { nextTerm } from "./plan-controls.js";
import { degreeHours } from "./programs.js";
import { candidateLookup, courseFacts } from "./requirement-courses.js";

const STORAGE_KEY = "myMajor";
const PROGRAM_PATH = /^[a-z0-9_/-]{1,200}$/;

/** Reads what's saved, keeping only well-formed values (the browser's data can't be trusted). */
function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    const focusEntries = Object.entries(saved?.focus ?? {}).filter(
      ([path, name]) => PROGRAM_PATH.test(path) && typeof name === "string",
    );
    return { path: PROGRAM_PATH.test(saved?.path) ? saved.path : null, focus: Object.fromEntries(focusEntries) };
  } catch {
    return { path: null, focus: {} };
  }
}

const saved = load();

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
  } catch {
    // Not saved (storage blocked), but the choice still holds for this visit.
  }
}

export const myMajor = {
  /** The chosen program's path, or null. */
  path: () => saved.path,

  /** Chooses a program (null for none). */
  set(path) {
    saved.path = path;
    save();
  },

  /** The focus area picked on a program, or null. */
  focus: (path) => saved.focus[path] ?? null,

  /** Picks a program's focus area (null for none). */
  setFocus(path, name) {
    if (name) saved.focus[path] = name;
    else delete saved.focus[path];
    save();
  },
};

/** A program's name, requirements and hours to graduate (its major's, if the page states none), or null. */
export function programDetails(rows, path) {
  const [program] = rows("SELECT path, name, parent, total_hours, requirements FROM programs WHERE path = :path", {
    ":path": path,
  });
  if (!program) return null;
  const [parent] = program.parent
    ? rows("SELECT total_hours FROM programs WHERE path = :path", { ":path": program.parent })
    : [];
  return {
    path: program.path,
    name: program.name,
    blocks: JSON.parse(program.requirements),
    totalHours: degreeHours(program.total_hours) ?? degreeHours(parent?.total_hours),
  };
}

/**
 * Plans a program to graduation and puts it in My plan in place of what was generated before.
 * The student's own courses and slots stay. Returns what the plan did.
 */
export function planProgram({ rows, graph, path }) {
  const { blocks, totalHours } = programDetails(rows, path);
  const facts = courseFacts(rows);
  const taken = new Set(myCourses.ids("taken"));
  const result = planDegree({
    blocks,
    totalHours,
    focus: myMajor.focus(path),
    takenHours: [...taken].reduce((sum, id) => sum + (myCourses.hours(id) ?? facts.get(id)?.hours ?? 0), 0),
    candidates: candidateLookup(rows),
    facts,
    graph,
    taken,
    planned: myCourses
      .ids("planned")
      .filter((id) => !myCourses.isAuto(id))
      .map((id) => ({ id, term: myCourses.term(id) })),
    startTerm: nextTerm(),
    slots: myCourses.slots().filter((slot) => !slot.auto),
  });
  myCourses.replaceAuto(result.courses, result.scheduled, result.slots);
  return result;
}
