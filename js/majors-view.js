// The #majors page: every undergraduate major and concentration from the Academic Catalog, and
// one program's requirements checked against your Taken and Planned courses. Unofficial: it shows
// the catalog's wording, and doesn't work out choices like "select two".

import { tr } from "./i18n.js";
import { buildAutoPlan } from "./auto-plan.js";
import { missingRequirements, subjectHue } from "./graph-data.js";
import { focusKey, keepFocus, myCourses } from "./my-courses.js";
import { nextTerm, planButton } from "./plan-controls.js";
import { myMajor, planProgram } from "./my-major.js";
import {
  byCollege,
  byLetter,
  degreeHours,
  filterPrograms,
  focusAreas,
  programProgress,
  requiredCourses,
  rowStatus,
} from "./programs.js";
import { courseFacts } from "./requirement-courses.js";
import { splitCourseCodes } from "./search.js";
import { termLabel, termOrder } from "./terms.js";

const CATALOG = "https://catalog.illinois.edu/undergraduate/";
const courseHash = (id) => `#${id.replace(" ", "-")}`;
const VIEW_KEY = "majorView";

/** "Computer Science, BS" as its title and degree. */
function degreeParts(name) {
  const comma = name.lastIndexOf(", ");
  return comma < 0 ? { title: name, degree: "" } : { title: name.slice(0, comma), degree: name.slice(comma + 2) };
}

function savedView() {
  try {
    return localStorage.getItem(VIEW_KEY) === "list" ? "list" : "cards";
  } catch {
    return "cards"; // storage can be blocked (private windows)
  }
}

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
  let listView = savedView(); // "cards" or "list", as on the home page
  let planNote = null; // what the latest plan did: { title, lines, undo }

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

  /** One block of a program's requirements, without the rows in `shownElsewhere`. */
  function block(item, taken, shownElsewhere) {
    if (item.heading) return element("h3", { textContent: item.heading });
    if (item.text) return element("p", {}, ...wording(item.text));
    const rowsHere = item.rows.filter((row) => !shownElsewhere.has(row));
    return element(
      "section",
      { className: "major-table" },
      element("ul", {}, ...rowsHere.map((row) => tableRow(row, taken))),
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

  /** Makes a program My major and plans it to graduation. */
  function planDegree(program) {
    const undo = myCourses.snapshot();
    myMajor.set(program.path);
    const result = planProgram({ rows, graph: getGraph(), path: program.path });
    const terms = [...result.courses, ...result.slots].map((item) => item.term);
    terms.sort((a, b) => termOrder(a) - termOrder(b));
    const courses = result.courses.length;
    const slots = result.slots.length;
    planNote = {
      title:
        terms.length === 0
          ? tr("Nothing to add: your plan already covers this degree", "没有可添加的：你的计划已经覆盖这个学位")
          : tr(
              `Planned ${courses} course${courses === 1 ? "" : "s"} and ${slots} slot${slots === 1 ? "" : "s"}, ${termLabel(terms[0])} to ${termLabel(terms.at(-1))}`,
              `已规划 ${courses} 门课和 ${slots} 个空位，从 ${termLabel(terms[0])} 到 ${termLabel(terms.at(-1))}`,
            ),
      lines: [
        result.focusArea ? tr(`Focus area: ${result.focusArea}.`, `重点方向：${result.focusArea}。`) : "",
        tr(
          "Slots are Gen Eds and electives: press Pick on one to choose a course.",
          "空位是通识和选修课：点空位上的“选课”就能选一门。",
        ),
        ...result.open.map(({ title, text }) => tr(`${title}: ${text}`, `${title}：${text}`)),
      ].filter(Boolean),
      undo,
    };
    keepFocus(draw);
  }

  /** What the latest plan did, with Undo. */
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

  /** A program's concentrations, as cards. */
  function concentrationCards(list) {
    return element(
      "section",
      { className: "major-section" },
      element("h3", { textContent: tr("Concentrations", "方向") }),
      element(
        "ul",
        { className: "subject-grid" },
        ...list.map((program) =>
          element(
            "li",
            {},
            element(
              "a",
              { href: `#majors/${program.path}`, className: "subject-card" },
              element("span", { className: "name", textContent: program.name }),
              element("span", {
                className: "count",
                textContent: myMajor.path() === program.path ? tr("My major", "我的专业") : "",
              }),
            ),
          ),
        ),
      ),
    );
  }

  /** The focus areas to pick from, with the picked one's courses. */
  function focusSection(program, areas, taken) {
    const chosen = areas.find((area) => area.name === myMajor.focus(program.path));
    const pick = (area) =>
      focusKey(
        element(
          "button",
          {
            type: "button",
            className: "subject-card",
            ariaPressed: String(area === chosen),
            onclick: () => {
              myMajor.setFocus(program.path, area === chosen ? null : area.name);
              keepFocus(draw);
            },
          },
          element("span", { className: "name", textContent: area.name }),
          element("span", {
            className: "count",
            textContent: tr(`${area.rows.length} courses`, `${area.rows.length} 门课`),
          }),
        ),
        `focus-${area.name}`,
      );
    return element(
      "section",
      { className: "major-section" },
      element("h3", { textContent: tr("Focus areas", "重点方向") }),
      element("p", {
        className: "major-note",
        textContent: tr(
          `The catalog gives this degree focus areas instead of concentrations: at least ${areas[0].need} of your technical electives come from one of them. Pick one to see its courses. Plan my degree uses it.`,
          `目录没有给这个学位设方向，而是设了重点方向：技术选修课里至少 ${areas[0].need} 门要来自同一个重点方向。选一个就能看到它的课程，“规划我的学位”也会用它。`,
        ),
      }),
      element("ul", { className: "subject-grid" }, ...areas.map((area) => element("li", {}, pick(area)))),
      chosen
        ? element(
            "section",
            { className: "major-table major-focus-courses" },
            element("ul", {}, ...chosen.rows.map((row) => tableRow(row, taken))),
          )
        : "",
    );
  }

  /** The box for planning a program: its buttons and how far along you are. */
  function planBox(program, blocks, hasConcentrations) {
    const { taken: done, planned, listed } = programProgress(blocks, statusOf);
    const toPlan = requiredCourses(blocks, statusOf).courses.length;
    const isMine = myMajor.path() === program.path;
    const progress =
      listed > 0
        ? element(
            "p",
            { className: "major-progress" },
            element("strong", { textContent: done }),
            tr(" taken · ", " 门已修 · "),
            element("strong", { textContent: planned }),
            tr(" planned among the courses listed here", " 门已计划（只算这里列出的课）"),
          )
        : "";
    if (hasConcentrations) {
      return element(
        "section",
        { className: "major-plan" },
        progress,
        element("p", {
          className: "major-note",
          textContent: tr(
            "Each concentration has its own requirements. Open one below to plan this degree.",
            "每个方向的要求都不一样。打开下面的一个方向，就能规划这个学位。",
          ),
        }),
      );
    }
    const button = (className, textContent, key, onclick) =>
      focusKey(element("button", { type: "button", className, textContent, onclick }), key);
    return element(
      "section",
      { className: "major-plan" },
      progress,
      element(
        "div",
        { className: "major-plan-actions" },
        button("btn btn-primary", tr("Plan my degree", "规划我的学位"), "major-plan-degree", () => planDegree(program)),
        button(
          "btn btn-ghost",
          isMine ? tr("✓ My major", "✓ 我的专业") : tr("Make this my major", "设为我的专业"),
          "major-mine",
          () => {
            myMajor.set(isMine ? null : program.path);
            keepFocus(draw);
          },
        ),
        toPlan > 0
          ? button(
              "btn btn-ghost",
              tr(`Add only the ${toPlan} required`, `只加 ${toPlan} 门必修课`),
              "major-plan-all",
              () => planAll(blocks),
            )
          : "",
      ),
      element("p", {
        className: "major-note",
        textContent: tr(
          `Plan my degree fills ${termLabel(nextTerm())} to graduation: required courses, picks from the lists, and slots for Gen Eds and electives. Courses you planned yourself stay.`,
          `“规划我的学位”会从 ${termLabel(nextTerm())} 一直排到毕业：必修课、列表里选出的课，以及通识和选修空位。你自己计划的课保持不变。`,
        ),
      }),
    );
  }

  function drawProgram(program) {
    titles ??= new Map(rows("SELECT subject || ' ' || number AS id, title FROM courses").map((c) => [c.id, c.title]));
    const [{ requirements }] = rows("SELECT requirements FROM programs WHERE path = :path", { ":path": program.path });
    const blocks = JSON.parse(requirements);
    const taken = new Set(myCourses.ids("taken"));
    const parent = program.parent ? programAt(program.parent) : null;
    const concentrations = programs.filter((other) => other.parent === program.path);
    const areas = focusAreas(blocks);
    const inFocusSection = new Set(areas.flatMap((area) => [area.header, ...area.rows]));
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
          degreeHours(program.total_hours) &&
            tr(`${program.total_hours} hours to graduate`, `毕业需要 ${program.total_hours} 学分`),
        ]
          .filter(Boolean)
          .join(" · "),
      ),
      planBox(program, blocks, concentrations.length > 0),
      planAllNote(),
      concentrations.length > 0 ? concentrationCards(concentrations) : "",
      areas.length > 0 ? focusSection(program, areas, taken) : "",
      blocks.length > 0
        ? element(
            "article",
            { className: "major-requirements" },
            ...blocks.map((item) => block(item, taken, inFocusSection)),
          )
        : element("p", {
            className: "plan-empty",
            textContent: tr(
              "The catalog page lists no requirements here. See the official page below.",
              "目录页面没有在这里列出要求，请看下面的官方页面。",
            ),
          }),
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
    );
  }

  /** One major in the list, shaped like a subject card: degree, name, then its details. */
  function majorCard(major) {
    const concentrations = major.concentrations.length;
    const { title, degree } = degreeParts(major.name);
    const mine = [major.path, ...major.concentrations.map((program) => program.path)].includes(myMajor.path());
    const details = [
      mine ? tr("My major", "我的专业") : "",
      arrangement === "letter" ? major.college : "",
      concentrations > 0
        ? tr(`${concentrations} concentration${concentrations === 1 ? "" : "s"}`, `${concentrations} 个方向`)
        : "",
    ].filter(Boolean);
    const card = element(
      "a",
      { href: `#majors/${major.path}`, className: "subject-card", title: major.name },
      element("span", { className: "code", textContent: degree || tr("Major", "专业") }),
      element("span", { className: "name", textContent: title }),
      element("span", { className: "count", textContent: details.join(" · ") }),
    );
    card.style.setProperty("--hue", subjectHue(major.college)); // one color per college
    return element("li", {}, card);
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
        element("ul", { className: `subject-grid ${listView === "list" ? "as-list" : ""}` }, ...members.map(majorCard)),
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
      className: "subject-filter",
      placeholder: tr("Search majors and concentrations", "搜索专业和方向"),
      ariaLabel: tr("Search majors and concentrations", "搜索专业和方向"),
      value: query,
      oninput: (event) => {
        query = event.target.value;
        showResults();
      },
    });
    const toggleButton = (label, pressed, key, choose) =>
      focusKey(
        element("button", {
          type: "button",
          textContent: label,
          ariaPressed: String(pressed),
          onclick: () => {
            choose();
            keepFocus(drawList);
          },
        }),
        key,
      );
    const arrangeButton = (value, label) =>
      toggleButton(label, arrangement === value, `arrange-${value}`, () => {
        arrangement = value;
      });
    const viewButton = (value, label) =>
      toggleButton(label, listView === value, `view-${value}`, () => {
        listView = value;
        try {
          localStorage.setItem(VIEW_KEY, value);
        } catch {
          // Not remembered, but the view still changes.
        }
      });
    view.replaceChildren(
      element(
        "div",
        { className: "subjects-header" },
        element("h2", { textContent: tr("Majors", "专业") }),
        element(
          "div",
          { className: "subjects-tools" },
          search,
          element(
            "div",
            { className: "view-toggle", role: "group", ariaLabel: tr("Arrange majors", "专业排列方式") },
            arrangeButton("college", tr("By college", "按学院")),
            arrangeButton("letter", "A–Z"),
          ),
          element(
            "div",
            { className: "view-toggle", role: "group", ariaLabel: tr("Show majors as", "专业显示方式") },
            viewButton("cards", tr("Cards", "卡片")),
            viewButton("list", tr("List", "列表")),
          ),
        ),
      ),
      element("p", {
        className: "major-meta",
        textContent: tr(
          "Every undergraduate major and concentration, from the official Academic Catalog. Open one to see its requirements and plan the degree.",
          "这里有官方 Academic Catalog 里的所有本科专业和方向。打开一个，就能看到要求并规划学位。",
        ),
      }),
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
