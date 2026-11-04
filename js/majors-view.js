// The #majors page: every undergraduate major and concentration from the Academic Catalog, and
// one program's requirements checked against your Taken and Planned courses. Unofficial: it shows
// the catalog's wording, and doesn't work out choices like "select two".

import { tr } from "./i18n.js";
import { buildAutoPlan } from "./auto-plan.js";
import { missingRequirements } from "./graph-data.js";
import { focusKey, keepFocus, myCourses } from "./my-courses.js";
import { nextTerm, planButton } from "./plan-controls.js";
import { byCollege, byLetter, filterPrograms, programProgress, requiredCourses, rowStatus } from "./programs.js";
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
  let arrangement = "college"; // the list's groups: "college" or "letter"
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
    if (!titles.has(id))
      return element("span", { className: "major-note", textContent: tr("not in the app's data", "数据里没有") });
    return missingRequirements(getGraph(), id, taken).length === 0
      ? element("span", { className: "audit-chip ready", textContent: tr("can take now", "现在可修") })
      : "";
  }

  /** One way to meet a row: its courses, each with its own + Plan. */
  function optionLine(courses, index, row, taken) {
    const title =
      index === 0 && row.title ? row.title : courses.map((id) => titles.get(id) ?? "").join(tr(" and ", " 和 "));
    return element(
      "div",
      { className: "major-option" },
      element(
        "span",
        { className: "major-codes" },
        index > 0 ? tr("or ", "或 ") : "",
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
      item.total
        ? element("p", {
            className: "major-total",
            textContent: tr(`Total hours: ${item.total}`, `总学分：${item.total}`),
          })
        : "",
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
          ? tr("No courses added", "没有加入课程")
          : tr(
              `Added ${added.size} course${added.size === 1 ? "" : "s"}, ${termLabel(terms[0])} to ${termLabel(terms.at(-1))}`,
              `已加入 ${added.size} 门课，从 ${termLabel(terms[0])} 到 ${termLabel(terms.at(-1))}`,
            ),
      lines: [
        extra > 0
          ? tr(
              `${extra} of them ${extra === 1 ? "is a prerequisite" : "are prerequisites"} these courses need.`,
              `其中 ${extra} 门是这些课需要的先修课。`,
            )
          : "",
        missed.length > 0
          ? tr(
              `Not offered lately, so not added: ${missed.join(", ")}.`,
              `最近没有开课，所以没有加入：${missed.join("、")}。`,
            )
          : "",
        wanted.menus > 0
          ? tr(
              `${wanted.menus} list${wanted.menus === 1 ? "" : "s"} of choices left for you to pick from, plus Gen Eds and electives.`,
              `还有 ${wanted.menus} 组选课列表留给你自己选，通识和选修课也一样。`,
            )
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
        element("a", { href: "#plan", textContent: tr("See My plan →", "查看我的计划 →") }),
      ),
      element(
        "div",
        { className: "plan-change-actions" },
        undo
          ? element("button", {
              type: "button",
              className: "btn btn-primary",
              textContent: tr("Undo", "撤销"),
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
          title: tr("Close this note", "关闭这条提示"),
          ariaLabel: tr("Close this note", "关闭这条提示"),
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
        textContent: parent ? `← ${parent.name}` : tr("← All majors", "← 全部专业"),
      }),
      element("h2", { textContent: program.name }),
      element(
        "p",
        { className: "major-meta" },
        [
          program.college,
          program.total_hours && tr(`${program.total_hours} hours to graduate`, `毕业需要 ${program.total_hours} 学分`),
        ]
          .filter(Boolean)
          .join(" · "),
      ),
      listed > 0
        ? element(
            "p",
            { className: "major-progress" },
            element("strong", { textContent: done }),
            tr(" taken · ", " 门已修 · "),
            element("strong", { textContent: planned }),
            tr(" planned among the courses listed here", " 门已计划（只算这里列出的课）"),
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
                textContent: tr(
                  `Plan all ${toPlan} required course${toPlan === 1 ? "" : "s"}`,
                  `把 ${toPlan} 门必修课全部加入计划`,
                ),
                onclick: () => planAll(blocks),
              }),
              "major-plan-all",
            ),
            element("span", {
              className: "major-note",
              textContent: tr(
                `Adds them from ${termLabel(nextTerm())} on, in prerequisite order. Lists of choices, Gen Eds and electives stay for you to pick.`,
                `从 ${termLabel(nextTerm())} 起，按先修顺序排好。选课列表、通识和选修课留给你自己选。`,
              ),
            }),
          )
        : "",
      element(
        "p",
        { className: "audit-privacy" },
        tr(
          "Unofficial: this is the catalog's wording with your courses marked, not a degree check. Lines with choices like “select two” aren't worked out; your audit and advisor have the final word. ",
          "非官方：这里是目录原文加上你的课程标记，不算学位审核。“select two”这类可选项不会自动判断，最终以你的 audit 和 advisor 为准。",
        ),
        element("a", {
          href: `${CATALOG}${program.path}/`,
          target: "_blank",
          rel: "noopener",
          textContent: tr("Official catalog page ↗", "官方目录页面 ↗"),
        }),
      ),
      concentrations.length > 0 ? programLinks(tr("Concentrations", "方向"), concentrations) : "",
      blocks.length > 0
        ? element("article", { className: "major-requirements" }, ...blocks.map((item) => block(item, taken)))
        : element("p", {
            className: "plan-empty",
            textContent: tr(
              "The catalog page lists no requirements here. See the official page above.",
              "目录页面没有在这里列出要求，请看上面的官方页面。",
            ),
          }),
      planAllNote(),
    );
  }

  /** One major in the list: its link, how many concentrations, and its college when grouped by letter. */
  function majorItem(major) {
    const concentrations = major.concentrations.length;
    const details = [
      arrangement === "letter" ? major.college : "",
      concentrations > 0
        ? tr(`${concentrations} concentration${concentrations === 1 ? "" : "s"}`, `${concentrations} 个方向`)
        : "",
    ].filter(Boolean);
    return element(
      "li",
      {},
      element("a", { href: `#majors/${major.path}`, textContent: major.name }),
      details.length > 0 ? element("span", { className: "major-note", textContent: details.join(" · ") }) : "",
    );
  }

  /** The majors matching the search box, in groups, each with an anchor for the jump bar. */
  function listResults() {
    const majors = filterPrograms(programs, query);
    if (majors.length === 0) {
      return {
        groups: [],
        sections: [
          element("p", {
            className: "plan-empty",
            textContent: tr(
              `No major or concentration matches “${query.trim()}”.`,
              `没有匹配“${query.trim()}”的专业或方向。`,
            ),
          }),
        ],
      };
    }
    const groups = arrangement === "letter" ? byLetter(majors) : byCollege(majors);
    const sections = groups.map(({ label, majors: members }) =>
      element(
        "section",
        { className: "major-college" },
        element("h3", { textContent: label }),
        element("ul", {}, ...members.map(majorItem)),
      ),
    );
    return { groups, sections };
  }

  /** Buttons that jump to each group: letters, or colleges. (Links would change the page's address.) */
  function jumpBar(groups, sections) {
    return groups.map(({ label }, index) =>
      element("button", {
        type: "button",
        textContent: label,
        ariaLabel: tr(`Jump to ${label}`, `跳到 ${label}`),
        onclick: () => sections[index].scrollIntoView({ block: "start" }),
      }),
    );
  }

  function drawList() {
    const results = element("div", { className: "major-results" });
    const jumps = element("nav", {
      className: `major-jumps ${arrangement}`,
      ariaLabel: tr("Jump to a group", "跳到某一组"),
    });
    const count = element("p", { className: "major-meta", role: "status" });
    const showResults = () => {
      const { groups, sections } = listResults();
      results.replaceChildren(...sections);
      jumps.replaceChildren(...jumpBar(groups, sections));
      const shown = groups.reduce((sum, group) => sum + group.majors.length, 0);
      count.textContent = tr(`${shown} major${shown === 1 ? "" : "s"}`, `${shown} 个专业`);
    };
    showResults();
    const search = element("input", {
      type: "search",
      className: "major-search",
      placeholder: tr("Search majors and concentrations", "搜索专业和方向"),
      ariaLabel: tr("Search majors and concentrations", "搜索专业和方向"),
      value: query,
      oninput: (event) => {
        query = event.target.value;
        showResults();
      },
    });
    const arrangeButton = (value, label) =>
      focusKey(
        element("button", {
          type: "button",
          textContent: label,
          ariaPressed: String(arrangement === value),
          onclick: () => {
            arrangement = value;
            keepFocus(drawList);
          },
        }),
        `arrange-${value}`,
      );
    view.replaceChildren(
      element("h2", { textContent: tr("Majors", "专业") }),
      element("p", {
        className: "audit-lead",
        textContent: tr(
          "Every undergraduate major and concentration, from the official Academic Catalog. Open one to see its requirements with your courses marked, and plan from there.",
          "这里有官方 Academic Catalog 里的所有本科专业和方向。打开一个，就能看到它的要求和你的课程标记，并直接开始规划。",
        ),
      }),
      element(
        "div",
        { className: "major-tools" },
        search,
        element(
          "div",
          { className: "view-toggle", role: "group", ariaLabel: tr("Arrange majors", "专业排列方式") },
          arrangeButton("college", tr("By college", "按学院")),
          arrangeButton("letter", "A–Z"),
        ),
      ),
      count,
      jumps,
      results,
    );
  }

  function draw() {
    const program = shownPath && programAt(shownPath);
    if (program) drawProgram(program);
    else if (shownPath) {
      view.replaceChildren(
        element("p", {
          className: "status error",
          textContent: tr("That major isn't in the catalog list.", "目录列表里没有这个专业。"),
        }),
        element("a", { href: "#majors", className: "major-back", textContent: tr("← All majors", "← 全部专业") }),
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
