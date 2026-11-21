import { createDemoProject, type Project } from "@xmp/core";

import { drumKitFromWavs } from "../../../packages/core/src/drum-kits.ts";
import { applyDrumKit } from "../../../packages/core/src/edits.ts";
import { cc0Kits, isOriginalKit, loadKitById, originalKits } from "./bundled-drum-kits.ts";
import { logError } from "./error-log.ts";
import { loadKits, type SavedKit, saveKit } from "./kit-storage.ts";

interface Host {
  // The track whose own kit a kit replaces (project format 7); else the shared kit.
  track?: () => string;
  project(): Project;
  revision(): number;
  mutate(change: (project: Project) => Project): void;
}
export function installDrumKitPanel(doc: Document, host: Host) {
  const root = doc.getElementById("kit-tools");
  if (!root) throw new Error("Missing drum kit controls");
  root.innerHTML = `<details id="kit-picker" class="kit-picker"><summary>Drum kits</summary><div class="kit-popover"><button id="kit-close" aria-label="Close drum kits">Close</button><div class="kit-controls"><label>Drum kit <select id="kit-choice" aria-label="Drum kit"><option value="original">Original demo kit</option></select></label><button id="kit-load">Load kit</button><label>Import name <input id="kit-name" aria-label="Imported kit name" maxlength="80" value="My drum kit"></label><button id="kit-import">Import WAV kit</button><input id="kit-files" type="file" accept=".wav,audio/wav,audio/x-wav" multiple hidden></div><p class="small">Kits replace the selected track's own kit when it has one, else the shared 16 pads. Patterns stay; Undo restores sounds. Import 1–16 WAV one-shots from an unzipped pack.</p><p id="kit-status" class="small" role="status">Kits stay on this computer.</p></div></details>`;
  const el = <T extends HTMLElement = HTMLElement>(id: string) => doc.getElementById(id) as T;
  const choice = el<HTMLSelectElement>("kit-choice"),
    files = el<HTMLInputElement>("kit-files");
  el("kit-close").onclick = () => {
    el<HTMLDetailsElement>("kit-picker").open = false;
    root.querySelector("summary")?.focus();
  };
  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      el<HTMLDetailsElement>("kit-picker").open = false;
      root.querySelector("summary")?.focus();
    }
  });
  let kits: SavedKit[] = [],
    busy = false,
    ready = false;
  const status = (text: string) => {
    el("kit-status").textContent = text;
  };
  const options = () => {
    const previous = choice.value;
    for (const group of Array.from(choice.querySelectorAll("optgroup"))) group.remove();
    for (const option of Array.from(choice.options))
      if (option.value !== "original") option.remove();
    const own = doc.createElement("optgroup");
    own.label = "XMP original kits";
    for (const kit of originalKits) {
      const option = doc.createElement("option");
      option.value = kit.id;
      option.textContent = kit.name;
      own.append(option);
    }
    choice.append(own);
    const cc0 = doc.createElement("optgroup");
    cc0.label = "CC0 test kits";
    for (const kit of cc0Kits) {
      const option = doc.createElement("option");
      option.value = kit.id;
      option.textContent = kit.name;
      cc0.append(option);
    }
    choice.append(cc0);
    for (const item of kits) {
      const option = doc.createElement("option");
      option.value = item.id;
      option.textContent = item.kit.name;
      choice.append(option);
    }
    if (Array.from(choice.options).some((option) => option.value === previous))
      choice.value = previous;
  };
  const setBusy = (value: boolean) => {
    busy = value;
    el<HTMLButtonElement>("kit-import").disabled = value || !ready;
    el<HTMLButtonElement>("kit-load").disabled = value;
  };
  el("kit-load").onclick = async () => {
    if (busy) return;
    const revision = host.revision(),
      original = host.project(),
      selected = choice.value;
    setBusy(true);
    status(`Loading ${choice.selectedOptions[0]?.textContent ?? "kit"}…`);
    try {
      const demo = createDemoProject();
      const kit =
        selected === "original"
          ? {
              name: "Original demo kit",
              samples: demo.samples.map(({ name, sampleRate, pcm }) => ({ name, sampleRate, pcm })),
            }
          : isOriginalKit(selected) || cc0Kits.some((item) => item.id === selected)
            ? await loadKitById(selected)
            : kits.find((item) => item.id === selected)?.kit;
      if (!kit) throw new Error("Choose an available kit");
      if (revision !== host.revision() || original !== host.project())
        throw new Error("Project changed while loading kit; retry");
      host.mutate((project) => applyDrumKit(project, kit, host.track?.()));
      status(`Loaded ${kit.name} · Undo restores the previous pad bank`);
    } catch (error) {
      status(logError("Kit load failed", error));
    } finally {
      setBusy(false);
    }
  };
  el("kit-import").onclick = () => {
    if (!busy && ready) files.click();
  };
  files.onchange = async () => {
    const selected = Array.from(files.files ?? []),
      revision = host.revision(),
      project = host.project();
    if (!selected.length || busy) return;
    setBusy(true);
    try {
      if (selected.length > 16) throw new Error("Choose 1–16 WAV one-shots");
      if (
        selected.some((file) => file.size > 4 * 1024 * 1024) ||
        selected.reduce((n, file) => n + file.size, 0) > 16 * 1024 * 1024
      )
        throw new Error("Each WAV must be at most 4 MiB; kit total at most 16 MiB");
      const decoded = [];
      for (const file of selected)
        decoded.push({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
      const kit = drumKitFromWavs(el<HTMLInputElement>("kit-name").value, decoded);
      // Validate the complete replacement before touching either library or project.
      applyDrumKit(project, kit);
      if (revision !== host.revision() || project !== host.project())
        throw new Error("Project changed during import; retry");
      const item = await saveKit(kit);
      kits.push(item);
      options();
      choice.value = item.id;
      if (revision !== host.revision() || project !== host.project()) {
        status(`Saved ${kit.name} to the library. Project changed; choose Load kit when ready.`);
        return;
      }
      host.mutate((next) => applyDrumKit(next, kit, host.track?.()));
      status(
        `Loaded ${kit.name} · ${kit.samples.length} sounds · unused pads are silent · Undo restores sounds`,
      );
    } catch (error) {
      status(`Kit import failed: ${logError("invalid kit", error)}`);
    } finally {
      files.value = "";
      setBusy(false);
    }
  };
  options();
  setBusy(false);
  const initialized = loadKits()
    .then((saved) => {
      kits = saved;
      options();
      ready = true;
      setBusy(busy);
    })
    .catch(() => {
      status("Kit library unavailable. Current project retained; original kit still available.");
    });
  return { initialized };
}
