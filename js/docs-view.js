// The #docs page: the app's documentation (docs/docs.html, or docs.zh.html in Chinese), one topic at a time, with a table of
// contents beside it and Previous / Next under it. Every topic has its own address, #docs/<id>,
// so one click in the contents (or a shared link) opens it. A topic's <figure data-demo="#plan">
// becomes a live demo: the app itself in a frame, on a sample plan (see demo-mode.js).

import { tr } from "./i18n.js";
import { termText } from "./terms.js";

/**
 * @param {object} options
 * @param {Function} options.element builds an element
 * @param {Record<string, string>} options.meta values from the database to fill in, by
 *   data-meta name ("imported_at" as a date, terms like "Spring 2027")
 */
const SIDEBAR_WIDTH = 861; // from this screen width on, the contents are a sidebar (matches docs.css)

/**
 * Which topic to show for an address, and the topics before and after it (null at either end).
 * An address with no topic, or one that doesn't exist, shows the first.
 */
export function docsPage(ids, wantedId) {
  const index = Math.max(0, ids.indexOf(wantedId));
  return { current: ids[index], previous: ids[index - 1] ?? null, next: ids[index + 1] ?? null };
}

export function createDocsView({ element, meta }) {
  const view = document.getElementById("docs-view");
  let loaded = null; // the content, once fetched: { sections, links }
  let loading = null; // the fetch under way, so a second visit doesn't start another
  let wanted = null; // the section to show once the content has loaded

  /** Gives a demo the page's light or dark theme. */
  function matchTheme(frame) {
    const page = frame.contentDocument?.documentElement;
    if (page) page.dataset.theme = document.documentElement.dataset.theme;
  }

  /** Starts a topic's demo (or starts it over): a new frame, with the sample plan as it began. */
  function startDemo(figure) {
    figure.querySelector("iframe")?.remove();
    const frame = element("iframe", {
      src: `index.html?demo${figure.dataset.demo}`,
      title: tr(
        `Live demo: ${figure.querySelector("figcaption").textContent}`,
        `在线演示：${figure.querySelector("figcaption").textContent}`,
      ),
    });
    frame.addEventListener("load", () => matchTheme(frame));
    figure.prepend(frame);
  }

  /** A Previous or Next link to a topic, named after it. */
  function pagerLink(id, direction) {
    const title = loaded.sections.find((section) => section.id === id).querySelector("h2").textContent;
    return element(
      "a",
      { href: `#docs/${id}`, className: `docs-pager-link ${direction}` },
      element("span", {
        className: "docs-pager-label",
        textContent: direction === "next" ? tr("Next →", "下一篇 →") : tr("← Previous", "← 上一篇"),
      }),
      element("span", { className: "docs-pager-title", textContent: title }),
    );
  }

  /** Shows one topic (the first if the address names none), marks it in the contents, and links its neighbors. */
  function showSection(id) {
    const page = docsPage(
      loaded.sections.map((section) => section.id),
      id,
    );
    for (const section of loaded.sections) {
      section.hidden = section.id !== page.current;
      // Only the open topic's demo runs: each one is a whole copy of the app.
      if (section.hidden) section.querySelector(".docs-demo iframe")?.remove();
      else if (section.querySelector(".docs-demo")) startDemo(section.querySelector(".docs-demo"));
    }
    for (const [sectionId, link] of loaded.links) {
      if (sectionId === page.current) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
    loaded.pager.replaceChildren(
      page.previous ? pagerLink(page.previous, "previous") : element("span"),
      page.next ? pagerLink(page.next, "next") : element("span"),
    );
    window.scrollTo({ top: 0 });
  }

  /** Builds the page from docs.html: contents grouped like the sections, then the sections. */
  function build(html) {
    const content = element("article", { className: "docs-content" });
    content.innerHTML = html; // our own file, served with the page
    for (const slot of content.querySelectorAll("[data-meta]")) {
      if (meta[slot.dataset.meta]) slot.textContent = termText(meta[slot.dataset.meta]);
    }
    for (const figure of content.querySelectorAll("figure[data-demo]")) {
      figure.classList.add("docs-demo");
      figure.append(
        element(
          "p",
          { className: "docs-demo-note" },
          tr(
            "Live demo on a sample plan: try anything, your own plan doesn't change. ",
            "这是用示例计划做的在线演示，可以随便试，不会改动你自己的计划。",
          ),
          element("button", {
            type: "button",
            className: "docs-demo-reset",
            textContent: tr("Start over", "重新开始"),
            onclick: () => startDemo(figure),
          }),
        ),
      );
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
      { className: "docs-toc", ariaLabel: tr("Contents", "目录") },
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
      element("summary", { textContent: tr("Contents", "目录") }),
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
    const pager = element("nav", {
      className: "docs-pager",
      ariaLabel: tr("Previous and next topics", "上一篇和下一篇"),
    });
    content.append(pager);
    view.replaceChildren(
      element(
        "header",
        { className: "docs-header" },
        element("h1", { textContent: tr("UIUC Course Map docs", "UIUC Course Map 文档") }),
        element("p", {
          className: "docs-lead",
          textContent: tr(
            "How to use every part of the app, how it works, and answers to common questions.",
            "这里介绍应用每个部分的用法、它的工作原理，以及常见问题的解答。",
          ),
        }),
      ),
      element("div", { className: "docs-layout" }, element("aside", { className: "docs-side" }, menu), content),
    );
    loaded = { sections, links, pager };
    // Switching light or dark in the top bar reaches the open demo too.
    new MutationObserver(() => view.querySelectorAll(".docs-demo iframe").forEach(matchTheme)).observe(
      document.documentElement,
      { attributes: true, attributeFilter: ["data-theme"] },
    );
  }

  async function load() {
    view.replaceChildren(element("p", { className: "status", textContent: tr("Loading the docs…", "正在加载文档…") }));
    try {
      const response = await fetch(tr("docs/docs.html", "docs/docs.zh.html"));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      build(await response.text());
      if (!view.hidden) showSection(wanted);
    } catch (error) {
      console.error(error);
      view.replaceChildren(
        element("p", {
          className: "status error",
          textContent: tr(
            "Couldn't load the docs. Check your connection and reload the page.",
            "文档加载失败，请检查网络后刷新页面。",
          ),
        }),
      );
      loading = null; // the next visit tries again
    }
  }

  return {
    /** Shows the docs, at a topic's id or the first topic. */
    show(sectionId) {
      view.hidden = false;
      wanted = sectionId;
      if (loaded) showSection(sectionId);
      else loading ??= load();
    },
    hide() {
      view.hidden = true;
    },
  };
}
