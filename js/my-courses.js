// Your taken and planned courses, each with an optional term ("FA26"), and Gen Ed slots (a
// semester's "pick a Humanities course" placeholder), saved in this browser (no account needed).
// Every page that shows them listens for changes, so marking a course updates them all.

import { GEN_ED_SLOTS, slotKind } from "./plan-insights.js";
import { currentTerm, isTerm } from "./terms.js";

const STORAGE_KEY = "myCourses";
const SLOTS_KEY = "planSlots";
const STATUSES = new Set(["taken", "planned"]);
const KINDS = new Set(["registered", "credit"]);
const COURSE_ID = /^[A-Z]{2,5} \d{3}$/;
const SLOT_ID = /^slot-\d{1,9}$/;
const SLOT_KINDS = new Set(GEN_ED_SLOTS.map((slot) => slot.key));

/**
 * A saved course: its status, term ("FA26" or null), hours credited (from an audit, else null),
 * how it was earned (kind: "registered" this semester, or "credit" from tests/transfer), and,
 * for a planned course, why it's there: the requirement Auto-plan added it for (with auto: true),
 * or the Gen Ed slots it was picked to fill (fills: ["HUM", "US"], and the first one's name as reason).
 */
function entry(status, term, hours, { auto = false, reason = null, kind = null, fills = null } = {}) {
  const saved = {
    status,
    term: isTerm(term) ? term : null,
    hours: Number.isFinite(hours) && hours >= 0 && hours <= 30 ? hours : null,
  };
  if (status === "taken" && KINDS.has(kind)) saved.kind = kind;
  if (status === "planned") {
    if (auto === true) saved.auto = true;
    if (typeof reason === "string" && reason) saved.reason = reason.slice(0, 120);
    const kinds = Array.isArray(fills) ? [...new Set(fills.filter((fill) => SLOT_KINDS.has(fill)))] : [];
    if (kinds.length > 0) saved.fills = kinds;
  }
  return saved;
}

/** A Gen Ed slot: which Gen Ed it's for, its term, and whether Auto-plan added it (and why). */
function slotEntry({ kind, also = [], term, auto = false, reason = null }) {
  return {
    kind,
    // Other Gen Eds the same course should also meet (one course for "Humanities + Western").
    also: Array.isArray(also) ? [...new Set(also.filter((other) => SLOT_KINDS.has(other) && other !== kind))] : [],
    term: isTerm(term) ? term : null,
    auto: auto === true,
    reason: typeof reason === "string" ? reason.slice(0, 120) : null,
  };
}

/** Reads the saved lists, keeping only well-formed entries (the browser's data can't be trusted). */
function load() {
  const courses = new Map();
  const slots = new Map();
  try {
    for (const [id, value] of Object.entries(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}"))) {
      // Older saves were just "taken" or "planned", with no term.
      const { status, term, hours, ...extra } = typeof value === "string" ? { status: value } : (value ?? {});
      if (COURSE_ID.test(id) && STATUSES.has(status)) courses.set(id, entry(status, term, hours, extra));
    }
    for (const [id, value] of Object.entries(JSON.parse(localStorage.getItem(SLOTS_KEY) ?? "{}"))) {
      if (SLOT_ID.test(id) && SLOT_KINDS.has(value?.kind)) slots.set(id, slotEntry(value));
    }
  } catch {
    // Blocked or garbled storage: start with what was read.
  }
  return { courses, slots };
}

let { courses: entries, slots } = load();
let nextSlot = Math.max(0, ...[...slots.keys()].map((id) => Number(id.slice(5)))) + 1;
const listeners = new Set();
const notify = () => listeners.forEach((listener) => listener());

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
    localStorage.setItem(SLOTS_KEY, JSON.stringify(Object.fromEntries(slots)));
  } catch {
    // Not saved (storage blocked), but the page still shows the change for this visit.
  }
  notify();
}

// Another tab changed the lists: pick them up here too.
window.addEventListener("storage", (event) => {
  if (event.key !== STORAGE_KEY && event.key !== SLOTS_KEY) return;
  ({ courses: entries, slots } = load());
  notify();
});

/**
 * Redraws a page after a change without losing the keyboard's place: the control that had focus
 * is found again by its data-focus-key (the redraw makes a new one) and focused.
 */
export function keepFocus(redraw) {
  const key = document.activeElement?.dataset?.focusKey;
  redraw();
  if (key) document.querySelector(`[data-focus-key="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
}

/** Marks a control so keepFocus can find it again after a redraw. */
export function focusKey(control, key) {
  control.dataset.focusKey = key;
  return control;
}

export const myCourses = {
  /** "taken", "planned", or null. */
  status: (id) => entries.get(id)?.status ?? null,

  /** The term it was or will be taken ("FA26"), or null. */
  term: (id) => entries.get(id)?.term ?? null,

  /** The hours an audit credited it with, or null to use the catalog's. */
  hours: (id) => entries.get(id)?.hours ?? null,

  /** "registered" (in progress now), "credit" (test or transfer credit), or null. */
  kind: (id) => entries.get(id)?.kind ?? null,

  /** Whether the auto-planner added it (and the student hasn't marked it since). */
  isAuto: (id) => entries.get(id)?.auto === true,

  /** Why it's in the plan ("Computer Science Core Requirements", or a slot's Gen Ed), or null. */
  reason: (id) => entries.get(id)?.reason ?? null,

  /**
   * Marks a course taken or planned (null removes it). The term is kept unless one is given, and
   * so is why it's planned (a course you mark yourself is no longer Auto-plan's to replace).
   */
  set(id, status, term) {
    if (!COURSE_ID.test(id)) return;
    if (!STATUSES.has(status)) entries.delete(id);
    else {
      const old = entries.get(id);
      const why = old?.status === status ? { reason: old.reason, fills: old.fills } : {};
      entries.set(id, entry(status, term === undefined ? old?.term : term, old?.hours, { kind: old?.kind, ...why }));
    }
    save();
  },

  /** Marks a course as one you're taking this semester ("In progress"). */
  setInProgress(id) {
    if (!COURSE_ID.test(id)) return;
    entries.set(id, entry("taken", currentTerm(), entries.get(id)?.hours, { kind: "registered" }));
    save();
  },

  /** Moves a marked course to another term (null for no term). */
  setTerm(id, term) {
    const saved = entries.get(id);
    if (!saved) return;
    saved.term = isTerm(term) ? term : null;
    save();
  },

  /**
   * Puts in a new auto-generated plan: removes the old generated courses and slots, adds the new
   * ones ({ id, term, reason } and { kind, term, reason }), and gives the student's unscheduled
   * courses their terms ({ id, term }). The student's own courses and slots are never replaced.
   */
  replaceAuto(courses, scheduled = [], newSlots = []) {
    for (const [id, saved] of entries) if (saved.auto) entries.delete(id);
    for (const [id, slot] of slots) if (slot.auto) slots.delete(id);
    for (const { id, term, reason } of courses) {
      if (COURSE_ID.test(id) && !entries.has(id)) entries.set(id, entry("planned", term, null, { auto: true, reason }));
    }
    for (const { id, term } of scheduled) {
      const saved = entries.get(id);
      if (saved && !saved.term && isTerm(term)) saved.term = term;
    }
    for (const slot of newSlots) {
      if (SLOT_KINDS.has(slot.kind)) slots.set(`slot-${nextSlot++}`, slotEntry({ ...slot, auto: true }));
    }
    save();
  },

  /**
   * Replaces a planned course with another in the same semester, keeping why it's there. For a
   * course picked for Gen Ed slots, `keeps` lists the slot kinds the new course also fills; the
   * others go back to open slots.
   */
  swap(oldId, newId, keeps) {
    const saved = entries.get(oldId);
    if (!saved || !COURSE_ID.test(newId) || entries.has(newId)) return;
    const fills = (saved.fills ?? []).filter((fill) => (keeps ?? saved.fills).includes(fill));
    for (const kind of saved.fills ?? []) {
      if (!fills.includes(kind)) slots.set(`slot-${nextSlot++}`, slotEntry({ kind, term: saved.term }));
    }
    entries.delete(oldId);
    entries.set(newId, entry(saved.status, saved.term, null, { ...saved, fills }));
    save();
  },

  /** Removes every course and slot the auto-planner added. */
  clearAuto() {
    for (const [id, saved] of entries) if (saved.auto) entries.delete(id);
    for (const [id, slot] of slots) if (slot.auto) slots.delete(id);
    save();
  },

  /** Marks many courses at once ({ id, status, term, hours, kind }), with one change notice. */
  setMany(courses) {
    for (const { id, status, term, hours, kind } of courses) {
      if (COURSE_ID.test(id) && STATUSES.has(status)) entries.set(id, entry(status, term, hours, { kind }));
    }
    save();
  },

  /** Course ids with this status (or all of them), sorted. */
  ids: (status) =>
    [...entries]
      .filter(([, saved]) => !status || saved.status === status)
      .map(([id]) => id)
      .sort(),

  // ---- Gen Ed slots ----

  /** Every slot, as { id, kind, term, auto, reason }, in the order they were added. */
  slots: () => [...slots].map(([id, slot]) => ({ id, ...slot })),

  /** Adds a slot for a Gen Ed (a GEN_ED_SLOTS key) in a term; returns its id. */
  addSlot(kind, term) {
    if (!SLOT_KINDS.has(kind)) return null;
    const id = `slot-${nextSlot++}`;
    slots.set(id, slotEntry({ kind, term }));
    save();
    return id;
  },

  /** Moves a slot to another term (null for no term). */
  setSlotTerm(id, term) {
    const slot = slots.get(id);
    if (!slot) return;
    slot.term = isTerm(term) ? term : null;
    save();
  },

  removeSlot(id) {
    slots.delete(id);
    save();
  },

  /**
   * Fills a slot with a course: the course is planned in the slot's term and the slot goes away,
   * along with `alsoCovers` (other slot ids the same course meets, like Humanities and Western).
   * `courseKinds` are the Gen Ed kinds the course counts for: a shared slot's Gen Ed the course
   * doesn't meet stays open as a slot of its own. Without it, the course is taken to meet them all.
   */
  fillSlot(id, courseId, alsoCovers = [], courseKinds = null) {
    const slot = slots.get(id);
    if (!slot || !COURSE_ID.test(courseId)) return;
    if (entries.has(courseId)) return;
    const fills = [];
    for (const other of [id, ...alsoCovers]) {
      const filled = slots.get(other);
      if (!filled) continue;
      for (const kind of [filled.kind, ...filled.also]) {
        if (!courseKinds || courseKinds.includes(kind) || kind === slot.kind) fills.push(kind);
        else slots.set(`slot-${nextSlot++}`, slotEntry({ kind, term: filled.term }));
      }
      slots.delete(other);
    }
    entries.set(courseId, entry("planned", slot.term, null, { reason: slotKind(slot.kind).name, fills }));
    save();
  },

  /** The Gen Ed slot kinds a planned course was picked to fill (["HUM", "US"]), or []. */
  fills: (id) => entries.get(id)?.fills ?? [],

  /** Takes a course picked for Gen Ed slots back out, leaving its open slots in its semester. */
  backToSlot(id) {
    const saved = entries.get(id);
    if (!saved?.fills) return;
    entries.delete(id);
    // One course met them all, so one slot holds them again.
    const [kind, ...also] = saved.fills;
    slots.set(`slot-${nextSlot++}`, slotEntry({ kind, also, term: saved.term }));
    save();
  },

  /** Calls `listener` whenever anything changes. */
  onChange: (listener) => listeners.add(listener),
};
