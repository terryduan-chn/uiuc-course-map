// The prerequisite graph: which courses need which. No DOM code here.

/** A steady hue (0-359) per subject, so a department's courses share a color everywhere. */
export function subjectHue(subject) {
  let hash = 0;
  for (const char of subject) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  return hash;
}

/** "CS 225" style id for a course. */
export function courseId(subject, number) {
  return `${subject} ${number}`;
}

/** Files a prerequisite under its requirement group ("choose 1 of 3" etc.). */
function addToRequirement(node, link, prereq) {
  const index = link.group_index ?? node.requirements.length;
  node.groupByIndex ??= new Map();
  if (!node.groupByIndex.has(index)) {
    // "Credit or concurrent registration in X": X may be taken in the same semester.
    const group = { required: link.required_count ?? 1, ids: [], concurrent: Boolean(link.concurrent_ok) };
    node.groupByIndex.set(index, group);
    node.requirements.push(group);
  }
  const group = node.groupByIndex.get(index);
  if (!group.ids.includes(prereq)) group.ids.push(prereq);
}

/**
 * Builds the graph from prerequisite links.
 * @param {{ subject, number, prereq_subject, prereq_number, group_index?, required_count?, concurrent_ok? }[]} links
 *   one per course → prerequisite, as stored in the prerequisites table
 * @param {Map<string, string>} titles course id → title; links to unknown courses are dropped
 * @returns {{ nodes: object[], links: object[], byId: Map<string, object> }}
 *   nodes: { id, subject, number, title, dependents, prerequisites, requirements }, where
 *   dependents and prerequisites are arrays of course ids and requirements lists the course's
 *   requirement groups as { required, ids, concurrent } (concurrent: its courses may be taken in
 *   the same semester). links: { source, target } from prerequisite to course.
 */
export function buildGraph(links, titles) {
  const byId = new Map();
  const nodeFor = (id) => {
    if (!byId.has(id)) {
      const [subject, number] = id.split(" ");
      byId.set(id, {
        id,
        subject,
        number,
        title: titles.get(id),
        dependents: [],
        prerequisites: [],
        requirements: [],
      });
    }
    return byId.get(id);
  };

  const graphLinks = [];
  const seen = new Set();
  for (const link of links) {
    const course = courseId(link.subject, link.number);
    const prereq = courseId(link.prereq_subject, link.prereq_number);
    if (course === prereq || !titles.has(course) || !titles.has(prereq)) continue;
    addToRequirement(nodeFor(course), link, prereq);
    const key = `${prereq}>${course}`;
    if (seen.has(key)) continue;
    seen.add(key);
    nodeFor(prereq).dependents.push(course);
    nodeFor(course).prerequisites.push(prereq);
    graphLinks.push({ source: prereq, target: course });
  }
  for (const node of byId.values()) {
    delete node.groupByIndex;
    // Some groups lost courses the app doesn't have; never ask for more than remain.
    for (const group of node.requirements) group.required = Math.min(group.required, group.ids.length);
  }
  return { nodes: [...byId.values()], links: graphLinks, byId };
}

/**
 * Courses one and two steps away from a course, for the 2D view:
 * { before2, before1, after1, after2 }, each an array of course ids, most-needed first.
 * A course appears only in the column nearest the center.
 */
export function neighborhood(graph, id) {
  const node = graph.byId.get(id);
  if (!node) return { before2: [], before1: [], after1: [], after2: [] };

  const step = (ids, direction, exclude) => {
    const next = new Set();
    for (const current of ids) {
      for (const neighbor of graph.byId.get(current)[direction]) {
        if (!exclude.has(neighbor)) next.add(neighbor);
      }
    }
    return next;
  };
  const byImportance = (ids) =>
    [...ids].sort(
      (a, b) => graph.byId.get(b).dependents.length - graph.byId.get(a).dependents.length || a.localeCompare(b),
    );

  const before1 = step([id], "prerequisites", new Set([id]));
  const before2 = step(before1, "prerequisites", new Set([id, ...before1]));
  const after1 = step([id], "dependents", new Set([id]));
  const after2 = step(after1, "dependents", new Set([id, ...after1]));
  return {
    before2: byImportance(before2),
    before1: byImportance(before1),
    after1: byImportance(after1),
    after2: byImportance(after2),
  };
}

/** The most-needed courses, for the 2D view before a course is picked. */
export function mostNeeded(graph, count) {
  return [...graph.nodes]
    .sort((a, b) => b.dependents.length - a.dependents.length || a.id.localeCompare(b.id))
    .slice(0, count)
    .map((node) => node.id);
}

/**
 * The courses matching what was typed on the graph page, so the map can keep only them.
 * The text can be a subject or code start ("MATH", "cs 4", "CS225"), a number start ("4"),
 * or words from the title ("linear algebra", 3+ letters). `subjects` (none for all) narrows further.
 * @returns {Set<string> | null} matching course ids, or null when nothing narrows the map
 */
export function matchCourses(graph, text, subjects = []) {
  const query = text.trim().toUpperCase();
  const chosen = new Set(subjects);
  if (!query && chosen.size === 0) return null;

  let matches = () => true;
  const code = query.match(/^([A-Z]{1,5})\s*(\d{0,3})$/);
  const allSubjects = new Set(graph.nodes.map((node) => node.subject));
  const subjectStarts = code && [...allSubjects].some((name) => name.startsWith(code[1]));
  if (code && subjectStarts) {
    const [, letters, digits] = code;
    // "CS" means exactly CS (not CSE); "C" means every subject starting with C.
    const exact = allSubjects.has(letters);
    matches = (node) =>
      (exact ? node.subject === letters : node.subject.startsWith(letters)) && node.number.startsWith(digits);
  } else if (/^\d{1,3}$/.test(query)) {
    matches = (node) => node.number.startsWith(query);
  } else if (query.length >= 3) {
    const words = query.toLowerCase().split(/\s+/);
    matches = (node) => words.every((word) => (node.title ?? "").toLowerCase().includes(word));
  } else if (query) {
    matches = () => false;
  }

  return new Set(
    graph.nodes
      .filter((node) => (chosen.size === 0 || chosen.has(node.subject)) && matches(node))
      .map((node) => node.id),
  );
}

/**
 * The requirement groups of a course that `done` (a Set of course ids) does not yet meet,
 * each as { required, ids, concurrent, have } where `have` is how many of its courses count.
 * `sameTerm` holds courses taken in the same semester: they count for groups that allow
 * concurrent registration. An empty array means every prerequisite is met (or there are none).
 */
export function missingRequirements(graph, id, done, sameTerm = new Set()) {
  const node = graph.byId.get(id);
  if (!node) return [];
  const counts = (group, prereq) => done.has(prereq) || (group.concurrent && sameTerm.has(prereq));
  return node.requirements
    .map((group) => ({ ...group, have: group.ids.filter((prereq) => counts(group, prereq)).length }))
    .filter((group) => group.have < group.required);
}

/**
 * Courses you could take next: not done yet, with every prerequisite met by `done`, and at
 * least one of their prerequisites among the done courses (so courses with no prerequisites,
 * which anyone can take, don't flood the list). Most-needed first.
 */
export function readyNext(graph, done) {
  const candidates = new Set();
  for (const id of done) {
    for (const dependent of graph.byId.get(id)?.dependents ?? []) {
      if (!done.has(dependent)) candidates.add(dependent);
    }
  }
  return [...candidates]
    .filter((id) => missingRequirements(graph, id, done).length === 0)
    .sort((a, b) => graph.byId.get(b).dependents.length - graph.byId.get(a).dependents.length || a.localeCompare(b));
}
