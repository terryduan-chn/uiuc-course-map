// The #majors page: every undergraduate major and concentration from the Academic Catalog, and
// one program's requirements checked against your Taken and Planned courses. Unofficial: it shows
// the catalog's wording, and doesn't work out choices like "select two".

import { buildAutoPlan } from "./auto-plan.js";
import { missingRequirements } from "./graph-data.js";
import { focusKey, keepFocus, myCourses } from "./my-courses.js";
import { nextTerm, planButton } from "./plan-controls.js";
import { filterPrograms, programProgress, requiredCourses, rowStatus } from "./programs.js";
import { courseFacts } from "./requirement-courses.js";
import { splitCourseCodes } from "./search.js";
import { termLabel, termOrder } from "./terms.js";

const CATALOG = "https://catalog.illinois.edu/undergraduate/";
const courseHash = (id) => `#${id.replace(" ", "-")}`;

/**
 * @param {{ rows: Function, element: Function, getGraph: () => object }} helpers
 */
export function createMajorsView({ rows, element, getGraph }) {
  const view = document.getElementById("majors-view");
  const programs = rows("SELECT path, name, parent, college, total_hours FROM programs ORDER BY name");
  let titles = null; // course id -> title, looked up the first time a program opens
  let shownPath = null; // the program showing, or null for the list
  let query = "";
  let planNote = null; // what the latest Plan all did: { title, lines, undo }

  const programAt = (path) => programs.find((program) => program.path === path);
  const statusOf = (id) => myCourses.status(id);

  /** A course's name for the page: a link if the app has the course, else plain text. */
  function courseLink(id) {
    if (!titles.has(id)) return element("span", { className: "major-code", textContent: id });
    return element("a", { href: courseHash(id), className: "major-code", textContent: id });
  }

  /** Catalog wording with its course codes turned into links. */
  function wording(text) {
    return splitCourseCodes(text).map((part) => (part.subject ? courseLink(part.text) : part.text));
  }

  /** How a course stands for this student: taken, planned, can be taken now, or nothing to say. */
  function standing(id, taken) {
    const status = statusOf(id);
    if (status) return "";
    if (!titles.has(id)) return element("span", { className: "major-note", textContent: "not in the app's data" });
    return missingRequirements(getGraph(), id, taken).length === 0
      ? element("span", { className: "audit-chip ready", textContent: "can take now" })
      : "";
  }

  /** One way to meet a row: its courses, each with its own + Plan. */
  function optionLine(courses, index, row, taken) {
    const title = index === 0 && row.title ? row.title : courses.map((id) => titles.get(id) ?? "").join(" and ");
    return element(
      "div",
      { className: "major-option" },
      element(
        "span",
        { className: "major-codes" },
        index > 0 ? "or " : "",
        ...courses.flatMap((id, position) => (position > 0 ? [" & ", courseLink(id)] : [courseLink(id)])),
      ),
      element("span", { className: "major-title" }, ...wording(title)),
      element("span", { className: "major-hours", textContent: index === 0 ? row.hours : "" }),
      element(
        "span",
        { className: "major-actions" },
        ...courses.flatMap((id) =>
          titles.has(id) ? [standing(id, taken), planButton(element, id)] : [standing(id, taken)],
        ),
      ),
    );
  }

  function tableRow(row, taken) {
    if (row.type === "course") {
      const status = rowStatus(row, statusOf);
      return element(
        "li",
        { className: `major-row ${status ?? ""}` },
        ...row.options.map((courses, index) => optionLine(courses, index, row, taken)),
      );
    }
    return element(
      "li",
      { className: `major-${row.type}` },
      element("span", {}, ...wording(row.text)),
      row.hours ? element("span", { className: "major-hours", textContent: row.hours }) : "",
    );
  }

  /** One block of a program's requirements. */
  function block(item, taken) {
    if (item.heading) return element("h3", { textContent: item.heading });
    if (item.text) return element("p", {}, ...wording(item.text));
    return element(
      "section",
      { className: "major-table" },
      element("ul", {}, ...item.rows.map((row) => tableRow(row, taken))),
      item.total ? element("p", { className: "major-total", textContent: `Total hours: ${item.total}` }) : "",
    );
  }

  /**
   * Plans a program's required courses from next semester on, in prerequisite order, using
   * Auto-plan's scheduling. Prerequisites it needs come too. Nothing in the plan moves.
   */
  function planAll(blocks) {
    const wanted = requiredCourses(blocks, statusOf);
    const undo = myCourses.snapshot();
    const toPart = ({ id, reason }) => {
      const [subject, number] = id.split(" ");
      return {
        label: "1",
        title: reason,
        needs: { courses: 1 },
        selectFrom: [{ subject, number }],
        notFrom: [],
        courses: [],
      };
    };
    const result = buildAutoPlan({
      sections: [{ title: "PROGRAM", needs: null, notes: [], courses: [], parts: wanted.courses.map(toPart) }],
      candidates: (part) => [`${part.selectFrom[0].subject} ${part.selectFrom[0].number}`],
      facts: courseFacts(rows),
      graph: getGraph(),
      taken: new Set(myCourses.ids("taken")),
      planned: myCourses.ids("planned").map((id) => ({ id, term: myCourses.term(id) })),
      startTerm: nextTerm(),
    });
    const added = new Set(result.courses.map((course) => course.id));
    const missed = wanted.courses.map((course) => course.id).filter((id) => !added.has(id));
    const extra = result.courses.filter((course) => !wanted.courses.some(({ id }) => id === course.id)).length;
    const terms = result.courses.map((course) => course.term).sort((a, b) => termOrder(a) - termOrder(b));
    planNote = {
      title:
        added.size === 0
          ? "No courses added"
          : `Added ${added.size} course${added.size === 1 ? "" : "s"}, ${termLabel(terms[0])} to ${termLabel(terms.at(-1))}`,
      lines: [
        extra > 0
          ? `${extra} of them ${extra === 1 ? "is a prerequisite" : "are prerequisites"} these courses need.`
          : "",
        missed.length > 0 ? `Not offered lately, so not added: ${missed.join(", ")}.` : "",
        wanted.menus > 0
          ? `${wanted.menus} list${wanted.menus === 1 ? "" : "s"} of choices left for you to pick from, plus Gen Eds and electives.`
          : "",
      ].filter(Boolean),
      undo: added.size > 0 ? undo : null,
    };
    if (added.size > 0) myCourses.addAuto(result.courses);
    else keepFocus(draw);
  }

  /** What the latest Plan all did, with Undo. */
  function planAllNote() {
    if (!planNote) return "";
    const { title, lines, undo } = planNote;
    return element(
      "section",
      { className: "plan-change", role: "status" },
      element(
        "div",
        { className: "plan-change-text" },
        element("strong", { textContent: title }),
        ...lines.map((line) => element("p", { textContent: line })),
        element("a", { href: "#plan", textContent: "See My plan →" }),
      ),
      element(
        "div",
        { className: "plan-change-actions" },
        undo
          ? element("button", {
              type: "button",
              className: "btn btn-primary",
              textContent: "Undo",
              onclick: () => {
                planNote = null;
                myCourses.restore(undo);
              },
            })
          : "",
        element("button", {
          type: "button",
          className: "plan-remove",
          textContent: "✕",
          title: "Close this note",
          ariaLabel: "Close this note",
          onclick: () => {
            planNote = null;
            keepFocus(draw);
          },
        }),
      ),
    );
  }

  function programLinks(title, list) {
    return element(
      "section",
      { className: "major-links" },
      element("h3", { textContent: title }),
      element(
        "ul",
        {},
        ...list.map((program) =>
          element("li", {}, element("a", { href: `#majors/${program.path}`, textContent: program.name })),
        ),
      ),
    );
  }

  function drawProgram(program) {
    titles ??= new Map(rows("SELECT subject || ' ' || number AS id, title FROM courses").map((c) => [c.id, c.title]));
    const [{ requirements }] = rows("SELECT requirements FROM programs WHERE path = :path", { ":path": program.path });
    const blocks = JSON.parse(requirements);
    const taken = new Set(myCourses.ids("taken"));
    const parent = program.parent ? programAt(program.parent) : null;
    const concentrations = programs.filter((other) => other.parent === program.path);
    const { taken: done, planned, listed } = programProgress(blocks, statusOf);
    const toPlan = requiredCourses(blocks, statusOf).courses.length;
    view.replaceChildren(
      element("a", {
        href: parent ? `#majors/${parent.path}` : "#majors",
        className: "major-back",
        textContent: parent ? `← ${parent.name}` : "← All majors",
      }),
      element("h2", { textContent: program.name }),
      element(
        "p",
        { className: "major-meta" },
        [program.college, program.total_hours && `${program.total_hours} hours to graduate`]
          .filter(Boolean)
          .join(" · "),
      ),
      listed > 0
        ? element(
            "p",
            { className: "major-progress" },
            element("strong", { textContent: done }),
            " taken · ",
            element("strong", { textContent: planned }),
            " planned among the courses listed here",
          )
        : "",
      toPlan > 0
        ? element(
            "div",
            { className: "major-plan-all" },
            focusKey(
              element("button", {
                type: "button",
                className: "btn btn-primary",
                textContent: `Plan all ${toPlan} required course${toPlan === 1 ? "" : "s"}`,
                onclick: () => planAll(blocks),
              }),
              "major-plan-all",
            ),
            element("span", {
              className: "major-note",
              textContent: `Adds them from ${termLabel(nextTerm())} on, in prerequisite order. Lists of choices, Gen Eds and electives stay for you to pick.`,
            }),
          )
        : "",
      element(
        "p",
        { className: "audit-privacy" },
        "Unofficial: this is the catalog's wording with your courses marked, not a degree check. Lines with choices like “select two” aren't worked out; your audit and advisor have the final word. ",
        element("a", {
          href: `${CATALOG}${program.path}/`,
          target: "_blank",
          rel: "noopener",
          textContent: "Official catalog page ↗",
        }),
      ),
      concentrations.length > 0 ? programLinks("Concentrations", concentrations) : "",
      blocks.length > 0
        ? element("article", { className: "major-requirements" }, ...blocks.map((item) => block(item, taken)))
        : element("p", {
            className: "plan-empty",
            textContent: "The catalog page lists no requirements here. See the official page above.",
          }),
      planAllNote(),
    );
  }

  /** The majors matching the search box, by college. */
  function listResults() {
    const majors = filterPrograms(programs, query);
    if (majors.length === 0) {
      return [
        element("p", { className: "plan-empty", textContent: `No major or concentration matches “${query.trim()}”.` }),
      ];
    }
    const colleges = [...new Set(majors.map((major) => major.college))].sort();
    return colleges.map((college) =>
      element(
        "section",
        { className: "major-college" },
        element("h3", { textContent: college }),
        element(
          "ul",
          {},
          ...majors
            .filter((major) => major.college === college)
            .map((major) =>
              element(
                "li",
                {},
                element("a", { href: `#majors/${major.path}`, textContent: major.name }),
                major.concentrations.length > 0
                  ? element("span", {
                      className: "major-note",
                      textContent: `${major.concentrations.length} concentration${major.concentrations.length === 1 ? "" : "s"}`,
                    })
                  : "",
              ),
            ),
        ),
      ),
    );
  }

  function drawList() {
    const results = element("div", { className: "major-results" }, ...listResults());
    const count = element("p", { className: "major-meta", role: "status" });
    const showCount = () => {
      const shown = filterPrograms(programs, query).length;
      count.textContent = `${shown} major${shown === 1 ? "" : "s"}`;
    };
    showCount();
    const search = element("input", {
      type: "search",
      className: "major-search",
      placeholder: "Search majors and concentrations",
      ariaLabel: "Search majors and concentrations",
      value: query,
      oninput: (event) => {
        query = event.target.value;
        results.replaceChildren(...listResults());
        showCount();
      },
    });
    view.replaceChildren(
      element("h2", { textContent: "Majors" }),
      element("p", {
        className: "audit-lead",
        textContent:
          "Every undergraduate major and concentration, from the official Academic Catalog. Open one to see its requirements with your courses marked, and plan from there.",
      }),
      search,
      count,
      results,
    );
  }

  function draw() {
    const program = shownPath && programAt(shownPath);
    if (program) drawProgram(program);
    else if (shownPath) {
      view.replaceChildren(
        element("p", { className: "status error", textContent: "That major isn't in the catalog list." }),
        element("a", { href: "#majors", className: "major-back", textContent: "← All majors" }),
      );
    } else drawList();
  }

  myCourses.onChange(() => {
    if (!view.hidden) keepFocus(draw);
  });

  return {
    /** Shows one program by its path, or the list. */
    show(path) {
      view.hidden = false;
      if (path !== shownPath) planNote = null;
      shownPath = path;
      draw();
    },
    hide() {
      view.hidden = true;
      planNote = null;
    },
  };
}
