export interface ControlBookmark {
  element: HTMLElement;
  parameter?: string;
  track?: string;
}
export function installControlFocus(
  doc: Document,
  onUnavailable: (text: string) => void = () => {},
) {
  let bound: ControlBookmark | undefined;
  const capture = (element: HTMLElement | null): ControlBookmark => ({
    element: element ?? (doc.getElementById("help") as HTMLElement),
    ...(element?.dataset.parameter
      ? { parameter: element.dataset.parameter, track: element.dataset.track }
      : {}),
  });
  const resolve = (mark: ControlBookmark) => {
    if (mark.parameter)
      return [...doc.querySelectorAll<HTMLElement>("[data-parameter]")].find(
        (el) =>
          el.dataset.parameter === mark.parameter &&
          el.dataset.track === mark.track &&
          !el.closest("[hidden]") &&
          !el.hasAttribute("disabled"),
      );
    return mark.element.isConnected && !mark.element.closest("[hidden]") ? mark.element : undefined;
  };
  doc.addEventListener("focusin", (e) => {
    const el = e.target as HTMLElement;
    if (el.dataset.parameter) bound = capture(el);
  });
  return {
    capture,
    assigned: () => bound ?? capture(doc.activeElement as HTMLElement),
    parameter: () => bound?.parameter,
    restore(mark: ControlBookmark) {
      const target = resolve(mark);
      if (target) target.focus();
      else {
        bound = undefined;
        doc.getElementById("help")?.focus();
        onUnavailable(
          "Original control unavailable. Select a parameter before using the virtual encoder.",
        );
      }
      return Boolean(target);
    },
    turn(delta: number, apply: (parameter: string, delta: number) => void) {
      if (!Number.isFinite(delta) || Math.abs(delta) > 100)
        throw new Error("Invalid virtual encoder delta");
      if (!bound?.parameter || !resolve(bound)) {
        bound = undefined;
        onUnavailable("Select a valid parameter before using the virtual encoder.");
        return false;
      }
      apply(bound.parameter, delta);
      return true;
    },
  };
}
export type ControlFocus = ReturnType<typeof installControlFocus>;
export function installErrorRecovery(doc: Document, focus: ControlFocus) {
  const dialog = doc.getElementById("error-dialog"),
    body = doc.getElementById("error-message"),
    close = doc.getElementById("error-close");
  if (!dialog || !body || !close) throw new Error("Missing error recovery controls");
  let bookmark: ControlBookmark | undefined;
  const dismiss = () => {
    dialog.hidden = true;
    for (const node of doc.querySelectorAll<HTMLElement>("main,.topbar")) node.inert = false;
    if (bookmark) focus.restore(bookmark);
  };
  close.onclick = dismiss;
  dialog.addEventListener("keydown", (e) => {
    if (e.key === "Tab") {
      e.preventDefault();
      close.focus();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      dismiss();
    }
  });
  return {
    show(message: string) {
      if (dialog.hidden) bookmark = focus.assigned();
      for (const node of doc.querySelectorAll<HTMLElement>("main,.topbar")) node.inert = true;
      body.textContent = message;
      dialog.hidden = false;
      close.focus();
    },
    dismiss,
  };
}
