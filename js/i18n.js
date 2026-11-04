// English or Chinese, chosen with the switch in the top bar and saved in this browser. English is
// the default, and the browser's own language is ignored on purpose. Every piece of text sits in
// the code as tr("English", "中文"), because with two languages that keeps each sentence's word
// order and plurals together. Switching reloads the page, so text can be worked out once.
// Official course names, descriptions and catalog requirements stay in English.

const LANGUAGE_KEY = "language";

function savedLanguage() {
  try {
    return localStorage.getItem(LANGUAGE_KEY);
  } catch {
    return null; // storage blocked, or running in the tests
  }
}

const chinese = savedLanguage() === "zh";

/** The text for the page's language. */
export const tr = (english, inChinese) => (chinese ? inChinese : english);

/** Puts index.html's fixed text in Chinese, from its data-zh attributes. */
export function translatePage() {
  if (!chinese) return;
  document.documentElement.lang = "zh-CN";
  for (const node of document.querySelectorAll("[data-zh]")) node.textContent = node.dataset.zh;
  for (const node of document.querySelectorAll("[data-zh-html]")) node.innerHTML = node.dataset.zhHtml;
  for (const node of document.querySelectorAll("[data-zh-placeholder]")) node.placeholder = node.dataset.zhPlaceholder;
  for (const node of document.querySelectorAll("[data-zh-title]")) node.title = node.dataset.zhTitle;
  for (const node of document.querySelectorAll("[data-zh-label]")) {
    node.setAttribute("aria-label", node.dataset.zhLabel);
  }
}

/** @param {HTMLButtonElement} button shows the language it switches to */
export function setUpLanguageToggle(button) {
  button.textContent = tr("中文", "EN");
  button.lang = tr("zh-CN", "en");
  button.setAttribute("aria-label", tr("切换到中文", "Switch to English"));
  button.addEventListener("click", () => {
    try {
      localStorage.setItem(LANGUAGE_KEY, chinese ? "en" : "zh");
    } catch {
      return; // nowhere to keep the choice, and the switch works by reloading
    }
    location.reload();
  });
}
