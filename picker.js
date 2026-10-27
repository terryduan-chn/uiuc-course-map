// A menu that slides open, has a search box, and lets you pick several items: subjects on the
// star map, Gen Ed requirements under the course search. Built by hand because the browser's
// own <select> can't be animated or pick several nicely.

const NAMES_IN_LABEL = 2;

function make(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

/**
 * @param {HTMLElement} root an empty element to build the menu in
 * @param {{
 *   items: { code: string, tag: string, name: string, short: string, count: number, hue: number }[],
 *   noun: string,
 *   onChange: (codes: string[]) => void,
 * }} options
 *   items to offer (tag is the short colored label, short is used on the button), the plural
 *   noun for them ("subjects"), and what to do when the picked set changes
 * @returns {{ get(): string[], clear(): void }}
 */
export function createPicker(root, { items, noun, onChange }) {
  const chosen = new Set();
  const byCode = new Map(items.map((item) => [item.code, item]));
  const allLabel = `All ${noun}`;

  const label = make("span", { className: "picker-label", textContent: allLabel });
  const button = make(
    "button",
    { type: "button", className: "picker-button" },
    label,
    make("span", { className: "picker-chevron" }),
  );
  button.setAttribute("aria-haspopup", "listbox");
  button.setAttribute("aria-expanded", "false");

  const search = make("input", {
    type: "search",
    className: "picker-search",
    placeholder: `Search ${noun}`,
    autocomplete: "off",
  });
  search.setAttribute("aria-label", `Search ${noun}`);
  const summary = make("span", { className: "picker-summary" });
  const clearButton = make("button", { type: "button", className: "picker-clear", textContent: "Clear" });
  const list = make("ul", { className: "picker-list" });
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-multiselectable", "true");
  list.setAttribute("aria-label", noun[0].toUpperCase() + noun.slice(1));
  const panel = make(
    "div",
    { className: "picker-panel" },
    search,
    make("div", { className: "picker-actions" }, summary, clearButton),
    list,
  );
  panel.inert = true; // closed menus can't be tabbed into

  root.classList.add("picker");
  root.append(button, panel);

  function updateLabel() {
    const picked = [...chosen].map((code) => byCode.get(code).short);
    label.textContent =
      picked.length === 0
        ? allLabel
        : picked.slice(0, NAMES_IN_LABEL).join(", ") +
          (picked.length > NAMES_IN_LABEL ? ` +${picked.length - NAMES_IN_LABEL}` : "");
    button.classList.toggle("has-choice", picked.length > 0);
    summary.textContent = picked.length === 0 ? "Pick one or more" : `${picked.length} picked`;
    clearButton.hidden = picked.length === 0;
  }

  /** Items matching the search: exact tag first, then tags starting with it, then names. */
  function visibleItems() {
    const text = search.value.trim().toLowerCase();
    if (!text) return items;
    const rank = (item) => {
      const tag = item.tag.toLowerCase();
      if (tag === text) return 0;
      if (tag.startsWith(text)) return 1;
      if (item.name.toLowerCase().includes(text)) return 2;
      return null;
    };
    return items
      .map((item) => ({ item, rank: rank(item) }))
      .filter((entry) => entry.rank !== null)
      .sort((x, y) => x.rank - y.rank)
      .map((entry) => entry.item);
  }

  function draw() {
    const shown = visibleItems();
    list.replaceChildren(
      ...shown.map((item, i) => {
        const option = make(
          "li",
          { className: "picker-option", tabIndex: -1 },
          make("span", { className: "picker-check" }),
          make("span", { className: "code", textContent: item.tag }),
          make("span", { className: "name", textContent: item.name }),
          make("span", { className: "count", textContent: item.count }),
        );
        option.setAttribute("role", "option");
        option.setAttribute("aria-selected", String(chosen.has(item.code)));
        option.style.setProperty("--hue", item.hue);
        option.style.setProperty("--i", i); // staggers the fade-in of the first rows
        option.addEventListener("click", () => toggle(item.code, option));
        return option;
      }),
      shown.length === 0 ? make("li", { className: "picker-empty", textContent: `No ${noun} match.` }) : "",
    );
  }

  function toggle(code, option) {
    if (chosen.has(code)) chosen.delete(code);
    else chosen.add(code);
    option?.setAttribute("aria-selected", String(chosen.has(code)));
    updateLabel();
    onChange([...chosen]);
  }

  function setOpen(open) {
    root.classList.toggle("open", open);
    button.setAttribute("aria-expanded", String(open));
    panel.inert = !open;
    if (open) {
      search.value = "";
      draw();
      search.focus();
    }
  }

  function clear() {
    chosen.clear();
    updateLabel();
    draw();
  }

  button.addEventListener("click", () => setOpen(!root.classList.contains("open")));
  search.addEventListener("input", draw);
  // Enter picks (or unpicks) the first match, so typing "math" Enter is enough.
  search.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    const [first] = visibleItems();
    if (first) toggle(first.code, list.querySelector(".picker-option"));
  });
  clearButton.addEventListener("click", () => {
    clear();
    onChange([]);
  });
  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && root.classList.contains("open")) {
      setOpen(false);
      button.focus();
    }
  });
  document.addEventListener("click", (event) => {
    if (!root.contains(event.target)) setOpen(false);
  });

  updateLabel();
  return {
    /** The picked codes. */
    get: () => [...chosen],
    /** The picked items' short names, in the order they were picked. */
    names: () => [...chosen].map((code) => byCode.get(code).short),
    /** Unpicks everything, without calling onChange. */
    clear,
    /** Picks exactly these codes, without calling onChange. */
    set(codes) {
      chosen.clear();
      for (const code of codes) if (byCode.has(code)) chosen.add(code);
      updateLabel();
      draw();
    },
  };
}
