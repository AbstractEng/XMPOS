const chapters = [...document.querySelectorAll("[data-chapter]")];
const links = [
  ...document.querySelectorAll('#contents a[href^="#"],.mobile-contents a[href^="#"]'),
];
const search = document.getElementById("manual-search");
const status = document.getElementById("search-status");
const empty = document.getElementById("empty-search");
const text = new Map(chapters.map((chapter) => [chapter, chapter.textContent.toLowerCase()]));
const filter = () => {
  const words = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, 16);
  let shown = 0;
  for (const chapter of chapters) {
    const visible = words.every((word) => text.get(chapter).includes(word));
    chapter.hidden = !visible;
    if (visible) shown++;
  }
  status.hidden = !words.length;
  status.textContent = `${shown} of ${chapters.length} chapters match. Clear search to show all.`;
  empty.hidden = shown > 0;
};
document.getElementById("search-wrap").hidden = false;
search.addEventListener("input", filter);
search.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    search.value = "";
    filter();
  }
});
document.getElementById("clear-search").addEventListener("click", () => {
  search.value = "";
  filter();
  search.focus();
});
document.addEventListener("keydown", (event) => {
  if (
    event.key === "/" &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.target.closest("input,textarea,select,button,[contenteditable]")
  ) {
    event.preventDefault();
    search.focus();
  }
});
for (const button of document.querySelectorAll("[data-print]")) {
  button.hidden = false;
  button.addEventListener("click", () => window.print());
}
// Match anchor offsets to the actual header, including narrow screens and text enlargement.
const toolbar = document.querySelector(".toolbar");
if ("ResizeObserver" in window) {
  new ResizeObserver(() => {
    document.documentElement.style.setProperty(
      "--toolbar-height",
      `${toolbar.getBoundingClientRect().height}px`,
    );
  }).observe(toolbar);
}
const contents = document.getElementById("manual-contents");
document.querySelector(".chapter-shortcut").addEventListener("click", () => {
  contents.open = true;
  contents.querySelector("summary").focus({ preventScroll: true });
});
for (const [i, wrapper] of [...document.querySelectorAll(".table-scroll")].entries()) {
  const hint = document.createElement("p");
  hint.className = "table-hint";
  hint.id = `table-hint-${i}`;
  hint.textContent = "On a small screen, swipe the table sideways for more columns.";
  wrapper.before(hint);
  wrapper.tabIndex = 0;
  wrapper.setAttribute("role", "region");
  wrapper.setAttribute(
    "aria-label",
    wrapper.querySelector("caption")?.textContent || "Reference table",
  );
  wrapper.setAttribute("aria-describedby", hint.id);
}
for (const pre of document.querySelectorAll("pre")) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "copy-code";
  button.textContent = "Copy commands";
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(pre.querySelector("code").textContent);
      button.textContent = "Copied";
    } catch {
      button.textContent = "Select code to copy";
    }
    setTimeout(() => {
      button.textContent = "Copy commands";
    }, 2400);
  });
  pre.append(button);
}
function setActive(id) {
  for (const link of links) {
    if (link.hash === `#${id}`) link.setAttribute("aria-current", "location");
    else link.removeAttribute("aria-current");
  }
}
function revealAnchor(hash, scroll = false) {
  let id;
  try {
    id = decodeURIComponent(hash.slice(1));
  } catch {
    return;
  }
  const target = document.getElementById(id);
  if (!target) return;
  for (let parent = target.parentElement; parent; parent = parent.parentElement)
    if (parent instanceof HTMLDetailsElement) parent.open = true;
  if (scroll) target.scrollIntoView({ block: "start" });
}
window.addEventListener("hashchange", () => revealAnchor(window.location.hash, true));
revealAnchor(window.location.hash, true);
for (const link of document.querySelectorAll('a[href^="#"]'))
  link.addEventListener("click", () => {
    if (link.hash !== "#manual-contents" && link.hash !== "#main" && search.value) {
      search.value = "";
      filter();
    }
    revealAnchor(link.hash);
    setActive(link.hash.slice(1));
    const menu = link.closest(".mobile-contents");
    if (menu) menu.open = false;
  });
if ("IntersectionObserver" in window) {
  const visible = new Set();
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) visible.add(entry.target);
        else visible.delete(entry.target);
      }
      const first = [...visible]
        .filter((chapter) => !chapter.hidden)
        .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0];
      if (first) setActive(first.id);
    },
    { rootMargin: "-140px 0px -50% 0px" },
  );
  for (const chapter of chapters) observer.observe(chapter);
}
// Print all chapters and expanded answers, even after searching the manual.
const disclosureState = new Map();
window.addEventListener("beforeprint", () => {
  for (const detail of document.querySelectorAll("details")) {
    if (!disclosureState.has(detail)) disclosureState.set(detail, detail.open);
    detail.open = true;
  }
});
window.addEventListener("afterprint", () => {
  for (const [detail, open] of disclosureState) detail.open = open;
  disclosureState.clear();
});

// Keyboard access to the diagram's horizontal scroll area.
for (const diagram of document.querySelectorAll(".relationship-diagram")) diagram.tabIndex = 0;
