import {
  isUsageCounter,
  isUsagePage,
  USAGE_MAX_MS,
  type UsagePage,
  type UsageSnapshot,
} from "./usage-schema.ts";

// Clock-only state is separate from browser wiring so idle/background timing,
// suspended tabs and retransmission can be tested without a running UI.
export class UsageSession {
  private started: number;
  private last: number;
  private interaction: number;
  private page: UsagePage = "boot";
  private visible = true;
  private playing = false;
  private recording = false;
  private seq = 0;
  private totals = { elapsedMs: 0, activeMs: 0, visibleMs: 0, playMs: 0, recordMs: 0 };
  private pages: UsageSnapshot["pages"] = {};
  private counters: Record<string, number> = {};
  constructor(
    private workspace: "device" | "studio",
    private id: string,
    now: number,
  ) {
    this.started = this.last = this.interaction = now;
  }
  private settle(now: number) {
    const end = Math.max(this.last, Math.min(this.started + USAGE_MAX_MS, now));
    const delta = end - this.last;
    const active =
      this.playing || this.recording
        ? delta
        : this.visible
          ? Math.max(0, Math.min(end, this.interaction + 60000) - this.last)
          : 0;
    this.totals.elapsedMs = end - this.started;
    this.totals.visibleMs += this.visible ? delta : 0;
    this.totals.activeMs += active;
    this.totals.playMs += this.playing ? delta : 0;
    this.totals.recordMs += this.recording ? delta : 0;
    this.pages[this.page] = (this.pages[this.page] ?? 0) + active;
    this.last = end;
  }
  expired(now: number) {
    return (
      now - this.started >= USAGE_MAX_MS ||
      (!this.playing && !this.recording && now - this.interaction >= 30 * 60000)
    );
  }
  state(now: number, page: string, playing: boolean, recording: boolean, visible: boolean) {
    this.settle(now);
    this.page = isUsagePage(page) ? page : this.page;
    this.playing = playing;
    this.recording = recording;
    this.visible = visible;
  }
  interact(now: number) {
    this.settle(now);
    this.interaction = now;
  }
  count(now: number, key: string, count = 1) {
    if (!isUsageCounter(key) || !Number.isInteger(count) || count <= 0) return;
    this.interact(now);
    this.counters[key] = Math.min(1000000, (this.counters[key] ?? 0) + count);
  }
  snapshot(now: number): UsageSnapshot {
    this.settle(now);
    return {
      version: 1,
      id: this.id,
      seq: ++this.seq,
      workspace: this.workspace,
      ...Object.fromEntries(Object.entries(this.totals).map(([k, v]) => [k, Math.round(v)])),
      pages: Object.fromEntries(Object.entries(this.pages).map(([k, v]) => [k, Math.floor(v)])),
      counters: { ...this.counters },
    } as UsageSnapshot;
  }
}

type State = { page: string; playing: boolean; recording: boolean };
let collector: { count(key: string, n?: number): void; state(value: State): void } | undefined;
export const usage = {
  control(button: string, page?: string) {
    collector?.count(`control:${button}:${page ?? current.page}`);
  },
  feature(name: string, n = 1) {
    collector?.count(`feature:${name}`, n);
  },
  machine(name: string) {
    collector?.count(`machine:${name}`);
  },
  state(page: string, playing: boolean, recording: boolean) {
    collector?.state({ page, playing, recording });
  },
};
let current: State = { page: "boot", playing: false, recording: false };
const preference = "xmp-usage-opt-out";
export function installUsageAnalytics(workspace: "device" | "studio") {
  const endpoint = `${import.meta.env.BASE_URL}api/analytics/collect`;
  let session: UsageSession | undefined;
  let optedOut = false;
  try {
    optedOut = localStorage.getItem(preference) === "1";
  } catch {
    /* Storage may be disabled. */
  }
  const privateSignal =
    navigator.doNotTrack === "1" ||
    (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl === true;
  const allowed = () => !optedOut && !privateSignal;
  const clock = () => performance.now();
  const sync = () =>
    session?.state(
      clock(),
      current.page,
      current.playing,
      current.recording,
      document.visibilityState === "visible",
    );
  const flush = (beacon = false) => {
    if (!session || !allowed()) return;
    sync();
    const body = JSON.stringify(session.snapshot(clock()));
    if (beacon && navigator.sendBeacon?.(endpoint, new Blob([body], { type: "application/json" })))
      return;
    void fetch(endpoint, {
      method: "POST",
      body,
      headers: { "Content-Type": "application/json" },
      credentials: "omit",
      keepalive: true,
    }).catch(() => {});
  };
  const ensure = () => {
    if (!allowed()) return;
    if (session?.expired(clock())) {
      flush();
      session = undefined;
    }
    if (!session) {
      session = new UsageSession(workspace, crypto.randomUUID(), clock());
      sync();
    }
  };
  collector = {
    count(key, n) {
      ensure();
      session?.count(clock(), key, n);
    },
    state(value) {
      sync();
      current = value;
      sync();
    },
  };
  const activity = () => {
    ensure();
    session?.interact(clock());
  };
  document.addEventListener("pointerdown", activity, { passive: true });
  // Keys indicate activity only. Their values and text input are never read.
  document.addEventListener("keydown", activity, { passive: true });
  document.addEventListener("visibilitychange", () => {
    sync();
    if (document.visibilityState === "hidden") flush(true);
  });
  window.addEventListener("pagehide", () => flush(true));
  window.addEventListener("pageshow", () => sync());
  window.addEventListener("storage", (e) => {
    if (e.key === preference) {
      optedOut = e.newValue === "1";
      if (optedOut) session = undefined;
      else ensure();
      drawPreference();
    }
  });
  window.setInterval(() => {
    if (session?.expired(clock())) {
      flush();
      session = undefined;
      if (current.playing || current.recording) ensure();
    } else flush();
  }, 30000);
  ensure();
  flush();
  const notice = document.createElement("details");
  notice.className = "usage-notice";
  notice.innerHTML =
    '<summary>Usage analytics</summary><p>Anonymous session time, screens, feature actions and control counts help improve XMP. No song content, audio, names or typed text is included. No tracking cookies or persistent visitor IDs. Reports are retained for 90 days.</p><button type="button"></button>';
  const toggle = notice.querySelector("button");
  const drawPreference = () => {
    if (toggle) {
      toggle.textContent = privateSignal
        ? "Off · browser privacy preference"
        : optedOut
          ? "Enable usage analytics"
          : "Turn off usage analytics";
      toggle.disabled = privateSignal;
    }
  };
  toggle?.addEventListener("click", () => {
    optedOut = !optedOut;
    try {
      localStorage.setItem(preference, optedOut ? "1" : "0");
    } catch {
      /* In-memory choice still works. */
    }
    session = undefined;
    if (!optedOut) {
      ensure();
      flush();
    }
    drawPreference();
  });
  drawPreference();
  document.body.append(notice);
  document.addEventListener(
    "click",
    (e) => {
      const anchor = e.target instanceof Element ? e.target.closest("a") : null;
      if (!anchor) return;
      const url = new URL(anchor.href, location.href);
      if (url.origin !== location.origin) return;
      if (url.pathname.endsWith("/manual/")) usage.control("manual");
      else if (url.searchParams.get("view") === "studio") usage.control("studio");
    },
    true,
  );
  // Advanced Studio's DOM controls have fixed identifiers; ignore unknown IDs,
  // labels, form values and dynamically named project/library elements.
  if (workspace === "studio")
    document.addEventListener(
      "click",
      (e) => {
        const element =
          e.target instanceof Element ? e.target.closest<HTMLElement>("button,[data-view]") : null;
        if (element) {
          usage.control(
            element.dataset.view ? `view-${element.dataset.view}` : element.id,
            "studio",
          );
          const features: Record<string, string> = {
            play: "play_scene",
            stop: "stop",
            undo: "undo",
            redo: "redo",
            panic: "panic",
            "kit-load": "browse_assign",
            "kit-import": "library_import",
            "arm-record": "sample_arm",
            "start-record": "record_start",
            "keep-take": "sample_keep",
            "manual-slices": "sample_chop",
            "chop-drum-kit": "sample_chop",
            "perf-queue-clip": "launch_clip",
            "perf-stop-track": "stop_clip",
            "perf-play-song": "play_song",
            "perf-add-occurrence": "song_add",
            save: "project_save",
          };
          if (features[element.id]) usage.feature(features[element.id] ?? "");
        }
      },
      true,
    );
  if (workspace === "studio")
    document.addEventListener(
      "change",
      (e) => {
        if (!(e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement))
          return;
        usage.control(e.target.id, "studio");
        if (e.target.id === "machine-type") {
          usage.feature("choose_machine");
          const machines: Record<string, string> = {
            "xmp.sampler": "sampler",
            "xmp.subtractive": "synth",
            "xmp.midi": "midi",
          };
          usage.machine(machines[e.target.value] ?? "other");
        }
        if (e.target.id === "synth-preset") usage.feature("choose_preset");
      },
      true,
    );
}
