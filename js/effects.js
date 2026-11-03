// Page-wide motion, kept calm: cards that float in as they scroll into view, ripples on
// clicked buttons, and smooth transitions between pages. Everything here animates only opacity and transforms (cheap for
// the browser), and turns itself off when the computer asks for reduced motion.

const REVEAL_SELECTOR = [
  ".subject-card",
  ".popular-course",
  ".hero-stat",
  ".result-link",
  ".brief-card",
  ".stat",
  ".detail-section",
].join(", ");
const REVEAL_STAGGER_MS = 35;
const REVEAL_STAGGER_LIMIT = 12; // later cards in a batch don't wait any longer than this
const RIPPLE_SELECTOR =
  ".btn, .view-toggle button, .site-nav a, .theme-toggle, .picker-button, .graph-card-actions button, .level-button";

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Cards fade and float up the first time they scroll into view, a few at a time. */
function watchReveals(root) {
  const seen = new WeakSet();
  let batch = 0;
  let batchTimer = null;
  const appear = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const card = entry.target;
        card.style.setProperty("--reveal-delay", `${Math.min(batch++, REVEAL_STAGGER_LIMIT) * REVEAL_STAGGER_MS}ms`);
        card.classList.add("revealed");
        appear.unobserve(card);
      }
      // Cards that appear together stagger; the next scroll starts a new batch.
      clearTimeout(batchTimer);
      batchTimer = setTimeout(() => (batch = 0), 120);
    },
    { rootMargin: "0px 0px -40px 0px" },
  );
  const watch = () => {
    for (const card of root.querySelectorAll(REVEAL_SELECTOR)) {
      if (seen.has(card)) continue;
      seen.add(card);
      card.classList.add("reveal");
      appear.observe(card);
    }
  };
  // Lists are redrawn all the time (search, subjects, courses), so watch for new cards.
  new MutationObserver(watch).observe(root, { childList: true, subtree: true });
  watch();
}

/** A ring of light spreads from where a button was pressed. */
function watchRipples() {
  document.addEventListener("pointerdown", (event) => {
    const button = event.target.closest?.(RIPPLE_SELECTOR);
    if (!button) return;
    const box = button.getBoundingClientRect();
    const size = Math.max(box.width, box.height) * 2;
    const ripple = document.createElement("span");
    ripple.className = "ripple";
    ripple.style.width = ripple.style.height = `${size}px`;
    ripple.style.left = `${event.clientX - box.left - size / 2}px`;
    ripple.style.top = `${event.clientY - box.top - size / 2}px`;
    button.append(ripple);
    ripple.addEventListener("animationend", () => ripple.remove());
  });
}

/**
 * Runs `update`, sliding the old page out and the new one in when the browser supports it.
 * Only used when moving between kinds of page (home, subject, course, star map).
 */
export function withPageTransition(update) {
  if (!document.startViewTransition || reducedMotion()) {
    update();
    return;
  }
  // A newer navigation can cut a transition short; that is fine, so its rejection is ignored.
  const transition = document.startViewTransition(update);
  transition.ready.catch(() => {});
  transition.finished.catch(() => {});
}

/** Starts every page-wide effect. */
export function startEffects({ main }) {
  if (reducedMotion()) return;
  watchReveals(main);
  watchRipples();
}
