// The course page: its official details, prerequisites, GPA and sources, and the panel for
// marking it taken, in progress or planned.

import { tr } from "./i18n.js";
import { missingRequirements } from "./graph-data.js";
import { focusKey, myCourses } from "./my-courses.js";
import { issueBadges, nextTerm, planControls, planCourses } from "./plan-controls.js";
import {
  bestTerm,
  courseIssues,
  describeMissing,
  seasonsText,
  slotKindsOf,
  slotNames,
  slotsFilledBy,
  reasonText,
} from "./plan-insights.js";
import { courseFacts } from "./requirement-courses.js";
import {
  courseExplorerPage,
  descriptionWithoutPrerequisite,
  formatCreditHours,
  requirementLabel,
  splitCourseCodes,
} from "./search.js";
import { currentTerm, offeredLabel, planSemesters, termLabel as semesterLabel, termText } from "./terms.js";

/**
 * @param {object} options
 * @param {Function} options.rows runs a query on the course database
 * @param {Function} options.element builds an element
 * @param {HTMLElement} options.panel where the course page is drawn
 * @param {() => object} options.getGraph the prerequisite graph
 * @param {string} options.currentCatalogTerm the newest catalog, e.g. "Spring 2027"
 * @param {string} options.oldestTermSearched the oldest term offered that the data covers
 * @param {(code: string) => void} options.onGenEd lists every course with a Gen Ed (its tag was pressed)
 */
export function createCourseView({ rows, element, panel, getGraph, currentCatalogTerm, oldestTermSearched, onGenEd }) {
  const courseHash = (subject, number) => `#${subject}-${number}`;

  function courseExists(subject, number) {
    return (
      rows("SELECT 1 FROM courses WHERE subject = :s AND number = :n", {
        ":s": subject,
        ":n": number,
      }).length > 0
    );
  }

  const GPA_DATASET_PAGE = "https://github.com/wadefagen/datasets/tree/main/gpa";

  /** A course code that links to the course, or plain text if the app doesn't have it. */
  function courseChip(subject, number) {
    const label = `${subject} ${number}`;
    if (!courseExists(subject, number)) {
      return element("span", {
        className: "chip missing",
        title: tr("Not in any Course Explorer catalog since 2015", "2015 年以来不在任何 Course Explorer 目录中"),
        textContent: label,
      });
    }
    const status = myCourses.status(label);
    return element("a", {
      className: status ? `chip ${status}` : "chip",
      href: courseHash(subject, number),
      textContent: label,
      title: status
        ? tr(`You've marked ${label} ${status}`, `你已将 ${label} 标记为${status === "taken" ? "已修" : "已计划"}`)
        : "",
    });
  }

  /** "Taken" / "Planned" buttons for a course, and whether your taken courses meet its prerequisites. */
  function myCoursePanel(subject, number) {
    const id = `${subject} ${number}`;
    const status = myCourses.status(id);
    const graph = getGraph();
    const facts = courseFacts(rows);
    const fact = facts.get(id);
    const courses = planCourses();
    const runs = fact
      ? fact.offered
        ? tr(`Runs ${seasonsText(fact.seasons)}`, `开课：${seasonsText(fact.seasons)}`)
        : tr(`Not offered since ${oldestTermSearched}`, `${termText(oldestTermSearched)}以来未开课`)
      : "";
    const plan = element("a", {
      href: "#plan",
      className: "my-course-plan",
      textContent: tr("View my plan →", "查看我的计划 →"),
    });

    // Whether your taken courses meet the prerequisites today.
    const taken = new Set(myCourses.ids("taken"));
    const hasPrerequisites = (graph.byId.get(id)?.requirements.length ?? 0) > 0;
    let check = "";
    if (hasPrerequisites && taken.size === 0) {
      check = element("p", {
        className: "prereq-check",
        textContent: tr(
          "Mark the courses you've taken to check whether you meet the prerequisites.",
          "标记你修过的课，就能检查是否满足先修要求。",
        ),
      });
    } else if (hasPrerequisites && !status) {
      const missing = missingRequirements(graph, id, taken);
      // Prerequisites that are already in the plan, and when.
      const planned = missing
        .flatMap((group) => group.ids)
        .filter((prerequisite) => myCourses.status(prerequisite) === "planned")
        .map((prerequisite) =>
          tr(
            `${prerequisite} is planned for ${myCourses.term(prerequisite) ? semesterLabel(myCourses.term(prerequisite)) : "a semester not picked yet"}`,
            `${prerequisite} 计划在${myCourses.term(prerequisite) ? semesterLabel(myCourses.term(prerequisite)) : "尚未选定的学期"}修读`,
          ),
        );
      check =
        missing.length === 0
          ? element("p", {
              className: "prereq-check met",
              textContent: tr("✓ Your taken courses meet the prerequisites.", "✓ 你修过的课已满足先修要求。"),
            })
          : element("p", {
              className: "prereq-check unmet",
              textContent: tr(
                `Not yet: still needs ${describeMissing(missing)}.${planned.length ? ` ${planned.join("; ")}.` : ""}`,
                `还不满足：仍需要 ${describeMissing(missing)}。${planned.length ? `${planned.join("；")}。` : ""}`,
              ),
            });
    }

    if (!status) {
      // Not in the plan yet: one clear button, with the best semester picked for you.
      const best = bestTerm({ id, courses, graph, facts, startTerm: nextTerm() });
      const term = element(
        "select",
        { className: "term-menu", ariaLabel: tr(`Semester to plan ${id} in`, `计划修读 ${id} 的学期`) },
        ...termChoicesAhead().map((value) =>
          element("option", { value, textContent: semesterLabel(value), selected: value === best }),
        ),
      );
      const why =
        best === nextTerm()
          ? ""
          : tr(
              ` · Best semester: ${semesterLabel(best)}, after its prerequisites${fact?.seasons.size === 1 ? " and in its season" : ""}`,
              ` · 最合适的学期：${semesterLabel(best)}，排在先修课之后${fact?.seasons.size === 1 ? "，也正好是开课季节" : ""}`,
            );
      // A Gen Ed course can fill open Gen Ed slots in the plan (one of each kind it counts for).
      const [slot, ...alsoFills] = slotsFilledBy(fact, myCourses.slots());
      const courseKinds = slotKindsOf(fact);
      // The Gen Eds of those slots this course meets (a shared slot's other Gen Ed may stay open).
      const meets = [slot, ...alsoFills]
        .filter(Boolean)
        .flatMap((open) => [open.kind, ...open.also])
        .filter((kind) => courseKinds.includes(kind));
      const slotButton = slot
        ? focusKey(
            element("button", {
              type: "button",
              className: "btn btn-ghost my-course-slot",
              textContent: tr(
                `Use for my ${slotNames(meets)} slot${alsoFills.length ? "s" : ""}${slot.term ? ` · ${semesterLabel(slot.term)}` : ""}`,
                `用来填我的${slotNames(meets)}空位${slot.term ? ` · ${semesterLabel(slot.term)}` : ""}`,
              ),
              title: tr(
                "Puts it in the plan where the slot is, and the slot goes away",
                "把这门课放到空位所在的学期，空位随之消失",
              ),
              onclick: () =>
                myCourses.fillSlot(
                  slot.id,
                  id,
                  alsoFills.map((open) => open.id),
                  courseKinds,
                ),
            }),
            `mark-planned-${id}`,
          )
        : "";
      return element(
        "div",
        { className: "my-course" },
        element(
          "div",
          { className: "my-course-row" },
          focusKey(
            element("button", {
              type: "button",
              className: "btn btn-primary",
              textContent: tr("+ Add to plan", "+ 加入计划"),
              onclick: () => myCourses.set(id, "planned", term.value),
            }),
            `mark-planned-${id}`, // after adding, the Planned button takes the focus
          ),
          element("span", { className: "my-course-label", textContent: tr("for", "学期") }),
          term,
          focusKey(
            element("button", {
              type: "button",
              className: "btn btn-ghost",
              textContent: tr("I've taken it", "我修过了"),
              onclick: () => myCourses.set(id, "taken"),
            }),
            `mark-taken-${id}`,
          ),
          focusKey(
            element("button", {
              type: "button",
              className: "btn btn-ghost",
              textContent: tr("I'm taking it now", "我正在修"),
              title: tr(
                `Mark ${id} in progress for ${semesterLabel(currentTerm())}`,
                `把 ${id} 标记为 ${semesterLabel(currentTerm())}在修`,
              ),
              onclick: () => myCourses.setInProgress(id),
            }),
            `mark-taken-${id}`, // the Taken button takes the focus after
          ),
          plan,
        ),
        slotButton ? element("div", { className: "my-course-row" }, slotButton) : "",
        runs || why ? element("p", { className: "my-course-hint", textContent: `${runs}${why}` }) : "",
        check,
      );
    }

    // In the plan: taken / planned, its semester with ← → and ⋯, and how it fits there.
    const toggle = (value, text) => {
      const button = element("button", {
        type: "button",
        textContent: text,
        // Pressing the lit button again unmarks the course.
        onclick: () => myCourses.set(id, status === value ? null : value),
      });
      button.setAttribute("aria-pressed", String(status === value));
      return focusKey(button, `mark-${value}-${id}`);
    };
    const group = element(
      "div",
      { className: "view-toggle my-course-toggle", role: "group" },
      toggle("taken", tr("Taken", "已修")),
      toggle("planned", tr("Planned", "已计划")),
    );
    group.setAttribute("aria-label", tr(`Mark ${id}`, `标记 ${id}`));
    const term = myCourses.term(id);
    const issues =
      status === "planned" ? courseIssues({ id, term, courses, graph, facts, offeredSince: oldestTermSearched }) : [];
    const fits =
      status === "planned" && issues.length === 0 && term
        ? element("p", {
            className: "prereq-check met",
            textContent: tr(
              `✓ Fits ${semesterLabel(term)}: prerequisites come first${fact?.offered ? ", and it runs that season" : ""}.`,
              `✓ 适合 ${semesterLabel(term)}：先修课都排在前面${fact?.offered ? "，这个季节也开课" : ""}。`,
            ),
          })
        : "";
    return element(
      "div",
      { className: "my-course" },
      element(
        "div",
        { className: "my-course-row" },
        group,
        element("span", {
          className: "my-course-term",
          textContent: termNote(id, status, term),
        }),
        planControls({ element, rows, graph, id, extraClass: "course-page" }),
        plan,
      ),
      status === "planned" && myCourses.reason(id)
        ? element(
            "p",
            { className: "my-course-hint" },
            myCourses.isAuto(id) ? element("span", { className: "plan-auto", textContent: tr("auto", "自动") }) : "",
            myCourses.isAuto(id)
              ? tr(
                  ` Added by Auto-plan for ${myCourses.reason(id)} · ⋯ to move, swap or remove it`,
                  ` 由自动规划加入，用于${reasonText(myCourses.reason(id))} · 点 ⋯ 可移动、替换或移除`,
                )
              : myCourses.fills(id).length > 0
                ? tr(
                    `Fills your ${slotNames(myCourses.fills(id))} Gen Ed${myCourses.fills(id).length > 1 ? "s" : ""} · ⋯ to move, swap or remove it`,
                    `填补你的${slotNames(myCourses.fills(id))}通识要求 · 点 ⋯ 可移动、替换或移除`,
                  )
                : tr(
                    `Planned for ${myCourses.reason(id)} · ⋯ to move, swap or remove it`,
                    `计划用于${reasonText(myCourses.reason(id))} · 点 ⋯ 可移动、替换或移除`,
                  ),
          )
        : "",
      issueBadges(element, issues),
      fits,
      runs ? element("p", { className: "my-course-hint", textContent: runs }) : "",
      check,
    );
  }

  /** "Planned for Spring 2027", "In progress, Fall 2026", tr("Credit before UIUC", "入学前已获学分"), "Taken Fall 2025". */
  function termNote(id, status, term) {
    if (status === "taken" && myCourses.kind(id) === "credit") return tr("Credit before UIUC", "入学前已获学分");
    if (!term) return tr("No semester yet", "尚未选学期");
    if (status === "planned") return tr(`Planned for ${semesterLabel(term)}`, `计划在 ${semesterLabel(term)}`);
    return tr(
      `${myCourses.kind(id) === "registered" ? "In progress," : "Taken"} ${semesterLabel(term)}`,
      `${semesterLabel(term)} ${myCourses.kind(id) === "registered" ? "在修" : "已修"}`,
    );
  }

  /** Fall and Spring semesters from next semester on, four years ahead. */
  function termChoicesAhead() {
    return planSemesters([], nextTerm());
  }

  /** The official wording, with course codes turned into links. */
  function officialWording(text) {
    const paragraph = element("p", { className: "official" });
    for (const part of splitCourseCodes(text)) {
      if (part.subject && courseExists(part.subject, part.number)) {
        paragraph.append(element("a", { href: courseHash(part.subject, part.number), textContent: part.text }));
      } else paragraph.append(part.text);
    }
    return paragraph;
  }

  /**
   * Prerequisites as requirement groups ("one of" these chips), followed by the
   * official wording, which stays the source of truth.
   */
  function prerequisitesSection(course) {
    const section = element("section", { className: "detail-section" });
    section.append(element("h3", { textContent: tr("Prerequisites", "先修课") }));
    if (course.prerequisite_text === "") {
      section.append(element("p", { textContent: tr("None listed.", "未列出。") }));
      return section;
    }

    const prerequisites = rows(
      `SELECT group_index, prereq_subject, prereq_number, required_count, concurrent_ok
       FROM prerequisites WHERE subject = :s AND number = :n ORDER BY group_index, rowid`,
      { ":s": course.subject, ":n": course.number },
    );
    // Group rows by requirement (not Map.groupBy, which older browsers lack).
    const groups = new Map();
    for (const row of prerequisites) {
      if (!groups.has(row.group_index)) groups.set(row.group_index, []);
      groups.get(row.group_index).push(row);
    }
    if (groups.size > 0) {
      if (groups.size > 1) {
        section.append(
          element("p", {
            className: "requirements-intro",
            textContent: tr(`Meet all ${groups.size} requirements:`, `需要全部满足这 ${groups.size} 项要求：`),
          }),
        );
      }
      const list = element("ol", { className: "requirements" });
      for (const group of groups.values()) {
        const label = requirementLabel(group[0].required_count, group.length);
        const item = element(
          "li",
          { className: "requirement" },
          element("span", {
            className: `requirement-label${group.length === 1 ? " required" : ""}`,
            textContent: label,
          }),
        );
        for (const row of group) item.append(courseChip(row.prereq_subject, row.prereq_number));
        if (group[0].concurrent_ok) {
          item.append(
            element("span", {
              className: "concurrent",
              textContent: tr("can be taken at the same time", "可以同时修"),
            }),
          );
        }
        list.append(item);
      }
      section.append(list);
      section.append(element("p", { className: "small-label", textContent: tr("Official wording", "官方原文") }));
    }
    section.append(officialWording(course.prerequisite_text));
    return section;
  }

  /** Gen Ed tags; clicking one lists every course meeting that Gen Ed, as if picked in the menu. */
  function genEdTags(subject, number) {
    const genEds = rows("SELECT code, name, category FROM gen_eds WHERE subject = :s AND number = :n AND name <> ''", {
      ":s": subject,
      ":n": number,
    });
    return genEds.map((genEd) =>
      element("button", {
        type: "button",
        className: "tag gen-ed-link",
        title: tr(
          `Gen Ed: ${genEd.category}. Show every course that meets it.`,
          `通识要求：${genEd.category}。点击查看所有满足它的课程。`,
        ),
        textContent: genEd.name,
        onclick: () => onGenEd(genEd.code),
      }),
    );
  }

  function statTile(value, label) {
    return element(
      "div",
      { className: "stat" },
      element("span", { className: "stat-value", textContent: value }),
      element("span", { className: "stat-label", textContent: label }),
    );
  }

  /** Average GPA, 4.0 rate and the newest term offered, side by side. */
  function statTiles(grades, terms) {
    const lastOffered = terms[0]
      ? termText(terms[0])
      : tr(`Not since ${oldestTermSearched}`, `${termText(oldestTermSearched)}以来未开课`);
    const offered = terms[0] ? offeredLabel(terms[0]) : tr("last offered", "最近开课"); // Spring 2027 is "offered next" while Fall 2026 is on
    if (!grades) {
      return element(
        "div",
        { className: "stats" },
        statTile("—", tr("average GPA (no grade data)", "平均 GPA（暂无成绩数据）")),
        statTile(lastOffered, offered),
      );
    }
    return element(
      "div",
      { className: "stats" },
      statTile(grades.average_gpa.toFixed(2), tr("average GPA", "平均 GPA")),
      statTile(`${(grades.four_point_rate * 100).toFixed(2)}%`, tr("got a 4.0 (A or A+)", "拿到 4.0（A 或 A+）")),
      statTile(lastOffered, offered),
    );
  }

  function sideSection(title, ...content) {
    return element("section", { className: "detail-section" }, element("h3", { textContent: title }), ...content);
  }

  /** Corequisites, restrictions, schedule notes and fees, or nothing if the course has none. */
  function registrationSection(course) {
    const notes = [
      [tr("Corequisite", "同修要求"), course.corequisite_text],
      [tr("Who can register", "选课限制"), course.restrictions],
      [tr("Schedule", "上课安排"), course.schedule_info],
      [tr("Fee", "费用"), course.fee],
    ].filter(([, text]) => text !== "");
    if (notes.length === 0) return "";
    return sideSection(
      tr("Registration", "选课信息"),
      element(
        "dl",
        { className: "notes" },
        ...notes.flatMap(([label, text]) => [
          element("dt", { textContent: label }),
          element("dd", { textContent: text }),
        ]),
      ),
    );
  }

  function offeredSection(terms) {
    const text =
      terms.length === 0
        ? tr(`Not offered since ${oldestTermSearched} or earlier.`, `${termText(oldestTermSearched)}或更早以来未开课。`)
        : terms.map(termText).join(tr(", ", "、"));
    return sideSection(tr("Offered", "开课学期"), element("p", { textContent: text }));
  }

  function sourcesSection(course, grades) {
    const items = [
      element(
        "li",
        {},
        element("a", {
          href: courseExplorerPage(course.source_url),
          target: "_blank",
          rel: "noopener",
          textContent: tr(
            `Course Explorer (${course.catalog_term} catalog) ↗`,
            `Course Explorer（${termText(course.catalog_term)}目录）↗`,
          ),
        }),
      ),
    ];
    if (grades) {
      const span =
        grades.first_term === grades.last_term
          ? termText(grades.first_term)
          : `${termText(grades.first_term)} – ${termText(grades.last_term)}`;
      items.push(
        element(
          "li",
          {},
          tr(
            `Grades: ${grades.students.toLocaleString("en-US")} students, ${span}, from `,
            `成绩：${grades.students.toLocaleString("en-US")} 名学生，${span}，来自 `,
          ),
          element("a", {
            href: GPA_DATASET_PAGE,
            target: "_blank",
            rel: "noopener",
            textContent: tr("Wade Fagen-Ulmschneider's GPA dataset ↗", "Wade Fagen-Ulmschneider 的 GPA 数据集 ↗"),
          }),
        ),
      );
    } else {
      items.push(
        element("li", {
          textContent: tr(
            "No grade data: grades are only released for classes of more than 20 students.",
            "暂无成绩数据：只有超过 20 名学生的班级才会公布成绩。",
          ),
        }),
      );
    }
    return sideSection(tr("Sources", "数据来源"), element("ul", { className: "sources" }, ...items));
  }

  function showCourse(subject, number) {
    const [course] = rows(
      `SELECT courses.*, subjects.name AS subject_name
       FROM courses JOIN subjects ON subjects.code = courses.subject
       WHERE subject = :s AND number = :n`,
      { ":s": subject, ":n": number },
    );

    if (!course) {
      panel.replaceChildren(
        element("h2", { textContent: `${subject} ${number}` }),
        element("p", { textContent: tr("This course isn't in the app's data.", "数据里没有这门课。") }),
      );
      return;
    }

    const terms = rows("SELECT term FROM terms_offered WHERE subject = :s AND number = :n ORDER BY position", {
      ":s": subject,
      ":n": number,
    }).map((row) => row.term);
    const [grades] = rows("SELECT * FROM course_grades WHERE subject = :s AND number = :n", {
      ":s": subject,
      ":n": number,
    });

    const oldCatalogNotice =
      course.catalog_term === currentCatalogTerm
        ? ""
        : element("p", {
            className: "notice",
            textContent: tr(
              `Not in the ${currentCatalogTerm} catalog. This information is from the ${course.catalog_term} catalog, so the course may have changed or been retired.`,
              `不在${termText(currentCatalogTerm)}目录中。这些信息来自${termText(course.catalog_term)}目录，课程可能已有变动或已停开。`,
            ),
          });

    const header = element(
      "header",
      { className: "detail-header" },
      element(
        "div",
        { className: "detail-title-row" },
        element(
          "div",
          {},
          element(
            "p",
            { className: "detail-code" },
            `${subject} ${number}`,
            element("a", { href: `#${subject}`, className: "subject-name", textContent: ` · ${course.subject_name}` }),
          ),
          element("h2", { textContent: course.title }),
        ),
        // Only courses with prerequisite links are planets on the map.
        getGraph().byId.has(`${subject} ${number}`)
          ? element(
              "a",
              { href: `#graph/${subject}-${number}`, className: "btn btn-primary star-link" },
              element("span", { className: "star-link-icon", ariaHidden: "true" }),
              tr("Open in star map", "在星图中打开"),
            )
          : element("span", {
              className: "star-link-none",
              textContent: tr("Not on the star map: no prerequisite links", "不在星图上：没有先修关系"),
            }),
      ),
      element(
        "div",
        { className: "meta" },
        element("span", { className: "tag plain", textContent: formatCreditHours(course.credit_hours) }),
        ...genEdTags(subject, number),
      ),
      myCoursePanel(subject, number),
    );

    const description = descriptionWithoutPrerequisite(course.description);
    const main = element(
      "div",
      { className: "detail-main" },
      prerequisitesSection(course),
      element(
        "section",
        { className: "detail-section" },
        element("h3", { textContent: tr("Description", "课程介绍") }),
        element("p", { textContent: description || tr("No description.", "暂无介绍。") }),
      ),
    );
    const side = element(
      "aside",
      { className: "detail-side" },
      registrationSection(course),
      offeredSection(terms),
      sourcesSection(course, grades),
    );

    panel.replaceChildren(
      header,
      oldCatalogNotice,
      statTiles(grades, terms),
      element("div", { className: "detail-body" }, main, side),
    );
  }

  return { show: showCourse };
}
