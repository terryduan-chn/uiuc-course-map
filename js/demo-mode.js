// Demo mode: the live demos on the Docs page are this same app in a frame, opened as
// index.html?demo. There, the browser's storage is swapped for one in memory holding a sample
// plan, so nothing done in a demo touches the student's own plan, and a reload starts it over.
// app.js imports this file first, so the swap happens before anything reads saved data.

const course = (status, term, kind) => ({ status, term, hours: null, ...(kind ? { kind } : {}) });
const part = (title, needs, selectFrom = []) => ({
  label: "1",
  title,
  needs,
  selectFrom,
  notFrom: [],
  courses: [],
  notes: [],
});
const section = (title, needs, parts, extra = {}) => ({ title, needs, notes: [], courses: [], parts, ...extra });
const numbers = (subject, ...list) => list.map((number) => ({ subject, number }));

// A made-up student: taken, in progress this semester, planned, two Gen Ed slots, and one problem
// to show its badge (CS 374 in the same semester as CS 225, which must come first).
const SAMPLE_COURSES = {
  "CS 101": course("taken", "FA25"),
  "CS 124": course("taken", "FA25"),
  "MATH 221": course("taken", "FA25"),
  "RHET 105": course("taken", "SP26"),
  "MATH 231": course("taken", "SP26"),
  "CS 128": course("taken", "FA26", "registered"),
  "CS 173": course("taken", "FA26", "registered"),
  "MATH 241": course("taken", "FA26", "registered"),
  "PHYS 211": course("taken", "FA26", "registered"),
  "CS 225": course("planned", "SP27"),
  "CS 222": course("planned", "SP27"),
  "MATH 257": course("planned", "SP27"),
  "CS 374": course("planned", "SP27"),
  "PHYS 212": course("planned", "FA27"),
  "CS 233": course("planned", "FA27"),
  "STAT 400": course("planned", "FA27"),
};
const SAMPLE_SLOTS = {
  "slot-1": { kind: "HUM", term: "SP27", auto: false, reason: null },
  "slot-2": { kind: "SBS", term: "FA27", auto: false, reason: null },
};
const SAMPLE_AUDIT = {
  programName: "Sample Computer Science",
  program: "",
  catalogYear: "202608",
  preparedOn: "",
  takenIds: ["CS 101", "CS 124", "MATH 221", "RHET 105", "MATH 231"],
  gpas: [
    { name: "Overall", hours: 17, gpa: 3.62 },
    { name: "UIUC", hours: 17, gpa: 3.62 },
    { name: "Technical", hours: 8, gpa: 3.5 },
    { name: "College", hours: 17, gpa: 3.62 },
  ],
  sections: [
    section("COMPOSITION I", null, [part("COMPOSITION I", null)]),
    section("COMPUTER SCIENCE CORE", null, [
      part("COMPUTER SCIENCE CORE", { courses: 4 }, numbers("CS", "222", "225", "233", "341", "374")),
    ]),
    section("ADVANCED ELECTIVES", null, [
      part("ADVANCED ELECTIVES", { hours: 6, courses: 2 }, [...numbers("CS", "397"), ...numbers("*", "4")]),
    ]),
    section("HUMANITIES & THE ARTS", null, [part("HUMANITIES & THE ARTS", { hours: 6 })]),
    section("SOCIAL & BEHAVIORAL SCIENCES", null, [part("SOCIAL & BEHAVIORAL SCIENCES", { hours: 6 })]),
    section("MINIMUM OF 128 HOURS REQUIRED", { hours: 36 }, [], { earned: { hours: 92 } }),
  ],
};

/** What a demo starts with, in the form browser storage holds it: text by key. */
export function sampleData() {
  return {
    myCourses: JSON.stringify(SAMPLE_COURSES),
    planSlots: JSON.stringify(SAMPLE_SLOTS),
    degreeAudit: JSON.stringify(SAMPLE_AUDIT),
  };
}

/** Works like localStorage for this page's visit, starting from `items`, and saves nothing. */
export function memoryStorage(items) {
  const saved = new Map(Object.entries(items));
  return {
    getItem: (key) => saved.get(key) ?? null,
    setItem: (key, value) => saved.set(key, String(value)),
    removeItem: (key) => saved.delete(key),
  };
}

if (typeof location !== "undefined" && new URLSearchParams(location.search).has("demo")) {
  // The demo speaks the page's language, so that choice comes along before the swap.
  const language = localStorage.getItem("language");
  Object.defineProperty(window, "localStorage", {
    value: memoryStorage({ ...sampleData(), ...(language ? { language } : {}) }),
  });
  document.documentElement.classList.add("demo");
}
