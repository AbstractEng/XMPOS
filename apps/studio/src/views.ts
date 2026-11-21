export type StudioView = "all" | "play" | "sounds" | "pattern" | "perform" | "mix";
export const previewDisplayProfile = Object.freeze({
  id: "p07-mac-1280x800",
  width: 1280,
  height: 800,
  physicalDisplayQualified: false,
  primaryMinPixels: 44,
});
export function installViews(doc: Document) {
  const views: StudioView[] = ["play", "sounds", "pattern", "perform", "mix", "all"],
    nav = doc.getElementById("view-nav");
  if (!nav) throw new Error("Missing view navigation");
  const sections = {
    pads: doc.querySelector<HTMLElement>(".pads-panel"),
    steps: doc.querySelector<HTMLElement>(".sequence-panel"),
    notes: doc.getElementById("sequencer-panel"),
    sounds: doc.getElementById("instrument-panel"),
    performance: doc.getElementById("performance-panel"),
    scenes: doc.querySelector<HTMLElement>(".scenes-panel"),
    mix: doc.querySelector<HTMLElement>(".mixer"),
  };
  const actions = doc.querySelector<HTMLElement>(".project-actions"),
    home = actions?.parentElement;
  const help = doc.getElementById("help"),
    helpHome = help?.parentElement;
  const show = (view: StudioView) => {
    if (!views.includes(view)) throw new Error("Unknown Studio view");
    doc.body.dataset.view = view;
    try {
      doc.defaultView?.localStorage.setItem("xmp-studio-workspace", view);
    } catch {
      /* Private browsing still works. */
    }
    if (help && helpHome) {
      if (view === "all") helpHome.append(help);
      else nav.insertBefore(help, nav.querySelector(".encoder-controls"));
    }
    if (actions && home) {
      if (view === "all") home.append(actions);
      else nav.insertBefore(actions, nav.querySelector(".encoder-controls"));
    }
    for (const [key, section] of Object.entries(sections))
      if (section)
        section.hidden =
          view !== "all" &&
          !(
            (view === "play" && key === "pads") ||
            (view === "sounds" && key === "sounds") ||
            (view === "pattern" && (key === "steps" || key === "notes")) ||
            (view === "perform" && (key === "performance" || key === "scenes")) ||
            (view === "mix" && key === "mix")
          );
    for (const button of nav.querySelectorAll<HTMLElement>("[data-view]"))
      button.setAttribute("aria-selected", String(button.dataset.view === view));
  };
  nav.addEventListener("click", (e) => {
    const view = (e.target as HTMLElement).closest<HTMLElement>("[data-view]")?.dataset.view as
      | StudioView
      | undefined;
    if (view) show(view);
  });
  for (const [hash, view] of [
    ["#sequencer-panel", "pattern"],
    ["#instrument-panel", "sounds"],
    ["#performance-panel", "perform"],
  ] as const)
    for (const link of doc.querySelectorAll<HTMLAnchorElement>(`a[href="${hash}"]`))
      link.addEventListener("click", () => show(view));
  let initial: StudioView = "perform";
  try {
    const saved = doc.defaultView?.localStorage.getItem("xmp-studio-workspace") as StudioView;
    if (views.includes(saved)) initial = saved;
  } catch {
    /* Use Clips on first visit. */
  }
  show(initial);
  return { show, current: () => doc.body.dataset.view as StudioView };
}
