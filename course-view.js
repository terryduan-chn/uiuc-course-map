// The course page: its official details, prerequisites, GPA and sources, and the panel for
// marking it taken, in progress or planned.

import { missingRequirements } from "./graph-data.js";
import { focusKey, myCourses } from "./my-courses.js";
import { issueBadges, nextTerm, planControls, planCourses } from "./plan-controls.js";
import { bestTerm, courseIssues, describeMissing, seasonsText, slotNames, slotsFilledBy } from "./plan-insights.js";
import { courseFacts } from "./requirement-courses.js";
import {
  courseExplorerPage,
  descriptionWithoutPrerequisite,
  formatCreditHours,
  requirementLabel,
  splitCourseCodes,
} from "./search.js";
import { currentTerm, offeredLabel, planSemesters, termLabel as semesterLabel } from "./terms.js";

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
        title: "Not in any Course Explorer catalog since 2015",
        textContent: label,
      });
    }
    const status = myCourses.status(label);
    return element("a", {
      className: status ? `chip ${status}` : "chip",
      href: courseHash(subject, number),
      textContent: label,
      title: status ? `You've marked ${label} ${status}` : "",
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
        ? `Runs ${seasonsText(fact.seasons)}`
        : `Not offered since ${oldestTermSearched}`
      : "";
    const plan = element("a", { href: "#plan", className: "my-course-plan", textContent: "View my plan →" });

    // Whether your taken courses meet the prerequisites today.
    const taken = new Set(myCourses.ids("taken"));
    const hasPrerequisites = (graph.byId.get(id)?.requirements.length ?? 0) > 0;
    let check = "";
    if (hasPrerequisites && taken.size === 0) {
      check = element("p", {
        className: "prereq-check",
        textContent: "Mark the courses you've taken to check whether you meet the prerequisites.",
      });
    } else if (hasPrerequisites && !status) {
      const missing = missingRequirements(graph, id, taken);
      // Prerequisites that are already in the plan, and when.
      const planned = missing
        .flatMap((group) => group.ids)
        .filter((prerequisite) => myCourses.status(prerequisite) === "planned")
        .map(
          (prerequisite) =>
            `${prerequisite} is planned for ${myCourses.term(prerequisite) ? semesterLabel(myCourses.term(prerequisite)) : "a semester not picked yet"}`,
        );
      check =
        missing.length === 0
          ? element("p", { className: "prereq-check met", textContent: "✓ Your taken courses meet the prerequisites." })
          : element("p", {
              className: "prereq-check unmet",
              textContent: `Not yet: still needs ${describeMissing(missing)}.${planned.length ? ` ${planned.join("; ")}.` : ""}`,
            });
    }

    if (!status) {
      // Not in the plan yet: one clear button, with the best semester picked for you.
      const best = bestTerm({ id, courses, graph, facts, startTerm: nextTerm() });
      const term = element(
        "select",
        { className: "term-menu", ariaLabel: `Semester to plan ${id} in` },
        ...termChoicesAhead().map((value) =>
          element("option", { value, textContent: semesterLabel(value), selected: value === best }),
        ),
      );
      const why =
        best === nextTerm()
          ? ""
          : ` · Best semester: ${semesterLabel(best)}, after its prerequisites${fact?.seasons.size === 1 ? " and in its season" : ""}`;
      // A Gen Ed course can fill open Gen Ed slots in the plan (one of each kind it counts for).
      const [slot, ...alsoFills] = slotsFilledBy(fact, myCourses.slots());
      const slotButton = slot
        ? focusKey(
            element("button", {
              type: "button",
              className: "btn btn-ghost my-course-slot",
              textContent: `Use for my ${slotNames([slot, ...alsoFills].map((open) => open.kind))} slot${alsoFills.length ? "s" : ""}${slot.term ? ` · ${semesterLabel(slot.term)}` : ""}`,
              title: "Puts it in the plan where the slot is, and the slot goes away",
              onclick: () =>
                myCourses.fillSlot(
                  slot.id,
                  id,
                  alsoFills.map((open) => open.id),
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
              textContent: "+ Add to plan",
              onclick: () => myCourses.set(id, "planned", term.value),
            }),
            `mark-planned-${id}`, // after adding, the Planned button takes the focus
          ),
          element("span", { className: "my-course-label", textContent: "for" }),
          term,
          focusKey(
            element("button", {
              type: "button",
              className: "btn btn-ghost",
              textContent: "I've taken it",
              onclick: () => myCourses.set(id, "taken"),
            }),
            `mark-taken-${id}`,
          ),
          focusKey(
            element("button", {
              type: "button",
              className: "btn btn-ghost",
              textContent: "I'm taking it now",
              title: `Mark ${id} in progress for ${semesterLabel(currentTerm())}`,
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
      toggle("taken", "Taken"),
      toggle("planned", "Planned"),
    );
    group.setAttribute("aria-label", `Mark ${id}`);
    const term = myCourses.term(id);
    const issues =
      status === "planned" ? courseIssues({ id, term, courses, graph, facts, offeredSince: oldestTermSearched }) : [];
    const fits =
      status === "planned" && issues.length === 0 && term
        ? element("p", {
            className: "prereq-check met",
            textContent: `✓ Fits ${semesterLabel(term)}: prerequisites come first${fact?.offered ? ", and it runs that season" : ""}.`,
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
            myCourses.isAuto(id) ? element("span", { className: "plan-auto", textContent: "auto" }) : "",
            myCourses.isAuto(id)
              ? ` Added by Auto-plan for ${myCourses.reason(id)} · ⋯ to move, swap or remove it`
              : myCourses.fills(id).length > 0
                ? `Fills your ${slotNames(myCourses.fills(id))} Gen Ed${myCourses.fills(id).length > 1 ? "s" : ""} · ⋯ to move, swap or remove it`
                : `Planned for ${myCourses.reason(id)} · ⋯ to move, swap or remove it`,
          )
        : "",
      issueBadges(element, issues),
      fits,
      runs ? element("p", { className: "my-course-hint", textContent: runs }) : "",
      check,
    );
  }

  /** "Planned for Spring 2027", "In progress, Fall 2026", "Credit before UIUC", "Taken Fall 2025". */
  function termNote(id, status, term) {
    if (status === "taken" && myCourses.kind(id) === "credit") return "Credit before UIUC";
    if (!term) return "No semester yet";
    if (status === "planned") return `Planned for ${semesterLabel(term)}`;
    return `${myCourses.kind(id) === "registered" ? "In progress," : "Taken"} ${semesterLabel(term)}`;
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
    section.append(element("h3", { textContent: "Prerequisites" }));
    if (course.prerequisite_text === "") {
      section.append(element("p", { textContent: "None listed." }));
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
          element("p", { className: "requirements-intro", textContent: `Meet all ${groups.size} requirements:` }),
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
          item.append(element("span", { className: "concurrent", textContent: "can be taken at the same time" }));
        }
        list.append(item);
      }
      section.append(list);
      section.append(element("p", { className: "small-label", textContent: "Official wording" }));
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
        title: `Gen Ed: ${genEd.category}. Show every course that meets it.`,
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
    const lastOffered = terms[0] ?? `Not since ${oldestTermSearched}`;
    const offered = terms[0] ? offeredLabel(terms[0]) : "last offered"; // Spring 2027 is "offered next" while Fall 2026 is on
    if (!grades) {
      return element(
        "div",
        { className: "stats" },
        statTile("—", "average GPA (no grade data)"),
        statTile(lastOffered, offered),
      );
    }
    return element(
      "div",
      { className: "stats" },
      statTile(grades.average_gpa.toFixed(2), "average GPA"),
      statTile(`${Math.round(grades.four_point_rate * 100)}%`, "got a 4.0 (A or A+)"),
      statTile(lastOffered, offered),
    );
  }

  function sideSection(title, ...content) {
    return element("section", { className: "detail-section" }, element("h3", { textContent: title }), ...content);
  }

  /** Corequisites, restrictions, schedule notes and fees, or nothing if the course has none. */
  function registrationSection(course) {
    const notes = [
      ["Corequisite", course.corequisite_text],
      ["Who can register", course.restrictions],
      ["Schedule", course.schedule_info],
      ["Fee", course.fee],
    ].filter(([, text]) => text !== "");
    if (notes.length === 0) return "";
    return sideSection(
      "Registration",
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
    const text = terms.length === 0 ? `Not offered since ${oldestTermSearched} or earlier.` : terms.join(", ");
    return sideSection("Offered", element("p", { textContent: text }));
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
          textContent: `Course Explorer (${course.catalog_term} catalog) ↗`,
        }),
      ),
    ];
    if (grades) {
      const span =
        grades.first_term === grades.last_term ? grades.first_term : `${grades.first_term} – ${grades.last_term}`;
      items.push(
        element(
          "li",
          {},
          `Grades: ${grades.students.toLocaleString("en-US")} students, ${span}, from `,
          element("a", {
            href: GPA_DATASET_PAGE,
            target: "_blank",
            rel: "noopener",
            textContent: "Wade Fagen-Ulmschneider's GPA dataset ↗",
          }),
        ),
      );
    } else {
      items.push(
        element("li", {
          textContent: "No grade data: grades are only released for classes of more than 20 students.",
        }),
      );
    }
    return sideSection("Sources", element("ul", { className: "sources" }, ...items));
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
        element("p", { textContent: "This course isn't in the app's data." }),
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
            textContent:
              `Not in the ${currentCatalogTerm} catalog. This information is from the ` +
              `${course.catalog_term} catalog, so the course may have changed or been retired.`,
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
              "Open in star map",
            )
          : element("span", { className: "star-link-none", textContent: "Not on the star map: no prerequisite links" }),
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
        element("h3", { textContent: "Description" }),
        element("p", { textContent: description || "No description." }),
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
