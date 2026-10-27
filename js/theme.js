// The light/dark switch in the top bar. The choice is saved in this browser; until there is
// one, the page follows the computer's setting (index.html applies it before the first paint).

const THEME_KEY = "theme";
const REVEAL_MS = 650;

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** @param {HTMLButtonElement} button the sun/moon button */
export function setUpThemeToggle(button) {
  const root = document.documentElement;
  const describe = () => {
    const dark = root.dataset.theme !== "light";
    button.setAttribute("aria-label", dark ? "Switch to light theme" : "Switch to dark theme");
    button.title = dark ? "Light theme" : "Dark theme";
  };
  describe();

  button.addEventListener("click", () => {
    const next = root.dataset.theme === "light" ? "dark" : "light";
    const apply = () => {
      root.dataset.theme = next;
      try {
        localStorage.setItem(THEME_KEY, next);
      } catch {
        // Not saved (storage blocked), but the theme still changes for this visit.
      }
      describe();
    };
    if (!document.startViewTransition || reducedMotion()) {
      apply();
      return;
    }
    // The new theme spreads out from the button in a growing circle.
    const box = button.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    root.classList.add("theme-switching");
    const transition = document.startViewTransition(apply);
    transition.ready
      .then(() => {
        root.animate(
          { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
          {
            duration: REVEAL_MS,
            easing: "cubic-bezier(0.22, 0.61, 0.36, 1)",
            pseudoElement: "::view-transition-new(root)",
          },
        );
      })
      .catch(() => {}); // cut short (say, the tab was hidden): the theme still changes, just without the reveal
    transition.finished.finally(() => root.classList.remove("theme-switching"));
  });
}
