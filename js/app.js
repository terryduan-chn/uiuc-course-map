import "./demo-mode.js"; // first: in a Docs demo it swaps the storage before anything reads it
import { setUpLanguageToggle, tr, translatePage } from "./i18n.js";
import { createAuditView } from "./audit-view.js";
import { createCourseView } from "./course-view.js";
import { createDocsView } from "./docs-view.js";
import { startEffects, withPageTransition } from "./effects.js";
import { subjectHue } from "./graph-data.js";
import { createGraphView } from "./graph-view.js";
import { createMajorsView } from "./majors-view.js";
import { keepFocus, myCourses } from "./my-courses.js";
import { createPicker } from "./picker.js";
import { planButton } from "./plan-controls.js";
import { createPlanView } from "./plan-view.js";
import {
  buildGenEdQuery,
  gradeText,
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
import { termText } from "./terms.js";
import { setUpThemeToggle } from "./theme.js";

const SQL_JS_CDN = "https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.14.2/";

translatePage();

const searchInput = document.getElementById("search");
const searchArea = document.getElementById("search-area");
const navCourses = document.getElementById("nav-courses");
const navGraph = document.getElementById("nav-graph");
const navMajors = document.getElementById("nav-majors");
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
let majorsView;
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

const courseCount = (count) => tr(`${count} course${count === 1 ? "" : "s"}`, `${count} 门课程`);
const subjectCount = (count) => tr(`${count} subject${count === 1 ? "" : "s"}`, `${count} 个学科`);

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
  const within = query ? tr(` matching “${query}”`, `（匹配“${query}”）`) : "";
  if (matches.length === 0) {
    statusLine.textContent = tr(
      `No course meets ${names}${within}. Try removing a requirement.`,
      `没有课程满足 ${names}${within}。试试去掉一项要求。`,
    );
  } else {
    const shown =
      matches.length === GEN_ED_MAX_RESULTS
        ? tr(`The first ${GEN_ED_MAX_RESULTS} courses`, `前 ${GEN_ED_MAX_RESULTS} 门课程`)
        : courseCount(matches.length);
    statusLine.textContent = tr(
      `${shown} meet ${names}${within}, highest average GPA first.`,
      `${shown}满足 ${names}${within}，按平均 GPA 从高到低排列。`,
    );
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
      course.gpa == null
        ? ""
        : element("span", { className: "gpa", textContent: gradeText(course.gpa, course.fourRate) }),
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
    element("span", { className: "count", textContent: courseCount(subject.course_count) }),
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
  subjectFilterEmpty.textContent = tr(
    `No subject matches “${query}”. Try a code like MATH or a word like history.`,
    `没有匹配“${query}”的学科。试试 MATH 这样的代码，或 history 这样的词。`,
  );
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
    [counts.courses, tr("courses", "门课程")],
    [counts.subjects, tr("subjects", "个学科")],
    [counts.links, tr("prerequisite links", "条先修关系")],
    [counts.graded, tr("with GPA data", "门有 GPA 数据")],
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
        element("span", {
          className: "count",
          textContent: tr(`needed by ${course.needed_by}`, `${course.needed_by} 门课需要它`),
        }),
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
  homeMapCounts.textContent = tr(
    `needs ${data.needs.length} · unlocks ${course.needed_by}`,
    `需要 ${data.needs.length} 门 · 解锁 ${course.needed_by} 门`,
  );
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
    tr(
      `${courseCount(total)} in ${subjectCount(allSubjects.length)}. `,
      `${subjectCount(allSubjects.length)}，共 ${courseCount(total)}。`,
    ) + tr("Filter the subjects below, or search all courses above.", "可以在下方筛选学科，或在上方搜索全部课程。");
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

  if (matches.length === 0) statusLine.textContent = tr(`No course matches “${query}”.`, `没有匹配“${query}”的课程。`);
  else if (matches.length === MAX_RESULTS) {
    statusLine.textContent = tr(
      `Showing the first ${MAX_RESULTS} matches. Type more to narrow it down.`,
      `只显示前 ${MAX_RESULTS} 条结果，多输入几个字可以缩小范围。`,
    );
  } else statusLine.textContent = tr(`${courseCount(matches.length)} found.`, `找到 ${courseCount(matches.length)}。`);

  resultsList.replaceChildren(...matches.map(courseListItem));
}

function showSubjectCourses(code) {
  const subject = findSubject(code);
  listHeader.replaceChildren(
    element("a", { href: "#", className: "back-link", textContent: tr("← All subjects", "← 全部学科") }),
  );

  if (!subject) {
    statusLine.textContent = tr(`There is no subject “${code}” in the app's data.`, `数据里没有学科“${code}”。`);
    resultsList.replaceChildren();
    return;
  }

  statusLine.textContent = tr(
    `${subject.name} (${subject.code}): ${courseCount(subject.course_count)}.`,
    `${subject.name}（${subject.code}）：${courseCount(subject.course_count)}。`,
  );
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
      items.push(
        element("li", {
          className: "level-heading",
          id: `level-${level}`,
          textContent: tr(level, `${level.replace("-level", "")} 级课程`),
        }),
      );
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

/** tr("Jump to", "跳到") a course number (Enter opens it) or a level (100-level, 200-level, …). */
function jumpBar(subject, numbers, levels) {
  const input = element("input", {
    type: "search",
    className: "jump-input",
    placeholder: "e.g. 225",
    inputMode: "numeric",
    autocomplete: "off",
    ariaLabel: tr(`Jump to a ${subject} course number`, `跳到 ${subject} 的课程编号`),
  });
  const message = element("span", { className: "jump-message", role: "status" });

  const targetLink = () => {
    const number = findJumpTarget(numbers, input.value);
    return number && resultsList.querySelector(`a[href="${courseHash(subject, number)}"]`);
  };
  input.addEventListener("input", () => {
    const link = targetLink();
    message.textContent =
      link || input.value.trim() === ""
        ? ""
        : tr(`No ${subject} ${input.value.trim()}`, `没有 ${subject} ${input.value.trim()}`);
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
      title: tr(`Jump to ${level} courses`, `跳到 ${level.replace("-level", "")} 级课程`),
      onclick: () => scrollToItem(document.getElementById(`level-${level}`)),
    }),
  );

  return element(
    "div",
    { className: "jump-bar" },
    element("span", { className: "jump-label", textContent: tr("Jump to", "跳到") }),
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
  const showingMajors = !filtering && route.view === "majors";
  const ownPage = showingPlan || showingAudit || showingDocs || showingMajors; // pages with no search box or course list

  navGraph.toggleAttribute("aria-current", showingGraph);
  navMajors.toggleAttribute("aria-current", showingMajors);
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
      [showingMajors, majorsView],
    ];
    for (const [showing, view] of pages) if (!showing) view.hide();
    for (const [showing, view] of pages) if (showing) view.show(route.section);
    return;
  }
  planView.hide();
  auditView.hide();
  docsView.hide();
  majorsView.hide();
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
  // The date follows the page's language, not the computer's.
  const imported = new Date(meta.imported_at).toLocaleDateString(tr("en-US", "zh-CN"), { dateStyle: "medium" });
  sourceNote.textContent = tr(
    `Data from UIUC Course Explorer, imported ${imported}: course details from the ` +
      `${termLabel(meta.oldest_catalog_searched)} to ${currentCatalogTerm} catalogs, terms offered ` +
      `since ${oldestTermSearched}.`,
    `数据来自 UIUC Course Explorer，导入于 ${imported}：课程信息取自${termText(termLabel(meta.oldest_catalog_searched))}到` +
      `${termText(currentCatalogTerm)}的目录，开课学期从${termText(oldestTermSearched)}算起。`,
  );
  return {
    imported_at: imported,
    grades_from: meta.grades_from,
    grades_through: meta.grades_through,
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
  setUpLanguageToggle(document.getElementById("language-toggle"));
  setUpLanguageToggle(document.getElementById("language-toggle"));
  setUpThemeToggle(document.getElementById("theme-toggle"));
  try {
    db = await loadDatabase();
  } catch (error) {
    statusLine.textContent = tr(
      "Couldn't load the course data. Check your internet connection and reload the page.",
      "课程数据加载失败，请检查网络后刷新页面。",
    );
    statusLine.classList.add("error");
    console.error(error);
    return;
  }

  const importInfo = readMeta();
  docsView = createDocsView({ element, meta: importInfo });
  shownPageKind = pageKind(parseRoute(location.hash));
  startEffects({ main: document.querySelector("main") });
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
  majorsView = createMajorsView({ rows, element, getGraph: () => graphView.getGraph() });
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
    if (!["plan", "audit", "majors"].includes(parseRoute(location.hash).view)) keepFocus(render); // those pages redraw themselves
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
    noun: tr("Gen Eds", "通识要求"),
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
