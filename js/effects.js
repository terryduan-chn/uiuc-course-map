// Page-wide motion: cards that float in as they scroll into view, cards that tilt toward the
// pointer with a glow that follows it, ripples on clicked buttons, shooting stars, and smooth
// transitions between pages. Everything here animates only opacity and transforms (cheap for
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
const TILT_SELECTOR = ".subject-card, .popular-course, .brief-card, .hero-stat, .stat";
const TILT_DEGREES = 6;
const RIPPLE_SELECTOR =
  ".btn, .view-toggle button, .site-nav a, .theme-toggle, .picker-button, .graph-card-actions button, .level-button";
const SHOOTING_STAR_EVERY_MS = [5000, 11000]; // a random wait between these

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

/** Cards lean toward the pointer, and a soft light follows it across them. */
function watchPointer() {
  let pending = null;
  document.addEventListener("pointermove", (event) => {
    if (event.pointerType !== "mouse") return;
    pending = event;
    requestAnimationFrame(() => {
      if (!pending) return;
      const card = pending.target.closest?.(TILT_SELECTOR);
      if (card) {
        const box = card.getBoundingClientRect();
        const x = (pending.clientX - box.left) / box.width;
        const y = (pending.clientY - box.top) / box.height;
        card.style.setProperty("--mx", `${(x * 100).toFixed(1)}%`);
        card.style.setProperty("--my", `${(y * 100).toFixed(1)}%`);
        card.style.setProperty("--ry", `${((x - 0.5) * 2 * TILT_DEGREES).toFixed(2)}deg`);
        card.style.setProperty("--rx", `${((0.5 - y) * 2 * TILT_DEGREES).toFixed(2)}deg`);
      }
      pending = null;
    });
  });
  // Level the card again when the pointer leaves it.
  document.addEventListener("pointerout", (event) => {
    const card = event.target.closest?.(TILT_SELECTOR);
    if (card && !card.contains(event.relatedTarget)) {
      card.style.removeProperty("--rx");
      card.style.removeProperty("--ry");
    }
  });
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

/** Now and then a shooting star crosses the background (dark theme only, page visible). */
function launchShootingStars(layer) {
  const [shortest, longest] = SHOOTING_STAR_EVERY_MS;
  const next = () => setTimeout(launch, shortest + Math.random() * (longest - shortest));
  const launch = () => {
    if (!document.hidden && document.documentElement.dataset.theme !== "light") {
      const star = document.createElement("span");
      star.className = "shooting-star";
      star.style.top = `${Math.random() * 45}%`;
      star.style.left = `${20 + Math.random() * 70}%`;
      layer.append(star);
      star.addEventListener("animationend", () => star.remove());
    }
    next();
  };
  next();
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
export function startEffects({ main, sky }) {
  if (reducedMotion()) return;
  watchReveals(main);
  watchPointer();
  watchRipples();
  launchShootingStars(sky);
}
