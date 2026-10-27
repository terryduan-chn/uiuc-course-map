// The #graph page: every prerequisite link at UIUC, as a 3D "galaxy" or a simpler
// 2D view of one course's neighborhood in horizontal columns.
import { buildGraph, courseId, matchCourses, mostNeeded, neighborhood, readyNext, subjectHue } from "./graph-data.js";
import { keepFocus, myCourses } from "./my-courses.js";
import { planButton } from "./plan-controls.js";
import { parseCourseCode, requirementLabel } from "./search.js";
import { createPicker } from "./picker.js";

const COLUMN_LIMIT = 30;
const MOST_NEEDED_SHOWN = 40;
const CARD_CHIPS = 12;
const SUGGESTIONS_SHOWN = 8;

/**
 * @param {{ rows: Function, element: Function }} helpers the app's SQL and DOM helpers
 */
export function createGraphView({ rows, element }) {
  const section = document.getElementById("graph-view");
  const searchInput = document.getElementById("graph-search");
  const suggestRoot = document.getElementById("graph-suggest");
  const suggestList = document.getElementById("graph-suggestions");
  const subjectRoot = document.getElementById("graph-subject");
  const status = document.getElementById("graph-status");
  const container3d = document.getElementById("graph-3d");
  const card = document.getElementById("graph-card");
  const stage = document.getElementById("graph-stage");
  const backButton = document.getElementById("graph-back");
  const container2d = document.getElementById("graph-2d");
  const modeButtons = document.querySelectorAll("#graph-mode-toggle button");
  const mineButton = document.getElementById("graph-mine");

  let graph = null;
  let positions = null;
  let mode = "3d";
  let focusedId = null;
  let highlighted = new Set();
  let filtered = null; // the courses matching the box and subject, or null for all
  let filterBeforeFocus = ""; // what the box said before a planet was clicked
  let galaxy = null; // a promise of the 3D view, once it was asked for
  let visible = false;
  let pickedSubjects = []; // from the subject menu; none means all
  let notice = ""; // why the course in the address isn't shown, kept until the map changes
  let mineOnly = false; // the My courses button: only your courses and what they open up

  // ---- Data ----

  function loadGraph() {
    if (graph) return;
    const titles = new Map(
      rows("SELECT subject || ' ' || number AS id, title FROM courses").map((r) => [r.id, r.title]),
    );
    graph = buildGraph(
      rows(
        `SELECT subject, number, prereq_subject, prereq_number, group_index, required_count, concurrent_ok
         FROM prerequisites ORDER BY rowid`,
      ),
      titles,
    );
    positions = new Map(rows("SELECT subject || ' ' || number AS id, x, y, z FROM graph_layout").map((r) => [r.id, r]));
    const countBySubject = new Map();
    for (const node of graph.nodes) countBySubject.set(node.subject, (countBySubject.get(node.subject) ?? 0) + 1);
    createPicker(subjectRoot, {
      items: rows("SELECT code, name FROM subjects ORDER BY code")
        .filter((subject) => countBySubject.has(subject.code))
        .map((subject) => ({
          code: subject.code,
          tag: subject.code,
          short: subject.code,
          name: subject.name,
          count: countBySubject.get(subject.code),
          hue: subjectHue(subject.code),
        })),
      noun: "subjects",
      onChange: (codes) => {
        pickedSubjects = codes;
        onFilterChange();
      },
    });
  }

  /** Recomputes which courses the box and the subject menu keep. */
  function updateFilter() {
    const matches = matchCourses(graph, searchInput.value, pickedSubjects);
    if (!mineOnly) {
      filtered = matches;
      return;
    }
    const mine = [...courseMarks().keys()];
    filtered = new Set(matches ? mine.filter((id) => matches.has(id)) : mine);
  }

  /** Your courses in the graph: taken, planned, and the ones they make you ready for. */
  function courseMarks() {
    const marks = new Map();
    const mine = myCourses.ids().filter((id) => graph.byId.has(id));
    for (const id of readyNext(graph, new Set(myCourses.ids()))) marks.set(id, "ready");
    for (const id of mine) marks.set(id, myCourses.status(id));
    return marks;
  }

  function filterStatus() {
    if (mineOnly && myCourses.ids().length === 0) {
      return "You haven't marked any courses yet. Press Taken or Planned on a course page, or add them on My plan.";
    }
    const what =
      [searchInput.value.trim() && `“${searchInput.value.trim()}”`, pickedSubjects.join(", ")]
        .filter(Boolean)
        .join(" in ") || "your courses";
    if (mineOnly) {
      const marks = courseMarks();
      const count = (kind) => [...filtered].filter((id) => marks.get(id) === kind).length;
      const within = searchInput.value.trim() || pickedSubjects.length > 0 ? ` matching ${what}` : "";
      return (
        `Your courses${within}: ${count("taken")} taken (green), ${count("planned")} planned (blue), ` +
        `${count("ready")} ready to take next (amber).`
      );
    }
    if (filtered.size === 0) return `No course in the graph matches ${what}.`;
    return `${filtered.size.toLocaleString("en-US")} course${filtered.size === 1 ? "" : "s"} match ${what}. Click one to see its links.`;
  }

  const graphHash = (id) => `#graph/${id.replace(" ", "-")}`;
  const byImportance = (ids) =>
    [...ids].sort((a, b) => graph.byId.get(b).dependents.length - graph.byId.get(a).dependents.length);

  /** A small course card that recenters the graph on that course. */
  function briefCard(id, extraClass = "") {
    const node = graph.byId.get(id);
    // Your own courses get the same colors as their planets in 3D.
    const mark = myCourses.status(id) ?? (mineOnly && filtered?.has(id) ? "ready" : "");
    return element(
      "a",
      {
        className: `brief-card ${extraClass} ${mark && `mark-${mark}`}`,
        href: graphHash(id),
        title: `${id}: ${node.title}`,
      },
      element("span", { className: "code", textContent: id }),
      element("span", { className: "title", textContent: node.title }),
      element("span", {
        className: "count",
        textContent: node.dependents.length === 0 ? "needed by none" : `needed by ${node.dependents.length}`,
      }),
    );
  }

  const badge = (group) =>
    element("span", {
      className: `requirement-label${group.ids.length === 1 ? " required" : ""}`,
      textContent: requirementLabel(group.required, group.ids.length),
    });

  // ---- Focus card (3D) ----

  function chips(ids) {
    const shown = ids.slice(0, CARD_CHIPS);
    return element(
      "div",
      { className: "graph-chips" },
      ...shown.map((id) => element("a", { className: "chip", href: graphHash(id), textContent: id })),
      ids.length > shown.length ? element("span", { textContent: `+${ids.length - shown.length} more` }) : "",
    );
  }

  /** "Needs": one row per requirement group, each with its "Choose 1 of 3" badge. */
  function needsGroup(node) {
    if (node.requirements.length === 0) return "";
    const intro = node.requirements.length > 1 ? `Needs (all ${node.requirements.length} requirements)` : "Needs";
    return element(
      "div",
      { className: "graph-card-group" },
      element("span", { className: "small-label", textContent: intro }),
      ...node.requirements.map((group) =>
        element("div", { className: "graph-requirement" }, badge(group), chips(group.ids)),
      ),
    );
  }

  function showCard(node) {
    card.replaceChildren(
      element("p", { className: "detail-code", textContent: node.id }),
      element("h3", { textContent: node.title }),
      needsGroup(node),
      node.dependents.length === 0
        ? ""
        : element(
            "div",
            { className: "graph-card-group" },
            element("span", { className: "small-label", textContent: `Needed by (${node.dependents.length})` }),
            chips(byImportance(node.dependents)),
          ),
      element(
        "div",
        { className: "graph-card-actions" },
        planButton(element, node.id),
        element("a", { href: `#${node.id.replace(" ", "-")}`, textContent: "Open course page" }),
        element("button", { type: "button", textContent: "See in 2D", onclick: () => setMode("2d") }),
        element("button", { type: "button", textContent: "Back to map", onclick: backToMap }),
      ),
    );
  }

  // ---- 3D ----

  function show3dFailure(message, error) {
    if (error) console.error(error);
    galaxy = null;
    setMode("2d");
    status.textContent = message;
  }

  async function draw3d({ keepCamera = false } = {}) {
    if (positions.size === 0) {
      show3dFailure("The 3D layout is missing from the data; run npm run import. Showing 2D.", null);
      return;
    }
    if (!galaxy) {
      status.textContent = "Loading the 3D view…";
      galaxy = import("./galaxy.js").then(({ createGalaxy }) =>
        createGalaxy(container3d, graph, positions, {
          onSelect: (id) => {
            location.hash = graphHash(id);
          },
        }),
      );
    }
    let view;
    try {
      view = await galaxy;
    } catch (error) {
      show3dFailure("Couldn't start the 3D view (no internet or no 3D support). Showing 2D instead.", error);
      return;
    }
    if (mode !== "3d" || !visible) return;
    view.start();
    view.show({ focusedId, highlighted, filtered, marks: courseMarks(), keepCamera });
    if (focusedId) status.textContent = `${focusedId} and its links. Click another planet, or “Back to map”.`;
    else if (filtered) status.textContent = filterStatus();
    else
      status.textContent =
        notice ||
        `${graph.nodes.length.toLocaleString("en-US")} courses, ${graph.links.length.toLocaleString("en-US")} prerequisite links. Drag to turn, scroll to zoom, click a planet.`;
  }

  // ---- 2D ----

  function column(title, ids, emptyText) {
    const shown = ids.slice(0, COLUMN_LIMIT);
    return element(
      "section",
      { className: "graph-column" },
      element("h3", { textContent: `${title} (${ids.length})` }),
      ids.length === 0 ? element("p", { className: "graph-empty", textContent: emptyText }) : "",
      ...shown.map((id) => briefCard(id)),
      ids.length > shown.length
        ? element("p", { className: "graph-empty", textContent: `and ${ids.length - shown.length} more` })
        : "",
    );
  }

  /** The direct prerequisites, split into their requirement groups with badges. */
  function requirementsColumn(node) {
    const groups = node.requirements;
    return element(
      "section",
      { className: "graph-column" },
      element("h3", {
        textContent: groups.length > 1 ? `Prerequisites (meet all ${groups.length})` : "Prerequisites",
      }),
      groups.length === 0 ? element("p", { className: "graph-empty", textContent: "No prerequisites." }) : "",
      ...groups.map((group) =>
        element(
          "div",
          { className: "graph-requirement-group" },
          badge(group),
          ...byImportance(group.ids).map((id) => briefCard(id)),
        ),
      ),
    );
  }

  function render2d() {
    if (!focusedId && filtered) {
      const matches = byImportance(filtered);
      const shown = matches.slice(0, MOST_NEEDED_SHOWN);
      container2d.replaceChildren(
        element("div", { className: "brief-grid" }, ...shown.map((id) => briefCard(id))),
        matches.length > shown.length
          ? element("p", {
              className: "graph-empty",
              textContent: `and ${matches.length - shown.length} more; type more to narrow it down.`,
            })
          : "",
      );
      status.textContent = filterStatus();
      return;
    }
    if (!focusedId) {
      container2d.replaceChildren(
        element("h3", {
          className: "graph-2d-heading",
          textContent: "Most needed courses: pick one to see what leads to it",
        }),
        element("div", { className: "brief-grid" }, ...mostNeeded(graph, MOST_NEEDED_SHOWN).map((id) => briefCard(id))),
      );
      status.textContent = notice || `${graph.nodes.length.toLocaleString("en-US")} courses have prerequisite links.`;
      return;
    }
    const around = neighborhood(graph, focusedId);
    const node = graph.byId.get(focusedId);
    const center = element(
      "section",
      { className: "graph-column center" },
      element("h3", { textContent: "This course" }),
      briefCard(focusedId, "focused"),
      element("a", {
        className: "graph-open-link",
        href: `#${focusedId.replace(" ", "-")}`,
        textContent: "Open course page →",
      }),
      element("p", {
        className: "graph-empty",
        textContent: `${node.requirements.length} requirement${node.requirements.length === 1 ? "" : "s"}, needed by ${node.dependents.length}.`,
      }),
    );
    container2d.replaceChildren(
      element(
        "div",
        { className: "graph-columns" },
        column("2 steps before", around.before2, "Nothing further back."),
        requirementsColumn(node),
        center,
        column("Unlocks", around.after1, "No course lists it as a prerequisite."),
        column("2 steps after", around.after2, "Nothing further ahead."),
      ),
    );
    status.textContent = `${focusedId}: what it needs on the left, what it unlocks on the right.`;
  }

  // ---- Mode and focus ----

  // Not remembered between visits: the star map always opens in 3D (Zongyan's choice).
  function setMode(newMode) {
    mode = newMode;
    draw();
  }

  function draw({ keepCamera = false } = {}) {
    for (const button of modeButtons) {
      button.setAttribute("aria-pressed", String(button.dataset.view === mode));
    }
    const is3d = mode === "3d";
    container3d.hidden = !is3d;
    container2d.hidden = is3d;
    card.hidden = !is3d || !focusedId;
    stage.classList.toggle("with-card", !card.hidden);
    backButton.hidden = !is3d || !focusedId;
    if (is3d) {
      if (focusedId) showCard(graph.byId.get(focusedId));
      draw3d({ keepCamera });
    } else {
      galaxy?.then((view) => view.stop()).catch(() => {});
      render2d();
    }
  }

  /** The course the box names exactly, if it is in the graph ("CS 225", "cs225"). */
  function exactCourse() {
    const code = parseCourseCode(searchInput.value);
    const id = code && courseId(code.subject, code.number);
    return id && graph.byId.has(id) ? id : null;
  }

  /** Enter: open the course the box names, or the only match. */
  function findCourse() {
    const id = exactCourse() ?? (filtered?.size === 1 ? [...filtered][0] : null);
    if (id) location.hash = graphHash(id);
  }

  // The map follows the box as you type: a full code focuses that course, anything else filters.
  function onFilterChange() {
    const id = exactCourse();
    if (id && (pickedSubjects.length === 0 || pickedSubjects.includes(graph.byId.get(id).subject))) {
      if (id !== focusedId) location.hash = graphHash(id);
      return;
    }
    updateFilter();
    if (focusedId) {
      filterBeforeFocus = searchInput.value;
      location.hash = "#graph"; // show() redraws without the focus
    } else {
      draw();
    }
  }

  /** Leaves the focused course, back to the whole map or the filter typed before. */
  function backToMap() {
    location.hash = "#graph";
  }
  backButton.addEventListener("click", backToMap);

  // ---- Suggestions under the search box ----

  let suggestions = []; // course ids shown in the menu
  let activeSuggestion = -1; // the one picked with the arrow keys

  function setSuggestionsOpen(open) {
    suggestRoot.classList.toggle("open", open);
    searchInput.setAttribute("aria-expanded", String(open));
  }

  /** The best matches for the box: an exact code first, then the most-needed matches. */
  function updateSuggestions() {
    const text = searchInput.value.trim();
    const matches = text && graph ? matchCourses(graph, text, pickedSubjects) : null;
    const exact = text && graph ? exactCourse() : null;
    suggestions = matches ? byImportance(matches).filter((id) => id !== exact) : [];
    if (exact) suggestions.unshift(exact);
    suggestions = suggestions.slice(0, SUGGESTIONS_SHOWN);
    activeSuggestion = -1;
    suggestList.replaceChildren(
      ...suggestions.map((id, i) => {
        const node = graph.byId.get(id);
        const option = element(
          "li",
          { className: "picker-option suggestion", id: `suggestion-${i}` },
          element("span", { className: "code", textContent: id }),
          element("span", { className: "name", textContent: node.title }),
          element("span", { className: "count", textContent: `needed by ${node.dependents.length}` }),
        );
        option.style.setProperty("--hue", subjectHue(node.subject));
        option.style.setProperty("--i", i);
        option.setAttribute("role", "option");
        // mousedown, so the box doesn't lose focus (and close the menu) before the click lands
        option.addEventListener("mousedown", (event) => {
          event.preventDefault();
          openSuggestion(id);
        });
        return option;
      }),
    );
    setSuggestionsOpen(suggestions.length > 0 && document.activeElement === searchInput);
  }

  function openSuggestion(id) {
    setSuggestionsOpen(false);
    location.hash = graphHash(id);
  }

  function moveSuggestion(step) {
    if (suggestions.length === 0) return;
    activeSuggestion = (activeSuggestion + step + suggestions.length) % suggestions.length;
    [...suggestList.children].forEach((option, i) =>
      option.setAttribute("aria-selected", String(i === activeSuggestion)),
    );
    searchInput.setAttribute("aria-activedescendant", `suggestion-${activeSuggestion}`);
    suggestList.children[activeSuggestion].scrollIntoView({ block: "nearest" });
  }

  searchInput.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setSuggestionsOpen(suggestions.length > 0);
      moveSuggestion(event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Enter") {
      if (activeSuggestion >= 0) openSuggestion(suggestions[activeSuggestion]);
      else findCourse();
    } else if (event.key === "Escape") {
      setSuggestionsOpen(false);
    }
  });
  searchInput.addEventListener("input", () => {
    onFilterChange();
    updateSuggestions();
  });
  searchInput.addEventListener("focus", updateSuggestions);
  searchInput.addEventListener("blur", () => setSuggestionsOpen(false));
  for (const button of modeButtons) {
    button.addEventListener("click", () => setMode(button.dataset.view));
  }
  mineButton.addEventListener("click", () => {
    mineOnly = !mineOnly;
    mineButton.setAttribute("aria-pressed", String(mineOnly));
    if (focusedId)
      location.hash = "#graph"; // show() redraws with the new filter
    else {
      updateFilter();
      draw();
    }
  });
  // Marking a course (here, on another page or in another tab) recolors the map where it is,
  // without moving the camera.
  myCourses.onChange(() => {
    if (!visible || !graph) return;
    updateFilter();
    keepFocus(() => draw({ keepCamera: true }));
  });

  return {
    /** The prerequisite graph (loaded on first use), for pages that check prerequisites. */
    getGraph() {
      loadGraph();
      return graph;
    },
    /** Shows the graph, focused on route.subject/number if given. */
    show(route) {
      visible = true;
      section.hidden = false;
      loadGraph();
      const id = route.subject ? courseId(route.subject, route.number) : null;
      const known = Boolean(id && graph.byId.has(id));
      focusedId = known ? id : null;
      const node = known && graph.byId.get(id);
      highlighted = node ? new Set([id, ...node.prerequisites, ...node.dependents]) : new Set();
      if (focusedId && searchInput.value !== focusedId) {
        // Remember the filter (unless the box already named this course) to return to it.
        filterBeforeFocus = parseCourseCode(searchInput.value) ? "" : searchInput.value;
        searchInput.value = focusedId;
      } else if (!focusedId && graph.byId.has(searchInput.value)) {
        searchInput.value = filterBeforeFocus;
      }
      notice = "";
      if (id && !known) {
        const exists =
          rows("SELECT 1 FROM courses WHERE subject = ? AND number = ?", [route.subject, route.number]).length > 0;
        notice = exists
          ? `${id} has no prerequisite links (it needs nothing and nothing needs it), so it isn't on the map.`
          : `There's no course ${id} in the app's data.`;
      }
      updateFilter();
      draw();
    },
    hide() {
      visible = false;
      section.hidden = true;
      // Stop drawing frames while the page is elsewhere.
      galaxy?.then((view) => view.stop()).catch(() => {});
    },
  };
}
