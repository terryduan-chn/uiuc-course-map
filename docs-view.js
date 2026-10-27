// The #docs page: the app's documentation (docs.html), with a table of contents beside it.
// Every section has its own address, #docs/<id>, so one click in the contents (or a shared
// link) lands on it, and the contents follow along as you scroll.

/**
 * @param {object} options
 * @param {Function} options.element builds an element
 * @param {Record<string, string>} options.meta values from the database to fill in, by
 *   data-meta name ("imported_at" as a date, terms like "Spring 2027")
 */
const SIDEBAR_WIDTH = 861; // from this screen width on, the contents are a sidebar (matches docs.css)

export function createDocsView({ element, meta }) {
  const view = document.getElementById("docs-view");
  let loaded = null; // the content, once fetched: { sections, links }
  let loading = null; // the fetch under way, so a second visit doesn't start another
  let wanted = null; // the section to show once the content has loaded

  /** Marks one contents link as the section being read. */
  function highlight(id) {
    for (const [sectionId, link] of loaded.links) {
      if (sectionId === id) link.setAttribute("aria-current", "true");
      else link.removeAttribute("aria-current");
    }
  }

  function scrollToSection(id) {
    const section = loaded.sections.find((candidate) => candidate.id === id) ?? null;
    if (section) {
      section.scrollIntoView({ block: "start" });
      highlight(id);
    } else {
      window.scrollTo({ top: 0 });
      highlight(loaded.sections[0]?.id);
    }
  }

  /** Builds the page from docs.html: contents grouped like the sections, then the sections. */
  function build(html) {
    const content = element("article", { className: "docs-content" });
    content.innerHTML = html; // our own file, served with the page
    for (const slot of content.querySelectorAll("[data-meta]")) {
      if (meta[slot.dataset.meta]) slot.textContent = meta[slot.dataset.meta];
    }
    const sections = [...content.querySelectorAll("section[id]")];
    const links = new Map();
    const groups = new Map();
    for (const section of sections) {
      const group = section.dataset.group ?? "";
      if (!groups.has(group)) groups.set(group, []);
      const link = element("a", { href: `#docs/${section.id}`, textContent: section.querySelector("h2").textContent });
      links.set(section.id, link);
      groups.get(group).push(element("li", {}, link));
    }
    const contents = element(
      "nav",
      { className: "docs-toc", ariaLabel: "Contents" },
      ...[...groups].map(([group, items]) =>
        element(
          "div",
          { className: "docs-toc-group" },
          group ? element("p", { className: "docs-toc-heading", textContent: group }) : "",
          element("ul", {}, ...items),
        ),
      ),
    );
    // On a phone the contents fold into a menu above the text, and a pick closes it.
    const menu = element(
      "details",
      { className: "docs-toc-menu" },
      element("summary", { textContent: "Contents" }),
      contents,
    );
    // Wide screens show the contents as a sidebar, always open.
    const wide = matchMedia(`(min-width: ${SIDEBAR_WIDTH}px)`);
    const fitScreen = () => (menu.open = wide.matches);
    fitScreen();
    wide.addEventListener("change", fitScreen);
    contents.addEventListener("click", (event) => {
      if (event.target.closest("a") && !wide.matches) menu.open = false;
    });
    view.replaceChildren(
      element(
        "header",
        { className: "docs-header" },
        element("h1", { textContent: "UIUC Course Map docs" }),
        element("p", {
          className: "docs-lead",
          textContent: "How to use every part of the app, how it works, and answers to common questions.",
        }),
      ),
      element("div", { className: "docs-layout" }, element("aside", { className: "docs-side" }, menu), content),
    );
    loaded = { sections, links };

    // The contents follow along: the section nearest the top of the screen is highlighted.
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((entry) => entry.isIntersecting);
        if (visible.length > 0) highlight(visible[0].target.id);
      },
      { rootMargin: "-80px 0px -70% 0px" },
    );
    for (const section of sections) observer.observe(section);
  }

  async function load() {
    view.replaceChildren(element("p", { className: "status", textContent: "Loading the docs…" }));
    try {
      const response = await fetch("docs.html");
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      build(await response.text());
      if (!view.hidden) scrollToSection(wanted);
    } catch (error) {
      console.error(error);
      view.replaceChildren(
        element("p", {
          className: "status error",
          textContent: "Couldn't load the docs. Check your connection and reload the page.",
        }),
      );
      loading = null; // the next visit tries again
    }
  }

  return {
    /** Shows the docs, at a section's id or the top. */
    show(sectionId) {
      view.hidden = false;
      wanted = sectionId;
      if (loaded) scrollToSection(sectionId);
      else loading ??= load();
    },
    hide() {
      view.hidden = true;
    },
  };
}
