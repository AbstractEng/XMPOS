// Direct value editing for the desktop inspector. The existing validated
// change handlers remain the single mutation route.
export function installInlineValues(doc: Document) {
  let sheet: HTMLElement | undefined;
  const close = () => {
    sheet?.remove();
    sheet = undefined;
  };
  doc.addEventListener("click", (event) => {
    const output = (event.target as Element).closest<HTMLOutputElement>("output");
    if (!output) return;
    const label = output.closest("label"),
      input = label?.querySelector<HTMLInputElement>('input[type="range"]');
    if (!input || input.disabled) return;
    close();
    sheet = doc.createElement("section");
    sheet.className = "inline-value-editor";
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    sheet.setAttribute("aria-label", input.getAttribute("aria-label") ?? "Edit value");
    const title = doc.createElement("h2");
    title.textContent = input.getAttribute("aria-label") ?? "Edit value";
    const value = doc.createElement("input");
    value.type = "number";
    value.min = input.min;
    value.max = input.max;
    value.step = input.step || "1";
    value.value = input.value;
    value.setAttribute("aria-label", "Value");
    const apply = doc.createElement("button"),
      cancel = doc.createElement("button");
    apply.textContent = "Apply";
    cancel.textContent = "Cancel";
    const commit = () => {
      if (!value.checkValidity() || !Number.isFinite(Number(value.value))) return;
      input.value = value.value;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      close();
      (input.id ? doc.getElementById(input.id) : input)?.focus();
    };
    apply.onclick = commit;
    cancel.onclick = () => {
      close();
      input.focus();
    };
    value.onkeydown = (e) => {
      if (e.key === "Enter") commit();
      if (e.key === "Escape") {
        close();
        input.focus();
      }
    };
    sheet.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Escape") {
        close();
        input.focus();
      }
      if (event.key === "Tab") {
        const targets = [value, cancel, apply],
          current = targets.indexOf(doc.activeElement as HTMLInputElement),
          next = (current + (event.shiftKey ? -1 : 1) + targets.length) % targets.length;
        event.preventDefault();
        targets[next]?.focus();
      }
    });
    sheet.append(title, value, cancel, apply);
    doc.body.append(sheet);
    value.focus();
    value.select();
  });
  for (const output of doc.querySelectorAll<HTMLElement>("output")) {
    output.tabIndex = 0;
    output.setAttribute("role", "button");
    output.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        event.stopPropagation();
        output.click();
      }
    });
  }
}
