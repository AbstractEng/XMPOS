import type { Project } from "@xmp/core";
import {
  deleteTrack,
  editChain,
  editPerformance,
  parameterRegistry,
} from "../../../packages/core/src/edits.ts";
import {
  type PerformanceSnapshot,
  PerformanceTake,
  sceneLength,
} from "../../../packages/core/src/performance.ts";
import type { StudioAudio } from "./audio.ts";

interface Host {
  project: () => Project;
  track: () => string;
  scene: () => string;
  selectTrack: (id: string) => void;
  revision: () => number;
  edit: (change: (p: Project) => Project) => void;
  status: (s: string) => void;
  audio: StudioAudio;
  cancelScene: () => void;
}
const escapeText = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
export function savePerformancePosition(project: Project, snapshot: PerformanceSnapshot): Project {
  return editPerformance(project, (p) => {
    const scene = project.scenes.find((s) => s.id === snapshot.sceneId);
    if (scene)
      p.selection = {
        sceneId: scene.id,
        clips: Object.fromEntries(
          Object.entries(snapshot.clips).filter(([id, clip]) =>
            project.tracks.find((t) => t.id === id)?.clips.some((c) => c.id === clip),
          ),
        ),
      };
    const e = p.chain.find((e) => e.id === snapshot.position?.occurrenceId);
    if (e && snapshot.position)
      p.position = {
        occurrenceId: e.id,
        offset: Math.min(snapshot.position.offset, sceneLength(project, e.sceneId) * e.repeats - 1),
      };
    else delete p.position;
  });
}
export function installPerformancePanel(host: Host) {
  const root = document.getElementById("performance-panel");
  if (!root) throw new Error("Missing performance panel");
  root.innerHTML = `<div class="panel-head"><div><div class="eyebrow">PERFORM & ARRANGE</div><h2>Clips, song & macros</h2></div><button id="perf-enable" data-primary>Enable performance preview</button></div>
 <p class="small">Mac virtual controls · scene launches restart all slots; individual clips preserve other tracks. Empty slots stop their track. Delay returns keep their tails.</p>
 <div id="perf-actions" class="compact-row"><label>Track <select id="perf-track" aria-label="Performance track" data-primary></select></label><label>Clip <select id="perf-clip" aria-label="Performance clip" data-primary></select></label><button id="perf-queue-clip" data-primary>Queue clip</button><button id="perf-stop-track" data-primary>Stop track</button><button id="perf-cancel" data-primary>Cancel launch</button><button id="perf-play-song" data-primary>Play song</button></div>
 <div class="compact-row"><label>Scene <select id="perf-scene" aria-label="Song scene"></select></label><button id="perf-add-occurrence">Add scene to chain</button><button id="perf-resume">Resume saved position</button><label>Song end <select id="perf-end"><option value="stop">Stop</option><option value="loop">Loop</option></select></label></div>
 <p id="perf-state" role="status">Performance preview disabled</p><ol id="perf-chain" aria-label="Song chain"></ol>
 <div class="compact-row"><button id="perf-mute">Mute selected track</button><button id="perf-solo">Solo selected track</button><button id="perf-delete">Delete selected track</button><button id="perf-record">Record performance controls</button><button id="perf-finish" disabled>Finish performance pass</button><button id="perf-download" disabled>Download performance draft</button></div>
 <div class="compact-row"><label>Macro target <select id="perf-target" aria-label="Performance macro target"></select></label><label>Assignment amount <input id="perf-amount" type="number" min="-1" max="1" step="0.05" value="0.25"></label><button id="perf-add-macro">Add macro for target</button></div><div id="perf-macros"></div>
 <details><summary>Shared preview delay</summary><label>Delay (steps) <input id="perf-delay-steps" type="number" min="0.25" max="8" step="0.25" value="1"></label><label>Feedback <input id="perf-delay-feedback" type="number" min="0" max="0.75" step="0.05" value="0.35"></label><label>Return level <input id="perf-delay-wet" type="number" min="0" max="1" step="0.05" value="0"></label><label>Selected track send <input id="perf-delay-send" type="number" min="0" max="1" step="0.05" value="0"></label><button id="perf-delay-apply">Apply preview delay</button></details>
 <details><summary>Track and scene clip grid</summary><div id="perf-grid" class="clip-matrix" aria-label="Clip launch grid"></div></details>`;
  const el = <T extends HTMLElement = HTMLElement>(id: string) => {
    const n = document.getElementById(id);
    if (!n) throw new Error(`Missing ${id}`);
    return n as T;
  };
  const text = (id: string) => el<HTMLInputElement>(id).value,
    value = (id: string) => Number(text(id));
  const run = (fn: () => void) => {
    try {
      fn();
    } catch (error) {
      host.status(String(error));
    }
  };
  const requireEnabled = () => {
    if (!host.project().performance) throw new Error("Enable performance preview first");
  };
  let counter = 0,
    recording: { take: PerformanceTake; revision: number } | undefined,
    captured: unknown;
  const control = (kind: "mute" | "solo" | "macro", id: string, value: boolean | number) =>
    run(() => {
      requireEnabled();
      const e =
        kind === "macro"
          ? {
              id: `live-${counter++}`,
              kind,
              macroId: id,
              value: Number(value),
              at: host.audio.performancePosition ?? host.audio.position ?? 0,
            }
          : {
              id: `live-${counter++}`,
              kind,
              trackId: id,
              value: Boolean(value),
              at: host.audio.performancePosition ?? host.audio.position ?? 0,
            };
      if (recording) recording.take.record(e);
      else
        host.edit((project) =>
          editPerformance(project, (p) => {
            if (kind === "macro") {
              const m = p.macros.find((m) => m.id === id);
              if (!m) throw new Error("Macro unavailable");
              m.value = Number(value);
            }
            if (kind === "mute") p.mutes[id] = Boolean(value);
            if (kind === "solo") {
              p.solos = p.solos.filter((t) => t !== id);
              if (value) p.solos.push(id);
            }
          }),
        );
      host.audio.performanceControl(e);
      updateState();
    });
  const finish = () =>
    run(() => {
      if (!recording) return;
      const pass = recording;
      recording = undefined;
      const events = pass.take.finish();
      captured = { format: "xmp-performance-draft", version: 1, events };
      el<HTMLButtonElement>("perf-download").disabled = false;
      el<HTMLButtonElement>("perf-finish").disabled = true;
      if (pass.revision !== host.revision())
        throw new Error("Project changed during performance. Download the draft before retrying.");
      host.edit((project) => {
        let next = editPerformance(project, (p) => {
          p.events = [...p.events, ...events].sort((a, b) => a.at - b.at);
        });
        if (host.audio.performanceSnapshot)
          next = savePerformancePosition(next, host.audio.performanceSnapshot);
        return next;
      });
      host.status("Performance pass kept as one undoable edit");
    });
  el("perf-enable").onclick = () =>
    run(() => {
      if (host.audio.playing) throw new Error("Stop playback before enabling performance");
      host.edit((p) => editPerformance(p, () => {}));
      host.status("Performance preview enabled · no audio device opened");
    });
  el("perf-track").onchange = () => host.selectTrack(text("perf-track"));
  const queue = (track: string, clip: string | null) =>
    run(() => {
      requireEnabled();
      if (host.audio.playing) host.audio.queueClip(track, clip);
      else
        host.edit((project) =>
          editPerformance(project, (p) => {
            const scene = project.scenes.find((s) => s.id === host.scene());
            if (!scene) throw new Error("Missing scene");
            p.selection ??= { sceneId: scene.id, clips: { ...scene.clips } };
            if (p.selection.sceneId !== scene.id)
              p.selection = { sceneId: scene.id, clips: { ...scene.clips } };
            if (clip) p.selection.clips[track] = clip;
            else delete p.selection.clips[track];
          }),
        );
      host.status(
        host.audio.playing ? "Clip queued for next bar" : "Clip selection prepared for Play",
      );
    });
  el("perf-queue-clip").onclick = () => queue(host.track(), text("perf-clip") || null);
  el("perf-stop-track").onclick = () => queue(host.track(), null);
  el("perf-cancel").onclick = () => {
    host.audio.cancelLaunch?.();
    host.cancelScene();
    host.status("Uncommitted launch canceled");
  };
  el("perf-add-occurrence").onclick = () =>
    run(() => {
      requireEnabled();
      const chain = host.project().performance?.chain ?? [];
      let id: string;
      do {
        id = `occurrence-${counter++}`;
      } while (chain.some((e) => e.id === id));
      host.edit((p) => editChain(p, [...chain, { id, sceneId: text("perf-scene"), repeats: 1 }]));
    });
  const play = async (resume: boolean) => {
    try {
      requireEnabled();
      await host.audio.enable();
      host.audio.start(host.scene(), "song", resume);
    } catch (error) {
      host.status(String(error));
    }
  };
  el("perf-play-song").onclick = () => void play(false);
  el("perf-resume").onclick = () => void play(true);
  el("perf-end").onchange = () =>
    run(() =>
      host.edit((p) =>
        editPerformance(p, (s) => {
          s.end = text("perf-end") as "stop" | "loop";
        }),
      ),
    );
  el("perf-chain").onclick = (e) =>
    run(() => {
      const button = (e.target as HTMLElement).closest<HTMLElement>("[data-occurrence]");
      if (!button) return;
      const id = button.dataset.occurrence,
        chain = structuredClone(host.project().performance?.chain ?? []),
        at = chain.findIndex((e) => e.id === id);
      if (at < 0) return;
      if (button.dataset.action === "remove") chain.splice(at, 1);
      else if (button.dataset.action === "up" && at > 0) {
        const a = chain[at],
          b = chain[at - 1];
        if (a && b) {
          chain[at - 1] = a;
          chain[at] = b;
        }
      }
      host.edit((p) => editChain(p, chain));
    });
  el("perf-chain").onchange = (e) =>
    run(() => {
      const input = e.target as HTMLInputElement,
        id = input.dataset.repeats;
      const chain = structuredClone(host.project().performance?.chain ?? []),
        entry = chain.find((e) => e.id === id);
      if (entry) entry.repeats = Number(input.value);
      host.edit((p) => editChain(p, chain));
    });
  el("perf-mute").onclick = () =>
    control(
      "mute",
      host.track(),
      !(
        host.audio.performanceControls?.mutes[host.track()] ??
        host.project().performance?.mutes[host.track()] ??
        false
      ),
    );
  el("perf-solo").onclick = () =>
    control(
      "solo",
      host.track(),
      !(host.audio.performanceControls?.solos ?? host.project().performance?.solos ?? []).includes(
        host.track(),
      ),
    );
  el("perf-delete").onclick = () =>
    run(() => {
      host.edit((p) => deleteTrack(p, host.track()));
      host.status("Track removed · Undo restores its assignments");
    });
  el("perf-record").onclick = () =>
    run(() => {
      requireEnabled();
      if (!host.audio.playing)
        throw new Error("Start a scene or song before recording performance controls");
      if (recording) throw new Error("A performance pass is active");
      recording = {
        take: new PerformanceTake(`pass-${Date.now().toString(36)}-${counter++}`),
        revision: host.revision(),
      };
      el<HTMLButtonElement>("perf-finish").disabled = false;
      host.status("Recording virtual mute, solo and macro controls");
    });
  el("perf-finish").onclick = finish;
  el("perf-download").onclick = () => {
    if (!captured) return;
    const url = URL.createObjectURL(
        new Blob([JSON.stringify(captured)], { type: "application/json" }),
      ),
      a = document.createElement("a");
    a.href = url;
    a.download = "performance-pass.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  el("perf-add-macro").onclick = () =>
    run(() => {
      requireEnabled();
      host.edit((p) =>
        editPerformance(p, (s) => {
          let id: string;
          do {
            id = `macro-${counter++}`;
          } while (s.macros.some((m) => m.id === id));
          s.macros.push({
            id,
            name: `Macro ${s.macros.length + 1}`,
            value: 0.5,
            assignments: [{ parameter: text("perf-target"), amount: value("perf-amount") }],
          });
        }),
      );
    });
  el("perf-macros").oninput = (e) => {
    const input = e.target as HTMLInputElement,
      id = input.dataset.macro;
    if (id) control("macro", id, Number(input.value));
  };
  el("perf-delay-apply").onclick = () =>
    run(() => {
      requireEnabled();
      host.edit((p) =>
        editPerformance(p, (s) => {
          s.delay = {
            steps: value("perf-delay-steps"),
            feedback: value("perf-delay-feedback"),
            wet: value("perf-delay-wet"),
            sends: { ...s.delay.sends, [host.track()]: value("perf-delay-send") },
          };
        }),
      );
    });
  el("perf-grid").onclick = (e) => {
    const cell = (e.target as HTMLElement).closest<HTMLElement>("[data-launch-track]");
    if (cell) queue(cell.dataset.launchTrack ?? "", cell.dataset.launchClip || null);
  };
  let macrosSignature = "",
    gridSignature = "";
  const updateState = () => {
    const p = host.project().performance,
      snapshot = host.audio.performanceSnapshot,
      controls = host.audio.performanceControls;
    el("perf-state").textContent = !p
      ? "Enable preview to use song, clip and macro controls"
      : `${host.audio.playing ? "Playing" : "Stopped"} · ${snapshot?.sceneId ?? host.scene()} · ${snapshot?.position?.occurrenceId ?? "scene mode"}${host.audio.queuedLaunch ? ` · queued ${host.audio.queuedLaunch}` : ""}`;
    el("perf-mute").setAttribute(
      "aria-pressed",
      String(controls?.mutes[host.track()] ?? p?.mutes[host.track()] ?? false),
    );
    el("perf-solo").setAttribute(
      "aria-pressed",
      String((controls?.solos ?? p?.solos ?? []).includes(host.track())),
    );
  };
  const draw = () => {
    const project = host.project(),
      p = project.performance,
      snapshot = host.audio.performanceSnapshot,
      track = project.tracks.find((t) => t.id === host.track());
    if (!track) return;
    el<HTMLButtonElement>("perf-enable").disabled = Boolean(p);
    el("perf-track").innerHTML = project.tracks
      .map((t) => `<option value="${t.id}">${escapeText(t.name)}</option>`)
      .join("");
    el<HTMLSelectElement>("perf-track").value = track.id;
    const previous = text("perf-clip");
    el("perf-clip").innerHTML =
      '<option value="">Stop / empty</option>' +
      track.clips.map((c) => `<option value="${c.id}">${escapeText(c.name)}</option>`).join("");
    el<HTMLSelectElement>("perf-clip").value = track.clips.some((c) => c.id === previous)
      ? previous
      : (snapshot?.clips[track.id] ??
        project.scenes.find((s) => s.id === host.scene())?.clips[track.id] ??
        "");
    const previousScene = text("perf-scene");
    el("perf-scene").innerHTML = project.scenes
      .map((s) => `<option value="${s.id}">${escapeText(s.name)}</option>`)
      .join("");
    el<HTMLSelectElement>("perf-scene").value = project.scenes.some((s) => s.id === previousScene)
      ? previousScene
      : host.scene();
    el<HTMLSelectElement>("perf-end").value = p?.end ?? "stop";
    el("perf-chain").innerHTML = (p?.chain ?? [])
      .map(
        (e) =>
          `<li>${escapeText(project.scenes.find((s) => s.id === e.sceneId)?.name ?? e.sceneId)} <label>Repeats <input data-repeats="${e.id}" aria-label="Repeats ${e.id}" type="number" min="1" max="16" value="${e.repeats}"></label><button data-occurrence="${e.id}" data-action="up">Move up</button><button data-occurrence="${e.id}" data-action="remove">Remove</button> <small>${e.id === snapshot?.position?.occurrenceId ? "PLAYING" : ""}</small></li>`,
      )
      .join("");
    const before = text("perf-target"),
      registry = parameterRegistry(project);
    el("perf-target").innerHTML = registry
      .map((p) => `<option value="${p.id}">${escapeText(p.name)}</option>`)
      .join("");
    if (registry.some((p) => p.id === before)) el<HTMLSelectElement>("perf-target").value = before;
    const valid = new Set(registry.map((p) => p.id)),
      signature = JSON.stringify((p?.macros ?? []).map((m) => [m.id, m.name, m.assignments]));
    if (signature !== macrosSignature) {
      macrosSignature = signature;
      el("perf-macros").innerHTML = (p?.macros ?? [])
        .map(
          (m) =>
            `<label>${escapeText(m.name)} <input aria-label="${escapeText(m.name)}" type="range" min="0" max="1" step="0.01" value="${m.value}" data-macro="${m.id}"></label><p class="small">${m.assignments.map((a) => `${escapeText(a.parameter)}${valid.has(a.parameter) ? "" : " (unavailable)"}`).join(", ") || "No assignments"}</p>`,
        )
        .join("");
    }
    for (const input of el("perf-macros").querySelectorAll<HTMLInputElement>("[data-macro]")) {
      const m = p?.macros.find((m) => m.id === input.dataset.macro);
      if (m && document.activeElement !== input)
        input.value = String(host.audio.performanceControls?.macros[m.id] ?? m.value);
    }
    el("perf-mute").setAttribute("aria-pressed", String(p?.mutes[track.id] ?? false));
    el("perf-solo").setAttribute("aria-pressed", String(p?.solos.includes(track.id) ?? false));
    el<HTMLButtonElement>("perf-delete").disabled = project.tracks.length <= 1;
    for (const [id, v] of [
      ["perf-delay-steps", p?.delay.steps ?? 1],
      ["perf-delay-feedback", p?.delay.feedback ?? 0.35],
      ["perf-delay-wet", p?.delay.wet ?? 0],
      ["perf-delay-send", p?.delay.sends[track.id] ?? 0],
    ] as const)
      el<HTMLInputElement>(id).value = String(v);
    const gridKey = JSON.stringify([
      project.tracks.map((t) => [t.id, t.name, t.clips.map((c) => [c.id, c.name])]),
      project.scenes,
    ]);
    if (gridKey !== gridSignature) {
      gridSignature = gridKey;
      el("perf-grid").style.setProperty("--scene-count", String(project.scenes.length));
      const header = `<div class="clip-grid-row clip-grid-header"><strong>Tracks</strong>${project.scenes.map((s) => `<span>${escapeText(s.name)}</span>`).join("")}</div>`;
      el("perf-grid").innerHTML =
        header +
        project.tracks
          .map(
            (t) =>
              `<div class="clip-grid-row"><strong>${escapeText(t.name)}</strong>${project.scenes
                .map((s) => {
                  const clip = escapeText(
                    t.clips.find((c) => c.id === s.clips[t.id])?.name ?? "Stop",
                  );
                  return `<button data-launch-track="${t.id}" data-launch-clip="${s.clips[t.id] ?? ""}" aria-label="Launch ${escapeText(t.name)} ${escapeText(s.name)}" title="${clip}">${clip}</button>`;
                })
                .join("")}</div>`,
          )
          .join("");
    }
    el("perf-state").textContent = !p
      ? "Enable preview to use song, clip and macro controls"
      : `${snapshot?.running ? "Playing" : "Stopped"} · ${snapshot?.sceneId ?? host.scene()} · ${snapshot?.position?.occurrenceId ?? "scene mode"}${host.audio.queuedLaunch ? ` · queued ${host.audio.queuedLaunch}` : ""}`;
  };
  return {
    draw,
    updateState,
    finish,
    onStop() {
      if (recording) finish();
      else if (host.project().performance && host.audio.performanceSnapshot)
        host.edit((p) =>
          savePerformancePosition(p, host.audio.performanceSnapshot as PerformanceSnapshot),
        );
    },
  };
}
