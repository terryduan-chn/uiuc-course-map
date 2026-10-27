import { createAuditView } from "./audit-view.js";
import { createCourseView } from "./course-view.js";
import { createDocsView } from "./docs-view.js";
import { startEffects, withPageTransition } from "./effects.js";
import { subjectHue } from "./graph-data.js";
import { createGraphView } from "./graph-view.js";
import { keepFocus, myCourses } from "./my-courses.js";
import { createPicker } from "./picker.js";
import { planButton } from "./plan-controls.js";
import { createPlanView } from "./plan-view.js";
import {
  buildGenEdQuery,
  buildSearchQuery,
  courseLevel,
  filterSubjects,
  findJumpTarget,
  GEN_ED_CATEGORIES,
  GEN_ED_MAX_RESULTS,
  genEdShortName,
  MAX_RESULTS,
  parseRoute,
} from "./search.js";
import { setUpThemeToggle } from "./theme.js";

const SQL_JS_CDN = "https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.14.2/";

const searchInput = document.getElementById("search");
const searchArea = document.getElementById("search-area");
const navCourses = document.getElementById("nav-courses");
const navGraph = document.getElementById("nav-graph");
const navPlan = document.getElementById("nav-plan");
const navAudit = document.getElementById("nav-audit");
const navDocs = document.getElementById("nav-docs");
const statusLine = document.getElementById("status");
const subjectsSection = document.getElementById("subjects");
const subjectGrid = document.getElementById("subject-grid");
const subjectFilter = document.getElementById("subject-filter");
const subjectFilterEmpty = document.getElementById("subject-filter-empty");
const layout = document.getElementById("layout");
const listHeader = document.getElementById("list-header");
const resultsList = document.getElementById("results");
const detailPanel = document.getElementById("detail");
const sourceNote = document.getElementById("source-note");
const heroIntro = document.getElementById("hero-intro");
const heroMore = document.getElementById("hero-more");
const heroActions = document.getElementById("hero-actions");
const heroStats = document.getElementById("hero-stats");
const popularCourses = document.getElementById("popular-courses");
const homeMapSection = document.getElementById("home-map");
const homeMapCanvas = document.getElementById("home-map-canvas");
const homeMapCourse = document.getElementById("home-map-course");
const homeMapCounts = document.getElementById("home-map-counts");
const homeMapGraph = document.getElementById("home-map-graph");

let db;
let graphView; // created once the data has loaded
let planView;
let auditView;
let courseView;
let docsView;
let genEdPicker; // the Gen Ed menu under the search box
let pickedGenEds = []; // Gen Ed codes the shown courses must all meet
let currentCatalogTerm; // e.g. "Fall 2026"
let oldestTermSearched; // e.g. "Spring 2024"

function rows(sql, params = {}) {
  const [result] = db.exec(sql, params);
  if (!result) return [];
  return result.values.map((values) => Object.fromEntries(result.columns.map((column, i) => [column, values[i]])));
}

function element(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

/** "2026/fall" -> "Fall 2026" */
function termLabel(termPath) {
  const [year, term] = termPath.split("/");
  return `${term[0].toUpperCase()}${term.slice(1)} ${year}`;
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function courseHash(subject, number) {
  return `#${subject}-${number}`;
}

function findSubject(code) {
  const [subject] = rows(
    `SELECT code, name, (SELECT COUNT(*) FROM courses WHERE subject = code) AS course_count
     FROM subjects WHERE code = :code`,
    { ":code": code },
  );
  return subject;
}

/** Courses meeting every picked Gen Ed requirement (and the search text), best GPA first. */
function showGenEdResults(query) {
  const { sql, params } = buildGenEdQuery(pickedGenEds, query);
  const matches = rows(sql, params);
  const names = genEdPicker.names().join(" + ");
  const within = query ? ` matching “${query}”` : "";
  if (matches.length === 0) {
    statusLine.textContent = `No course meets ${names}${within}. Try removing a requirement.`;
  } else {
    const shown =
      matches.length === GEN_ED_MAX_RESULTS
        ? `The first ${GEN_ED_MAX_RESULTS} courses`
        : plural(matches.length, "course");
    statusLine.textContent = `${shown} meet ${names}${within}, highest average GPA first.`;
  }
  resultsList.replaceChildren(...matches.map(courseListItem));
}

function courseListItem(course) {
  const id = `${course.subject} ${course.number}`;
  return element(
    "li",
    { className: "result-item" },
    planButton(element, id, "on-card"),
    element(
      "a",
      {
        href: courseHash(course.subject, course.number),
        className: "result-link",
        title: `${course.subject} ${course.number}: ${course.title}`,
      },
      element("span", { className: "code", textContent: `${course.subject} ${course.number}` }),
      element("span", { className: "title", textContent: course.title }),
      course.gpa == null ? "" : element("span", { className: "gpa", textContent: `${course.gpa.toFixed(2)} GPA` }),
    ),
  );
}

// ---- Home: subject grid ----

let allSubjects = []; // { code, name, course_count }, loaded once

function subjectCard(subject) {
  const card = element(
    "a",
    { href: `#${subject.code}`, className: "subject-card", title: subject.name },
    element("span", { className: "code", textContent: subject.code }),
    element("span", { className: "name", textContent: subject.name }),
    element("span", { className: "count", textContent: plural(subject.course_count, "course") }),
  );
  // The subject's own color, the same as its planets in the star map.
  card.style.setProperty("--hue", subjectHue(subject.code));
  return element("li", {}, card);
}

/** Draws the subject cards that match the filter box. */
function drawSubjectCards() {
  const query = subjectFilter.value.trim();
  const shown = filterSubjects(allSubjects, query);
  subjectGrid.replaceChildren(...shown.map(subjectCard));
  subjectFilterEmpty.hidden = shown.length > 0;
  subjectFilterEmpty.textContent = `No subject matches “${query}”. Try a code like MATH or a word like history.`;
}

// ---- Home page hero ----

const COUNT_UP_MS = 900;
const POPULAR_SHOWN = 8;
const HOME_MAP_MS = 5000; // the home map shows a new course every 5 seconds, by the clock
const HOME_MAP_POOL = 60; // chosen from this many most-needed courses
const HOME_MAP_NEEDS = 5;
const HOME_MAP_UNLOCKS = 7;
let heroDrawn = false;

/** Counts a number up from zero, unless the system asks for less motion. */
function countUp(target, value) {
  const finalText = value.toLocaleString("en-US");
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    target.textContent = finalText;
    return;
  }
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / COUNT_UP_MS);
    const eased = 1 - (1 - t) ** 3;
    target.textContent = t === 1 ? finalText : Math.round(value * eased).toLocaleString("en-US");
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** Fills the hero's numbers and most-needed courses once; they don't change while the page is open. */
function showHero() {
  if (heroDrawn) return;
  heroDrawn = true;
  const [counts] = rows(
    `SELECT
       (SELECT COUNT(*) FROM courses) AS courses,
       (SELECT COUNT(DISTINCT subject) FROM courses) AS subjects,
       (SELECT COUNT(*) FROM (
          SELECT DISTINCT p.subject, p.number, p.prereq_subject, p.prereq_number
          FROM prerequisites p
          JOIN courses c ON c.subject = p.prereq_subject AND c.number = p.prereq_number)) AS links,
       (SELECT COUNT(*) FROM course_grades) AS graded`,
  );
  const stats = [
    [counts.courses, "courses"],
    [counts.subjects, "subjects"],
    [counts.links, "prerequisite links"],
    [counts.graded, "with GPA data"],
  ];
  heroStats.replaceChildren(
    ...stats.map(([value, label]) => {
      const number = element("dd", { textContent: "0" });
      countUp(number, value);
      return element("div", { className: "hero-stat" }, element("dt", { textContent: label }), number);
    }),
  );

  const popular = rows(
    `SELECT p.prereq_subject AS subject, p.prereq_number AS number, c.title,
            COUNT(DISTINCT p.subject || ' ' || p.number) AS needed_by
     FROM prerequisites p
     JOIN courses c ON c.subject = p.prereq_subject AND c.number = p.prereq_number
     GROUP BY p.prereq_subject, p.prereq_number
     ORDER BY needed_by DESC
     LIMIT ?`,
    [POPULAR_SHOWN],
  );
  popularCourses.replaceChildren(
    ...popular.map((course) => {
      const card = element(
        "a",
        { className: "popular-course", href: `#${course.subject}-${course.number}`, title: course.title },
        element("span", { className: "code", textContent: `${course.subject} ${course.number}` }),
        element("span", { className: "title", textContent: course.title }),
        element("span", { className: "count", textContent: `needed by ${course.needed_by}` }),
      );
      card.style.setProperty("--hue", subjectHue(course.subject));
      return element("li", {}, card);
    }),
  );
  startHomeMap();
}

// ---- Home page: the small 3D map of one course's links ----

let homePool = [];
let homeMap = null; // created once three.js has loaded
let homeSlot = null; // which 5-second slot is showing

/** A fixed, mixed-up order, so courses one after another are usually from different subjects. */
function mixKey(id) {
  let hash = 7;
  for (const char of id) hash = (hash * 131 + char.charCodeAt(0)) % 1000003;
  return hash;
}

function loadHomePool() {
  return rows(
    `SELECT p.prereq_subject AS subject, p.prereq_number AS number, c.title,
            COUNT(DISTINCT p.subject || ' ' || p.number) AS needed_by
     FROM prerequisites p
     JOIN courses c ON c.subject = p.prereq_subject AND c.number = p.prereq_number
     GROUP BY p.prereq_subject, p.prereq_number
     ORDER BY needed_by DESC
     LIMIT ?`,
    [HOME_MAP_POOL],
  )
    .map((course) => ({ ...course, id: `${course.subject} ${course.number}` }))
    .sort((a, b) => mixKey(a.id) - mixKey(b.id));
}

/** How many courses list this one as a prerequisite; used for planet sizes. */
const NEEDED_BY_SQL = `(SELECT COUNT(DISTINCT q.subject || ' ' || q.number) FROM prerequisites q
                       WHERE q.prereq_subject = c.subject AND q.prereq_number = c.number)`;

/** A course with the courses it needs and unlocks, most-needed first. */
function homeMapCourseData(course) {
  const neighbor = (row) => ({ id: row.id, hue: subjectHue(row.subject), neededBy: row.needed_by });
  const needs = rows(
    `SELECT DISTINCT c.subject || ' ' || c.number AS id, c.subject, ${NEEDED_BY_SQL} AS needed_by
     FROM prerequisites p JOIN courses c ON c.subject = p.prereq_subject AND c.number = p.prereq_number
     WHERE p.subject = ? AND p.number = ? AND NOT (c.subject = p.subject AND c.number = p.number)
     ORDER BY needed_by DESC LIMIT ?`,
    [course.subject, course.number, HOME_MAP_NEEDS],
  ).map(neighbor);
  const unlocks = rows(
    `SELECT DISTINCT c.subject || ' ' || c.number AS id, c.subject, ${NEEDED_BY_SQL} AS needed_by
     FROM prerequisites p JOIN courses c ON c.subject = p.subject AND c.number = p.number
     WHERE p.prereq_subject = ? AND p.prereq_number = ? AND NOT (c.subject = p.prereq_subject AND c.number = p.prereq_number)
     ORDER BY needed_by DESC LIMIT ?`,
    [course.subject, course.number, HOME_MAP_UNLOCKS],
  ).map(neighbor);
  return { id: course.id, hue: subjectHue(course.subject), neededBy: course.needed_by, needs, unlocks };
}

/** Shows the course for the current 5-second slot (the same for everyone at the same moment). */
function showHomeCourse() {
  const slot = Math.floor(Date.now() / HOME_MAP_MS);
  if (slot === homeSlot || homePool.length === 0) return;
  homeSlot = slot;
  const course = homePool[slot % homePool.length];
  const data = homeMapCourseData(course);

  homeMapSection.style.setProperty("--hue", data.hue);
  homeMapCourse.href = `#${course.subject}-${course.number}`;
  homeMapCourse.children[0].textContent = course.id;
  homeMapCourse.children[1].textContent = course.title;
  homeMapCounts.textContent = `needs ${data.needs.length} · unlocks ${course.needed_by}`;
  homeMapGraph.href = `#graph/${course.subject}-${course.number}`;
  homeMap?.show(data);
}

function homeMapTick() {
  if (document.body.classList.contains("is-home") && !document.hidden) showHomeCourse();
  setTimeout(homeMapTick, HOME_MAP_MS - (Date.now() % HOME_MAP_MS) + 20);
}

function startHomeMap() {
  homePool = loadHomePool();
  if (homePool.length === 0) {
    homeMapSection.hidden = true;
    return;
  }
  homeMapTick();
  import("./mini-map.js")
    .then(({ createMiniMap }) =>
      createMiniMap(homeMapCanvas, {
        onSelect: (id) => {
          location.hash = `#graph/${id.replace(" ", "-")}`;
        },
      }),
    )
    .then((map) => {
      homeMap = map;
      homeSlot = null; // draw the current course now that there is a map
      showHomeCourse();
      if (document.body.classList.contains("is-home")) map.start();
    })
    .catch((error) => {
      // No WebGL or no internet: keep the changing caption, without the 3D map.
      console.error(error);
      homeMapCanvas.hidden = true;
    });
}

function showSubjectGrid() {
  if (allSubjects.length === 0) {
    allSubjects = rows(
      `SELECT subjects.code, subjects.name, COUNT(*) AS course_count
       FROM subjects JOIN courses ON courses.subject = subjects.code
       GROUP BY subjects.code ORDER BY subjects.code`,
    );
  }
  const total = allSubjects.reduce((sum, subject) => sum + subject.course_count, 0);
  statusLine.textContent =
    `${plural(total, "course")} in ${plural(allSubjects.length, "subject")}. ` +
    "Filter the subjects below, or search all courses above.";
  drawSubjectCards();
}

/**
 * A Cards | List toggle: calls apply("cards" or "list") now and on every click, and
 * remembers the choice in the browser under storageKey.
 */
function setUpViewToggle(toggle, storageKey, apply) {
  const buttons = toggle.querySelectorAll("button");
  const show = (view) => {
    apply(view);
    for (const button of buttons) {
      button.setAttribute("aria-pressed", String(button.dataset.view === view));
    }
  };
  let saved = "cards";
  try {
    saved = localStorage.getItem(storageKey) ?? "cards";
  } catch {
    // Storage can be blocked (private windows); fall back to cards.
  }
  show(saved);
  for (const button of buttons) {
    button.addEventListener("click", () => {
      show(button.dataset.view);
      try {
        localStorage.setItem(storageKey, button.dataset.view);
      } catch {
        // Not remembered, but the view still changes.
      }
    });
  }
}

// ---- Course lists: search results or one subject ----

function showSearchResults(query) {
  listHeader.replaceChildren();
  if (pickedGenEds.length > 0) {
    showGenEdResults(query);
    return;
  }
  const { sql, params } = buildSearchQuery(query);
  const matches = rows(sql, params);

  if (matches.length === 0) statusLine.textContent = `No course matches “${query}”.`;
  else if (matches.length === MAX_RESULTS) {
    statusLine.textContent = `Showing the first ${MAX_RESULTS} matches. Type more to narrow it down.`;
  } else statusLine.textContent = `${plural(matches.length, "course")} found.`;

  resultsList.replaceChildren(...matches.map(courseListItem));
}

function showSubjectCourses(code) {
  const subject = findSubject(code);
  listHeader.replaceChildren(element("a", { href: "#", className: "back-link", textContent: "← All subjects" }));

  if (!subject) {
    statusLine.textContent = `There is no subject “${code}” in the app's data.`;
    resultsList.replaceChildren();
    return;
  }

  statusLine.textContent = `${subject.name} (${subject.code}): ${plural(subject.course_count, "course")}.`;
  listHeader.append(element("h2", { textContent: subject.name }));

  const courses = rows("SELECT subject, number, title FROM courses WHERE subject = :code ORDER BY number", {
    ":code": code,
  });
  const items = [];
  const levels = [];
  for (const course of courses) {
    const level = courseLevel(course.number);
    if (level !== levels.at(-1)) {
      levels.push(level);
      items.push(element("li", { className: "level-heading", id: `level-${level}`, textContent: level }));
    }
    items.push(courseListItem(course));
  }
  resultsList.replaceChildren(...items);
  listHeader.append(
    jumpBar(
      code,
      courses.map((course) => course.number),
      levels,
    ),
  );
}

/** Scrolls the list to an item and briefly highlights it. */
function scrollToItem(item) {
  item.scrollIntoView({ block: "center" }); // instant, so typing keeps up
  for (const old of document.querySelectorAll(".jump-highlight")) old.classList.remove("jump-highlight");
  void item.offsetWidth; // restart the highlight animation
  item.classList.add("jump-highlight");
}

/** "Jump to" a course number (Enter opens it) or a level (100-level, 200-level, …). */
function jumpBar(subject, numbers, levels) {
  const input = element("input", {
    type: "search",
    className: "jump-input",
    placeholder: "e.g. 225",
    inputMode: "numeric",
    autocomplete: "off",
    ariaLabel: `Jump to a ${subject} course number`,
  });
  const message = element("span", { className: "jump-message", role: "status" });

  const targetLink = () => {
    const number = findJumpTarget(numbers, input.value);
    return number && resultsList.querySelector(`a[href="${courseHash(subject, number)}"]`);
  };
  input.addEventListener("input", () => {
    const link = targetLink();
    message.textContent = link || input.value.trim() === "" ? "" : `No ${subject} ${input.value.trim()}`;
    if (link) scrollToItem(link);
  });
  input.addEventListener("keydown", (event) => {
    const link = event.key === "Enter" && targetLink();
    if (link) location.hash = link.getAttribute("href");
  });

  const levelButtons = levels.map((level) =>
    element("button", {
      type: "button",
      className: "level-button",
      textContent: level.replace("-level", ""),
      title: `Jump to ${level} courses`,
      onclick: () => scrollToItem(document.getElementById(`level-${level}`)),
    }),
  );

  return element(
    "div",
    { className: "jump-bar" },
    element("span", { className: "jump-label", textContent: "Jump to" }),
    input,
    ...levelButtons,
    message,
  );
}

function markSelectedResult() {
  for (const link of resultsList.querySelectorAll("a")) {
    if (link.getAttribute("href") === location.hash) link.setAttribute("aria-current", "true");
    else link.removeAttribute("aria-current");
  }
}

function showGenEd(code) {
  searchInput.value = "";
  pickedGenEds = [code];
  genEdPicker.set([code]);
  history.pushState(null, "", location.pathname); // off the course page, so Back returns to it
  onAddressChange();
}

// ---- Choosing what to show ----

/**
 * Shows the right screen for the search box and the address bar's #part:
 * a search query lists matching courses; otherwise a subject (or the open course's
 * subject) lists that subject's courses; otherwise the home page shows every subject.
 */
function render() {
  const query = searchInput.value.trim();
  const route = parseRoute(location.hash);
  const showingGraph = route.view === "graph";
  const filtering = query !== "" || pickedGenEds.length > 0;
  const showingHome = !filtering && route.view === "home";
  const showingPlan = !filtering && route.view === "plan";
  const showingAudit = !filtering && route.view === "audit";
  const showingDocs = !filtering && route.view === "docs";
  const ownPage = showingPlan || showingAudit || showingDocs; // pages with no search box or course list

  navGraph.toggleAttribute("aria-current", showingGraph);
  navPlan.toggleAttribute("aria-current", showingPlan);
  navAudit.toggleAttribute("aria-current", showingAudit);
  navDocs.toggleAttribute("aria-current", showingDocs);
  navCourses.toggleAttribute("aria-current", !showingGraph && !ownPage);
  document.body.classList.toggle("is-home", showingHome);
  heroIntro.hidden = !showingHome;
  heroMore.hidden = !showingHome;
  heroActions.hidden = !showingHome;
  searchArea.hidden = showingGraph || ownPage;
  // The home page's numbers are in the hero, so its status line would only repeat them.
  statusLine.hidden = showingGraph || showingHome || ownPage;
  if (ownPage) {
    subjectsSection.hidden = true;
    layout.hidden = true;
    homeMap?.stop();
    graphView.hide();
    // Hide the other pages first, so only one is ever showing.
    const pages = [
      [showingPlan, planView],
      [showingAudit, auditView],
      [showingDocs, docsView],
    ];
    for (const [showing, view] of pages) if (!showing) view.hide();
    for (const [showing, view] of pages) if (showing) view.show(route.section);
    return;
  }
  planView.hide();
  auditView.hide();
  docsView.hide();
  if (showingGraph) {
    subjectsSection.hidden = true;
    layout.hidden = true;
    homeMap?.stop();
    graphView.show(route);
    return;
  }
  graphView.hide();
  subjectsSection.hidden = !showingHome;
  layout.hidden = showingHome;

  if (showingHome) {
    showHero();
    showSubjectGrid();
  } else if (filtering) showSearchResults(query);
  else showSubjectCourses(route.subject);
  // The home map only draws while the home page is showing.
  if (showingHome) homeMap?.start();
  else homeMap?.stop();

  // With no course open, the course list spreads across the whole width as cards.
  const courseOpen = route.view === "course";
  layout.classList.toggle("course-open", courseOpen);
  detailPanel.hidden = !courseOpen;
  if (courseOpen) courseView.show(route.subject, route.number);
  markSelectedResult();
}

/** Which kind of page a route shows; moving between kinds gets a page transition. */
const pageKind = (route) => (route.view === "subject" ? `subject:${route.subject}` : route.view);
let shownPageKind = null;

function onAddressChange() {
  const route = parseRoute(location.hash);
  const kind = pageKind(route);
  if (shownPageKind !== null && kind !== shownPageKind && searchInput.value.trim() === "") {
    withPageTransition(render);
  } else {
    render();
  }
  shownPageKind = kind;
  if (route.view === "course" && window.matchMedia("(max-width: 760px)").matches) {
    detailPanel.scrollIntoView({ behavior: "smooth", block: "start" });
  } else if (route.view !== "course" && route.view !== "docs") {
    window.scrollTo({ top: 0 }); // the docs scroll to the section asked for themselves
  }
}

// ---- Start-up ----

/** Reads when and from where the data was imported; returns it in words, for the docs. */
function readMeta() {
  const meta = Object.fromEntries(rows("SELECT key, value FROM meta").map((r) => [r.key, r.value]));
  currentCatalogTerm = termLabel(meta.catalog_term);
  oldestTermSearched = termLabel(meta.oldest_term_searched);
  // The page is in English, so the date is too, whatever language the computer uses.
  const imported = new Date(meta.imported_at).toLocaleDateString("en-US", { dateStyle: "medium" });
  sourceNote.textContent =
    `Data from UIUC Course Explorer, imported ${imported}: course details from the ` +
    `${termLabel(meta.oldest_catalog_searched)} to ${currentCatalogTerm} catalogs, terms offered ` +
    `since ${oldestTermSearched}.`;
  return {
    imported_at: imported,
    catalog_term: currentCatalogTerm,
    oldest_term_searched: oldestTermSearched,
    oldest_catalog_searched: termLabel(meta.oldest_catalog_searched),
  };
}

async function loadDatabase() {
  const SQL = await initSqlJs({ locateFile: (file) => SQL_JS_CDN + file });
  const response = await fetch("data/courses.db");
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return new SQL.Database(new Uint8Array(await response.arrayBuffer()));
}

async function start() {
  setUpThemeToggle(document.getElementById("theme-toggle"));
  try {
    db = await loadDatabase();
  } catch (error) {
    statusLine.textContent = "Couldn't load the course data. Check your internet connection and reload the page.";
    statusLine.classList.add("error");
    console.error(error);
    return;
  }

  const importInfo = readMeta();
  docsView = createDocsView({ element, meta: importInfo });
  shownPageKind = pageKind(parseRoute(location.hash));
  startEffects({ main: document.querySelector("main"), sky: document.getElementById("sky") });
  graphView = createGraphView({ rows, element });
  courseView = createCourseView({
    rows,
    element,
    panel: detailPanel,
    getGraph: () => graphView.getGraph(),
    currentCatalogTerm,
    oldestTermSearched,
    onGenEd: showGenEd,
  });
  planView = createPlanView({ rows, element, getGraph: () => graphView.getGraph() });
  auditView = createAuditView({
    rows,
    element,
    getGraph: () => graphView.getGraph(),
    onMakePlan: () => {
      planView.generate();
      location.hash = "#plan";
    },
  });
  // Marking a course taken or planned updates whatever page is showing.
  myCourses.onChange(() => {
    if (!["plan", "audit"].includes(parseRoute(location.hash).view)) keepFocus(render); // those pages redraw themselves
  });
  genEdPicker = createPicker(document.getElementById("gen-ed-filter"), {
    items: rows(
      `SELECT code, name, category, COUNT(DISTINCT subject || ' ' || number) AS count
       FROM gen_eds WHERE name <> ''
       GROUP BY code, name, category ORDER BY category, code`,
    ).map((genEd) => ({
      code: genEd.code,
      tag: GEN_ED_CATEGORIES[genEd.category]?.tag ?? "GE",
      short: genEdShortName(genEd.name),
      name: genEd.name,
      count: genEd.count,
      hue: GEN_ED_CATEGORIES[genEd.category]?.hue ?? 250,
    })),
    noun: "Gen Eds",
    onChange: (codes) => {
      pickedGenEds = codes;
      render();
    },
  });
  setUpViewToggle(document.getElementById("subject-view-toggle"), "subjectView", (view) =>
    subjectGrid.classList.toggle("as-list", view === "list"),
  );
  setUpViewToggle(document.getElementById("course-view-toggle"), "courseView", (view) =>
    resultsList.classList.toggle("as-list", view === "list"),
  );
  document
    .getElementById("browse-subjects")
    .addEventListener("click", () =>
      document.getElementById("subjects-heading").scrollIntoView({ behavior: "smooth", block: "start" }),
    );
  searchInput.disabled = false;
  searchInput.addEventListener("input", render);
  subjectFilter.addEventListener("input", drawSubjectCards);
  // Enter in the filter opens the best match.
  subjectFilter.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    const [best] = filterSubjects(allSubjects, subjectFilter.value);
    if (best) location.hash = `#${best.code}`;
  });
  window.addEventListener("hashchange", onAddressChange);
  // Following a link to a subject or home leaves the search, so clear it.
  document.addEventListener("click", (event) => {
    const link = event.target.closest('a[href^="#"]');
    if (!link || parseRoute(link.getAttribute("href")).view === "course") return;
    searchInput.value = "";
    pickedGenEds = [];
    genEdPicker?.clear();
    render(); // hashchange won't fire if the address is already this one
  });
  render();
}

start();
