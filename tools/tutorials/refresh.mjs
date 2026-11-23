// Live recordings of the production C++ touchscreen, running as WebAssembly.
// No hardware adapters or device permissions. Every illustrated hardware
// highlight is derived from the input being delivered to the real host UI.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { createServer } from "vite";
import { DEVICE_UI_SOURCE_SHA256 } from "../../packages/core/src/generated/xmp-device-ui-wasm.ts";
import { checkLessonProject } from "./check-lesson-project.mjs";
import { verifyNarration } from "./narration-plan.mjs";
import { padCourse } from "./pad-course.mjs";
import { teachingFrame } from "./video-authoring.mjs";

const root = resolve(import.meta.dirname, "../..");
const verifyOnly = process.argv.includes("--verify");
const work = resolve(root, "artifacts/tutorial-refresh", verifyOnly ? "validation" : ".");
const out = resolve(work, "drafts");
let server;
if (!process.env.XMP_TUTORIAL_ORIGIN) {
  server = await createServer({ server: { host: "127.0.0.1", port: 0, open: false, hmr: false } });
  await server.listen();
}
const origin =
  process.env.XMP_TUTORIAL_ORIGIN ?? `http://127.0.0.1:${server.httpServer.address().port}`;
assert.equal(new URL(origin).hostname, "127.0.0.1");
const maximum = Number(
  process.argv.find((a) => a.startsWith("--through="))?.split("=")[1] ?? padCourse.length,
);
const first = Number(process.argv.find((a) => a.startsWith("--from="))?.split("=")[1] ?? 1);
assert.ok(first >= 1 && first <= maximum);
await mkdir(out, { recursive: true });
const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const browser = await chromium.launch({
  args: ["--mute-audio", "--disable-audio-output", "--autoplay-policy=no-user-gesture-required"],
});
const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  ...(verifyOnly
    ? {}
    : { recordVideo: { dir: `${work}/raw`, size: { width: 1920, height: 1080 } } }),
  permissions: [],
  acceptDownloads: true,
});
await context.route("**/*", (route) =>
  route.request().url().startsWith(origin) ? route.continue() : route.abort(),
);
await context.addInitScript(() => {
  // Duplicate the app's actual output into a browser recording stream. This
  // captures its production PCM; it does not replace the engine or inputs.
  const original = AudioNode.prototype.connect;
  const recording = { chunks: [], recorder: null, startedAt: 0 };
  window.__xmpTutorialAudio = recording;
  AudioNode.prototype.connect = function (destination, ...rest) {
    const result = original.call(this, destination, ...rest);
    if (destination === this.context.destination) {
      if (!this.context.__tutorialDestination) {
        const output = this.context.createMediaStreamDestination();
        this.context.__tutorialDestination = output;
        const recorder = new MediaRecorder(output.stream, { mimeType: "audio/webm;codecs=opus" });
        recorder.ondataavailable = (e) => {
          if (e.data.size) recording.chunks.push(e.data);
        };
        recording.recorder = recorder;
        recording.startedAt = Date.now();
        recorder.start();
      }
      original.call(this, this.context.__tutorialDestination);
    }
    return result;
  };
});
const manifest = {
  sourceRevision,
  screenSourceSha256: DEVICE_UI_SOURCE_SHA256,
  screenImplementation: "native/include/xmp/live_ui.hpp via WebAssembly",
  hardwareUsed: false,
  narration: "ElevenLabs owner-authorized voice clone; readiness recorded per lesson",
  lessons: [],
};
const sha = (b) => createHash("sha256").update(b).digest("hex");
const wait = (page, ms) => page.waitForTimeout(ms);
try {
  if (first === 1) {
    // The course builds a song from scratch. Choose New Project explicitly,
    // just as the quick start directs, independently of the web starter song.
    const seed = await context.newPage();
    await seed.goto(origin);
    await seed.locator("#boot-screen").waitFor({ state: "detached" });
    const key = (id) => seed.locator(`[data-panel="${id}"]`).click();
    const pad = (n) => seed.locator(`[data-pad="${n - 1}"]`).click();
    await key("menu");
    await pad(5);
    await pad(13);
    await pad(14);
    await expect(seed.locator("#device-screen")).toHaveAttribute("data-project", "Untitled");
    await key("menu");
    await pad(5);
    await pad(15);
    await expect(seed.locator("#device-screen")).toHaveAttribute("data-message", /Project saved/, {
      timeout: 30000,
    });
    await seed.close();
  }
  if (first > 1) {
    const previous = JSON.parse(await readFile(`${work}/manifest.json`, "utf8"));
    manifest.lessons = previous.lessons.slice(0, first - 1);
    assert.equal(manifest.lessons.length, first - 1);
    const seed = await context.newPage();
    await seed.goto(origin);
    await seed.locator("canvas.native-touchscreen").waitFor();
    await seed.locator("#boot-screen").waitFor({ state: "detached" });
    await seed.locator("#device-files").setInputFiles({
      name: "checkpoint.xmpsong",
      mimeType: "application/json",
      buffer: await readFile(`${out}/${padCourse[first - 2].id}.xmpsong`),
    });
    const key = (id) => seed.locator(`[data-panel="${id}"]`).click();
    const pad = (n) => seed.locator(`[data-pad="${n - 1}"]`).click();
    await key("menu");
    await pad(5);
    await pad(14);
    await pad(13);
    await seed.locator('[data-wheel="0"]').click();
    await wait(seed, 300);
    await key("menu");
    await pad(5);
    await pad(15);
    await wait(seed, 800);
    await seed.close();
  }
  for (const lesson of padCourse.slice(first - 1, maximum)) {
    console.log(`Recording ${lesson.id}`);
    const openedAt = Date.now();
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(origin);
    await page.locator("canvas.native-touchscreen").waitFor();
    await page.locator("#boot-screen").waitFor({ state: "detached" });
    if (lesson.libraryFile) {
      await page.locator("#device-files").setInputFiles({
        name: lesson.libraryName,
        mimeType: "audio/wav",
        buffer: await readFile(resolve(root, "apps/studio/public", lesson.libraryFile)),
      });
      await expect(page.locator("#device-host-state")).toContainText("files added to Browse", {
        timeout: 30000,
      });
    }
    const compatibilityLesson = {
      ...lesson,
      mode: "Shared native UI · host capture",
      steps: lesson.steps.map((s) => [s.title, s.caption]),
    };
    await page.evaluate(
      (html) => {
        const parsed = new DOMParser().parseFromString(html, "text/html");
        for (const style of parsed.querySelectorAll("style"))
          document.head.append(style.cloneNode(true));
        const holder = document.createElement("div");
        holder.id = "tutorial-root";
        holder.innerHTML = parsed.body.innerHTML;
        const app = document.querySelector("#app");
        app.append(holder);
        const canvas = document.querySelector("canvas.native-touchscreen");
        holder.append(canvas);
        canvas.style.cssText =
          "position:absolute!important;left:438px!important;top:84px!important;width:1152px!important;height:720px!important;max-width:none!important;z-index:2";
        const keys = {
          shift: [499, 765, 98, 54],
          menu: [683, 765, 98, 54],
          main: [943, 765, 98, 54],
          undo: [1073, 765, 98, 54],
          copy: [1203, 765, 98, 54],
          plus: [1387, 765, 98, 54],
          minus: [1387, 840, 98, 54],
          tap: [499, 840, 98, 54],
          rec: [683, 840, 98, 54],
          overdub: [813, 840, 98, 54],
          stop: [943, 840, 98, 54],
          play: [1073, 840, 98, 54],
          "play-start": [1203, 840, 98, 54],
          "q-link": [1646, 44, 180, 50],
        };
        for (let i = 0; i < 4; i++) {
          keys[`bank-${"abcd"[i]}`] = [26 + i * 92, 96, 80, 42];
          keys[["note-repeat", "full-level", "16-level", "erase"][i]] = [26 + i * 92, 177, 80, 60];
        }
        const position = (el, [x, y, w, h]) => {
          holder.append(el);
          el.style.cssText = `position:absolute!important;left:${x + 22}px!important;top:${y + 64}px!important;width:${w}px!important;height:${h}px!important;z-index:5!important;opacity:0!important;margin:0!important;padding:0!important;pointer-events:auto!important`;
        };
        for (const [id, rect] of Object.entries(keys))
          position(document.querySelector(`button[data-panel="${id}"]`), rect);
        for (let n = 1; n <= 16; n++)
          position(document.querySelector(`[data-pad="${n - 1}"]`), [
            26 + ((n - 1) % 4) * 92,
            282 + (3 - Math.floor((n - 1) / 4)) * 92,
            80,
            80,
          ]);
        for (const [n, x] of [
          [-1, 1675],
          [0, 1710],
          [1, 1755],
        ])
          position(document.querySelector(`[data-wheel="${n}"]`), [x, 745, 35, 45]);
        for (let n = 0; n < 4; n++)
          position(document.querySelector(`input[data-q="${n}"]`), [1696, 129 + n * 138, 80, 80]);
        document.querySelector(".device-chassis").style.display = "none";
        document.querySelector(".device-hostbar").style.display = "none";
        // Mirror the host adapter's native-owned LED snapshot, not a guessed transport state.
        const feedback = new Map();
        setInterval(() => {
          for (const control of document.querySelectorAll(
            "button[data-panel][data-led], button[data-pad][data-led]",
          )) {
            const id = control.hasAttribute("data-pad")
              ? `pad-${Number(control.dataset.pad) + 1}`
              : control.dataset.panel;
            const value = control.dataset.led;
            if (feedback.get(id) === value) continue;
            feedback.set(id, value);
            const group = holder.querySelector(`[data-control="${id}"]`);
            if (!group) continue;
            if (id.startsWith("pad-")) {
              group.querySelector("rect").style.fill =
                value !== "0,0,0" ? `rgb(${value})` : "#46464c";
            } else {
              const led = group.querySelector("[data-feedback-light]");
              if (led)
                led.style.fill =
                  value === "on" ? control.style.getPropertyValue("--key-led") : "#55555b";
            }
          }
        }, 33);
        const css = document.createElement("style");
        css.textContent = `html,body{width:1920px!important;height:1080px!important;overflow:hidden!important}#app{padding:0!important;margin:0!important;max-width:none!important}#tutorial-root{position:absolute;inset:0;width:1920px;height:1080px;overflow:hidden}*{cursor:none!important}.caption p{font-size:25px}.tutorial-active rect,.tutorial-active circle{stroke:#E6C779!important;stroke-width:7px!important;filter:drop-shadow(0 0 8px #E6C779)}.tutorial-active text{fill:#fff!important}.tutorial-touch{position:absolute;width:45px;height:45px;border:5px solid #E6C779;border-radius:50%;z-index:10;pointer-events:none;box-shadow:0 0 0 3px #35473E}`;
        document.head.append(css);
      },
      teachingFrame(compatibilityLesson, 0, "", []),
    );
    await page.evaluate(() => document.fonts.ready);
    const voicePath = `${work}/voice/${lesson.id}.json`;
    const timing = existsSync(voicePath)
      ? JSON.parse(await readFile(voicePath, "utf8"))
      : undefined;
    if (!verifyOnly) verifyNarration(lesson, timing);
    const narrationReady =
      Boolean(timing) &&
      lesson.steps.every((_, i) => existsSync(`${work}/voice/${lesson.id}-${i + 1}.wav`));
    const startedAt = Date.now();
    const highlights = [];
    const states = [];
    const show = async (controls, label) => {
      await page.evaluate(
        ({ controls, label }) => {
          for (const el of document.querySelectorAll("[data-control]"))
            el.classList.toggle(
              "tutorial-active",
              controls.includes(el.getAttribute("data-control")),
            );
          const action = document.querySelector(".device foreignObject div");
          if (action) action.textContent = label;
        },
        { controls, label },
      );
      highlights.push({ at: (Date.now() - startedAt) / 1000, controls, label });
    };
    const key = async (id) => {
      await page.locator(`button[data-panel="${id}"]`).click();
    };
    const pad = async (n) => {
      await page.locator(`[data-pad="${n - 1}"]`).click({ delay: verifyOnly ? 0 : 120 });
    };
    const perform = async (a) => {
      const compound = ["shift-pad", "shift-key", "menu-pad", "task-pad"].includes(a.type);
      const controls =
        a.type === "key"
          ? [a.id]
          : a.type === "pad"
            ? [`pad-${a.n}`]
            : a.type === "shift-pad"
              ? ["shift", `pad-${a.n}`]
              : a.type === "shift-key"
                ? ["shift", a.id]
                : a.type === "menu-pad"
                  ? ["menu", `pad-${a.n}`]
                  : a.type === "task-pad"
                    ? ["shift", "menu", `pad-${a.n}`]
                    : a.type === "knob"
                      ? [`q${a.n}`]
                      : a.type === "dial"
                        ? ["dial"]
                        : [];
      if (a.type === "wait") return wait(page, a.seconds * 1000);
      const label =
        a.type === "name-character"
          ? `Touch ${a.char}`
          : a.type === "touch"
            ? a.label
            : a.type === "knob"
              ? `Turn Q${a.n}`
              : a.type === "dial"
                ? a.delta
                  ? "Turn DATA DIAL"
                  : "Press DATA DIAL"
                : controls.map((id) => id.toUpperCase().replaceAll("-", " ")).join(" + ");
      await show(controls, label);
      await wait(page, verifyOnly ? 1 : 150);
      if (a.type === "key") await key(a.id);
      if (a.type === "pad") await pad(a.n);
      if (a.type === "shift-key" || a.type === "shift-pad") {
        await page.keyboard.down("Shift");
        try {
          if (a.type === "shift-pad") await pad(a.n);
          else await key(a.id);
          // The browser latches MENU. A short SHIFT+MENU gesture opens Browse
          // on release; leaving it held exposes contextual task pads instead.
          if (a.type === "shift-key" && a.id === "menu") await key("menu");
        } finally {
          await page.keyboard.up("Shift");
        }
      }
      if (a.type === "menu-pad") {
        await key("menu");
        await wait(page, verifyOnly ? 1 : 150);
        await pad(a.n);
      }
      if (a.type === "task-pad") {
        await key("shift");
        await key("menu");
        await pad(a.n);
      }
      if (a.type === "dial") {
        const d = Math.sign(a.delta);
        for (let i = 0; i < Math.max(1, Math.abs(a.delta)); i++)
          await page.locator(`[data-wheel="${d}"]`).click();
      }
      if (a.type === "knob") {
        await page.locator(`[data-q="${a.n - 1}"]`).evaluate((el, delta) => {
          el.value = String(delta);
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }, a.delta);
      }
      if (a.type === "name-character") {
        const index = "1234567890QWERTYUIOPASDFGHJKLZXCVBNM-_ ".indexOf(a.char);
        assert.ok(index >= 0);
        const row = index < 20 ? Math.floor(index / 10) : index < 29 ? 2 : 3;
        const column = index < 20 ? index % 10 : index < 29 ? index - 20 : index - 29;
        const columns = row === 2 ? 9 : row === 3 ? 11 : 10;
        const full = 1102;
        a = { ...a, x: 24 + ((column + 0.5) * full) / columns - 5, y: 210 + row * 104 + 47 };
      }
      if (a.type === "touch" || a.type === "name-character") {
        await page.evaluate(({ x, y }) => {
          const el = document.createElement("div");
          el.className = "tutorial-touch";
          el.style.left = `${438 + x * 0.9 - 22}px`;
          el.style.top = `${84 + y * 0.9 - 22}px`;
          document.querySelector("#tutorial-root").append(el);
        }, a);
        await page.locator("#device-screen").click({ position: { x: a.x * 0.9, y: a.y * 0.9 } });
      }
      await wait(page, verifyOnly ? 75 : compound ? 550 : 400);
      await page.locator(".tutorial-touch").evaluateAll((els) => {
        for (const el of els) el.remove();
      });
      await page.locator(".tutorial-active").evaluateAll((els) => {
        for (const el of els) el.classList.remove("tutorial-active");
      });
      highlights.at(-1).end = (Date.now() - startedAt) / 1000;
      const status = await page
        .locator("#device-screen")
        .evaluate((el) => ({ page: el.dataset.page, message: el.dataset.message }));
      states.push({ at: (Date.now() - startedAt) / 1000, action: a, ...status });
    };
    const steps = [];
    for (const [index, step] of lesson.steps.entries()) {
      const begin = (Date.now() - startedAt) / 1000;
      await page.evaluate(
        ({ step, index }) => {
          document.querySelector(".caption b").textContent = `${index + 1}. ${step.title}`;
          document.querySelector(".caption p").textContent = step.caption;
          document.querySelector("header span").textContent =
            `Shared native UI · host capture · ${index + 1}/6`;
          document.querySelector(".progress").style.width = `${((index + 1) / 6) * 100}%`;
        },
        { step, index },
      );
      for (const a of step.actions) await perform(a);
      const wanted =
        verifyOnly && lesson.id !== "09-record"
          ? 0
          : (timing?.stepDurations?.[index] ??
            Math.max(3.8, step.speech.split(/\s+/).length / 2.75 + 0.18));
      const spent = (Date.now() - startedAt) / 1000 - begin;
      await wait(page, Math.max(80, (wanted - spent) * 1000));
      steps.push({
        start: begin,
        end: (Date.now() - startedAt) / 1000,
        title: step.title,
        caption: step.caption,
        speech: step.speech,
      });
      if (index === 0 && !verifyOnly)
        await page.screenshot({ path: `${out}/${lesson.id}.jpg`, type: "jpeg", quality: 90 });
    }
    if (lesson.id === "09-record") {
      // Inspect the rendered roll, not just the saved file: the learner must see notes.
      const notePixels = await page.locator("#device-screen").evaluate((canvas) => {
        const pixels = canvas.getContext("2d").getImageData(104, 170, 1022, 352).data;
        let gold = 0;
        for (let i = 0; i < pixels.length; i += 4)
          if (
            pixels[i] > 140 &&
            pixels[i + 1] > 90 &&
            pixels[i + 2] < 130 &&
            pixels[i] > pixels[i + 1] * 1.02
          )
            gold++;
        return gold;
      });
      assert.ok(notePixels > 100, "The take editor must show the recorded notes, not an empty bar");
    }
    const duration = (Date.now() - startedAt) / 1000;
    assert.ok(duration < 60, `${lesson.id} exceeds one minute: ${duration}`);
    assert.deepEqual(errors, [], "The production UI reported a page error");
    const sound = await page.evaluate(async () => {
      const r = window.__xmpTutorialAudio;
      if (!r.recorder) return undefined;
      await new Promise((ok) => {
        r.recorder.onstop = ok;
        r.recorder.stop();
      });
      const bytes = new Uint8Array(await new Blob(r.chunks, { type: "audio/webm" }).arrayBuffer());
      let value = "";
      for (let i = 0; i < bytes.length; i += 8192)
        value += String.fromCharCode(...bytes.subarray(i, i + 8192));
      return { base64: btoa(value), startedAt: r.startedAt };
    });
    const audioFile = `${work}/raw/${lesson.id}-music.webm`;
    if (sound && !verifyOnly) await writeFile(audioFile, Buffer.from(sound.base64, "base64"));
    // Exercise the host's real saved-project download, rather than reading
    // private application memory, and retain compact musical evidence.
    await key("stop");
    await key("menu");
    await pad(5);
    await pad(15);
    // The portable write is asynchronous; a fixed delay can download the
    // previous edit on a cold or busy host, especially after slicing a loop.
    await expect(page.locator("#device-screen")).toHaveAttribute("data-message", /Project saved/, {
      timeout: 30000,
    });
    await key("main");
    const pendingDownload = page.waitForEvent("download");
    await page.locator('[data-host="download"]').dispatchEvent("click");
    const downloaded = await pendingDownload;
    const portable = JSON.parse(await readFile(await downloaded.path(), "utf8"));
    await writeFile(`${out}/${lesson.id}.xmpsong`, JSON.stringify(portable));
    const project = portable.project ?? portable;
    checkLessonProject(lesson.id, project, portable.assets);
    assert.ok(
      !states.some((s) => /No matching library items|This project has no song/.test(s.message)),
      `${lesson.id}: the demonstrated action was rejected`,
    );
    if (lesson.id === "12-save-export") {
      assert.ok(states.some((s) => /Saved GROOVE/.test(s.message)));
      assert.ok(states.some((s) => /Loaded/.test(s.message)));
    }
    const projectFacts = {
      name: project.name,
      tracks: project.tracks.map((t) => ({
        id: t.id,
        machine: t.machine?.id,
        machineState: t.machine,
        mixer: t.mixer,
        kit: t.kit,
        clips: t.clips.map((c) => ({ id: c.id, steps: c.steps })),
      })),
      scenes: project.scenes,
      chain: project.song ?? project.performance?.chain,
      samples: project.samples?.map(({ id, name }) => ({ id, name })),
    };
    await writeFile(`${out}/${lesson.id}-project.json`, JSON.stringify(projectFacts, null, 2));
    if (lesson.id === "02-first-beat") {
      const clip = project.tracks[0].clips[0];
      assert.deepEqual(
        clip.steps
          .filter((n) => n.pad === 0)
          .map((n) => n.step)
          .sort((a, b) => a - b),
        [0, 4, 8, 12],
      );
      assert.deepEqual(
        clip.steps
          .filter((n) => n.pad === 1)
          .map((n) => n.step)
          .sort((a, b) => a - b),
        [4, 12],
      );
    }
    await page.locator(".tutorial-active").evaluateAll((els) => {
      for (const el of els) el.classList.remove("tutorial-active");
    });
    await wait(page, 300);
    const video = page.video();
    await page.close();
    if (verifyOnly) {
      manifest.lessons.push({ id: lesson.id, states, projectVerified: true });
      await writeFile(`${work}/manifest.json`, JSON.stringify(manifest, null, 2));
      console.log(`Validated ${lesson.id}`);
      continue;
    }
    const raw = `${work}/raw/${lesson.id}.webm`;
    await video.saveAs(raw);
    const temporaryVideo = await video.path();
    if (temporaryVideo !== raw) await unlink(temporaryVideo);
    const trimStart = (startedAt - openedAt) / 1000;
    const target = `${out}/${lesson.id}.mp4`;
    const encode = ["-y", "-v", "error", "-ss", String(Math.max(0, trimStart - 0.15)), "-i", raw];
    let inputCount = 1;
    const audioInputs = [];
    if (sound) {
      encode.push("-itsoffset", String((sound.startedAt - startedAt) / 1000), "-i", audioFile);
      audioInputs.push(`[${inputCount++}:a]volume=${narrationReady ? 0.32 : 1}[music]`);
    }
    const mixLabels = sound ? ["[music]"] : [];
    if (narrationReady) {
      for (const [i, step] of steps.entries()) {
        encode.push("-i", `${work}/voice/${lesson.id}-${i + 1}.wav`);
        audioInputs.push(
          `[${inputCount++}:a]loudnorm=I=-16:TP=-2:LRA=7,adelay=${Math.round(step.start * 1000)}:all=1[voice${i}]`,
        );
        mixLabels.push(`[voice${i}]`);
      }
    }
    if (mixLabels.length) {
      audioInputs.push(
        `${mixLabels.join("")}amix=inputs=${mixLabels.length}:duration=longest:normalize=0,alimiter=limit=0.95,apad[mix]`,
      );
      encode.push(
        "-filter_complex",
        audioInputs.join(";"),
        "-map",
        "0:v",
        "-map",
        "[mix]",
        "-c:a",
        "aac",
        "-b:a",
        "160k",
      );
    } else encode.push("-an");
    encode.push(
      "-t",
      String(duration),
      "-c:v",
      "libx264",
      "-threads",
      "2",
      "-preset",
      "veryfast",
      "-crf",
      "22",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      target,
    );
    execFileSync("ffmpeg", encode);
    const info = {
      id: lesson.id,
      title: lesson.title,
      duration,
      steps,
      highlights,
      states,
      sourceRevision,
      screenSourceSha256: DEVICE_UI_SOURCE_SHA256,
      narrationReady,
      narration: narrationReady
        ? { provider: timing.provider, model: timing.model, scriptSha256: timing.scriptSha256 }
        : undefined,
      videoSha256: sha(await readFile(target)),
    };
    await writeFile(`${out}/${lesson.id}.json`, JSON.stringify(info, null, 2));
    manifest.lessons.push(info);
    await writeFile(`${work}/manifest.json`, JSON.stringify(manifest, null, 2));
    console.log(
      `${lesson.id}: ${duration.toFixed(1)}s, ${highlights.length} highlighted input actions`,
    );
  }
} finally {
  await context.close();
  await browser.close();
  await server?.close();
}
