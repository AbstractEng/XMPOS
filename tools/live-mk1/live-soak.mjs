import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { verifyTemplate } from "./assemble-image.mjs";
import { bridgeCommand, openBridge, readToken } from "./bridge.mjs";
import { MPC_RUNTIME } from "./compatibility.mjs";
import { sha256File } from "./container.mjs";

export const DSP_BUDGET_MS = (256 / 48000) * 1000;
const PEAK_LIMIT = 10 ** (-12 / 20);
export function stoppingSoakFaults(faults, diagnosticOnly = false) {
  // Diagnostic collection never qualifies as a pass. Only the already-found
  // scheduling issue may be observed further; all other stops stay intact.
  return faults.filter((fault) => !diagnosticOnly || fault !== "New late scheduled note");
}
export function soakFaults(reply, baseline, expected, previousBlocks, playing = true) {
  const s = reply?.session,
    faults = [];
  if (!reply?.ok || !s) return ["Session status unavailable"];
  for (const field of ["audio", "controller", "screen", "touch", "project"])
    if (s[field] !== true) faults.push(`${field} unavailable`);
  if (s.recording !== false) faults.push("Unexpected recording state");
  if (playing && s.playing !== true) faults.push("Playback stopped unexpectedly");
  for (const field of [
    "blocks",
    "xruns",
    "peak",
    "audioLoad",
    "audioWorstMs",
    "lateNotes",
    "lateWorstMs",
    "stepWorstMs",
  ])
    if (typeof s[field] !== "number" || !Number.isFinite(s[field]) || s[field] < 0)
      faults.push(`Invalid metric: ${field}`);
  if (s.xruns > baseline.xruns) faults.push("New driver xrun");
  if (s.lateNotes > baseline.lateNotes) faults.push("New late scheduled note");
  if (s.peak > PEAK_LIMIT + 0.00001) faults.push("Output exceeds -12 dBFS");
  if (s.audioWorstMs > DSP_BUDGET_MS + 0.005)
    faults.push("DSP processing exceeds the 256-frame / 48 kHz budget");
  if (previousBlocks !== null && s.blocks <= previousBlocks)
    faults.push("Audio block counter stalled or reset");
  for (const [key, value] of Object.entries(expected))
    if (reply.image?.[key] !== value) faults.push(`Candidate fingerprint changed: ${key}`);
  return faults;
}

export function soakHours(value) {
  if (!["number", "string"].includes(typeof value))
    throw new Error("Numeric soak duration required");
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours < 1 / 60 || hours > 12)
    throw new Error("Soak duration must be between one minute and twelve hours");
  return hours;
}
const sleep = (ms) => new Promise((done) => setTimeout(done, Math.min(60000, Math.max(0, ms))));
const errorLines = (text) =>
  text
    .split("\n")
    .filter(
      (line) =>
        !/sample: cannot open/.test(line) &&
        /\b(error|refused|not saved|cannot|queue full|dropped)\b/i.test(line),
    );

export async function runLiveSoak({
  hours,
  templateDirectory,
  ownerDirectory,
  out,
  diagnosticOnly = false,
}) {
  hours = soakHours(hours);
  await mkdir(out, { recursive: false, mode: 0o700 });
  const reserve = join(out, ".stop-log-reserve");
  await writeFile(reserve, Buffer.alloc(2 * 1024 ** 2, 0x5b), { flag: "wx", mode: 0o600 });
  const report = {
    format: "xmp-live-playback-soak",
    version: 1,
    state: "preflight",
    passed: false,
    diagnosticOnly,
    requestedHours: hours,
    startedAt: null,
    finishedAt: null,
    elapsedSeconds: 0,
    samples: 0,
    faults: [],
    peak: 0,
    dspWorstMs: 0,
    stepWorstMs: 0,
    xrunsAdded: 0,
    lateNotesAdded: 0,
    inputSampling: false,
    memoryMeasured: false,
    temperatureMeasured: false,
    callbackP99Measured: false,
    physicalLatencyMeasured: false,
    projectEdited: false,
    stockInstallRecoveryTested: false,
    stopConfirmed: false,
    workload:
      "Existing original Night Shift project: six tracks, five scenes; repeat current scene with read-only UI navigation. Active voices/maximum capacity not measured.",
    units: {
      audioLoad: "cumulative mean DSP processing fraction",
      audioWorstMs: "cumulative worst DSP processing; excludes ALSA write/preview/limiting",
      peak: "cumulative post-limiter linear peak",
    },
  };
  const save = async () =>
    writeFile(join(out, "result.json"), `${JSON.stringify(report, null, 2)}\n`);
  const template = await verifyTemplate(templateDirectory);
  const owner = JSON.parse(await readFile(join(ownerDirectory, "manifest.json"), "utf8"));
  if (
    owner.format !== "xmp-live-mk1-owner-session-image" ||
    owner.template?.imageSha256 !== template.image.sha256 ||
    owner.sourceHash !== template.manifest.sourceHash ||
    (await sha256File(join(ownerDirectory, "system.img"))) !== owner.files?.["system.img"]?.sha256
  )
    throw new Error("Matching owner image/template required");
  report.sourceHash = owner.sourceHash;
  report.ownerImageSha256 = owner.files["system.img"].sha256;
  report.publicTemplateSha256 = template.image.sha256;
  const expected = {
    sessionSha256: template.manifest.files["session-image"].sha256,
    bridgeSha256: template.manifest.files["xmp-bridge"].sha256,
    libcSha256: MPC_RUNTIME.files.find((file) => file.destination === "lib/libc.so.6").sha256,
  };
  let bridge,
    started = false,
    interrupted = false,
    began = 0;
  const interrupt = () => {
    interrupted = true;
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  const command = async (name, args = []) => {
    const result = await bridgeCommand(bridge, name, args, out);
    if (!result.ok)
      throw new Error(`Bridge refused ${name}: ${result.error ?? result.reply ?? "unknown"}`);
    return result;
  };
  const input = (line) => command("input", line.split(" "));
  const capture = async (label) => {
    const path = join(out, `${label}.wav`);
    await command("record", ["2", path]);
    const wav = await readFile(path);
    let peak = 0;
    const data = wav.indexOf(Buffer.from("data"));
    if (data < 0 || data + 8 >= wav.length) throw new Error("Invalid output-tap capture");
    for (let at = data + 8; at + 1 < wav.length; at += 2)
      peak = Math.max(peak, Math.abs(wav.readInt16LE(at)) / 32768);
    if (peak < 0.001 || peak > PEAK_LIMIT + 1 / 32768)
      throw new Error("Output capture is silent or exceeds -12 dBFS");
    return { file: `${label}.wav`, peak, peakDbfs: 20 * Math.log10(peak) };
  };
  try {
    await save();
    bridge = await openBridge({ token: readToken(), log: join(out, "bridge.log") });
    const initial = await command("status"),
      baseline = initial.session;
    const faults = soakFaults(initial, baseline, expected, null, false);
    if (faults.length) throw new Error(faults.join("; "));
    const log = await command("log");
    if (!/project: .*"Night Shift", 6 tracks, 5 scenes/.test(log.text ?? ""))
      throw new Error(
        "Expected original Night Shift workload is not established by the session log",
      );
    if (errorLines(log.text ?? "").length) throw new Error("Session has errors before soak");
    report.audioConfiguration =
      (log.text ?? "")
        .split("\n")
        .find((line) => /audio: .* open, period/.test(line))
        ?.trim() ?? "Not exposed";
    report.baseline = baseline;
    await input("button 51");
    await input("button 34");
    started = true;
    await input("button 53");
    began = performance.now();
    report.startedAt = new Date().toISOString();
    report.expectedEndAt = new Date(Date.now() + hours * 3600000).toISOString();
    report.pid = process.pid;
    report.state = "running";
    report.captures = [await capture("start")];
    await command("screenshot", [join(out, "start.png")]);
    await save();
    console.log(
      JSON.stringify({
        state: report.state,
        startedAt: report.startedAt,
        expectedEndAt: report.expectedEndAt,
        out,
      }),
    );
    let previousBlocks = baseline.blocks,
      previousLate = baseline.lateNotes,
      previousTime = Date.now(),
      nextCapture = 3600000,
      nextLog = 900000;
    const pages = [
      [9, "CLIPS"],
      [11, "MIX"],
      [10, "SONG"],
      [16, "SOUND"],
      [13, "PLAY"],
      [14, "STEPS"],
    ];
    while (performance.now() - began < hours * 3600000) {
      if (interrupted) throw new Error("Soak cancelled by signal");
      const [pad, view] = pages[report.samples % pages.length];
      await input("button 7B down");
      await sleep(200);
      try {
        await input(`pad ${pad} 100`);
        await input(`pad ${pad} 0`);
      } finally {
        await input("button 7B up");
      }
      await sleep(500);
      const current = await command("status"),
        elapsed = performance.now() - began;
      const failures = soakFaults(current, baseline, expected, previousBlocks);
      if (current.session.view !== view)
        failures.push(`UI navigation expected ${view}, saw ${current.session.view}`);
      if (Date.now() - previousTime > 120000) failures.push("Observation gap exceeded two minutes");
      await appendFile(
        join(out, "samples.jsonl"),
        `${JSON.stringify({ observedAt: new Date().toISOString(), elapsedSeconds: elapsed / 1000, session: current.session, newLateNotes: current.session.lateNotes - previousLate, faults: failures })}\n`,
      );
      report.samples++;
      report.elapsedSeconds = elapsed / 1000;
      report.peak = Math.max(report.peak, current.session.peak);
      report.dspWorstMs = Math.max(report.dspWorstMs, current.session.audioWorstMs);
      report.stepWorstMs = Math.max(report.stepWorstMs, current.session.stepWorstMs);
      report.xrunsAdded = current.session.xruns - baseline.xruns;
      report.lateNotesAdded = current.session.lateNotes - baseline.lateNotes;
      for (const finding of failures)
        if (!report.faults.includes(finding)) report.faults.push(finding);
      const stops = stoppingSoakFaults(failures, diagnosticOnly);
      if (stops.length) throw new Error(stops.join("; "));
      previousBlocks = current.session.blocks;
      previousLate = current.session.lateNotes;
      previousTime = Date.now();
      if (elapsed >= nextCapture) {
        report.captures.push(await capture(`hour-${Math.floor(elapsed / 3600000)}`));
        nextCapture += 3600000;
      }
      if (elapsed >= nextLog) {
        const snapshot = await command("log");
        const errors = errorLines(snapshot.text ?? "");
        if (errors.length) throw new Error(errors.slice(0, 5).join("; "));
        nextLog += 900000;
      }
      await save();
      console.log(
        JSON.stringify({
          state: "running",
          hours: Number((elapsed / 3600000).toFixed(3)),
          samples: report.samples,
          peak: report.peak,
          xrunsAdded: report.xrunsAdded,
          lateNotesAdded: report.lateNotesAdded,
          dspWorstMs: report.dspWorstMs,
        }),
      );
      await sleep(Math.min(60000, hours * 3600000 - (performance.now() - began)));
    }
    report.captures.push(await capture("end"));
    const final = await command("status"),
      finalFaults = soakFaults(final, baseline, expected, previousBlocks);
    for (const finding of finalFaults)
      if (!report.faults.includes(finding)) report.faults.push(finding);
    const finalStops = stoppingSoakFaults(finalFaults, diagnosticOnly);
    if (finalStops.length) throw new Error(finalStops.join("; "));
    const logEnd = await command("log");
    if (errorLines(logEnd.text ?? "").length)
      throw new Error("Session log contains errors at the end");
    report.state = diagnosticOnly ? "diagnostic-completed" : "completed";
    report.passed = !diagnosticOnly;
  } catch (error) {
    report.state = "failed";
    report.faults.push(error.message);
  } finally {
    await rm(reserve, { force: true });
    if (started && bridge) {
      try {
        await input("button 7B up");
        await input("button 31 up");
        await input("button 51");
        await input("button 34");
        await sleep(500);
        const stopped = await command("status");
        report.stopConfirmed =
          stopped.session.playing === false && stopped.session.recording === false;
        report.finalSession = stopped.session;
      } catch (error) {
        report.faults.push(`Stop unconfirmed: ${error.message}`);
      }
    }
    if (!report.stopConfirmed && started) {
      report.passed = false;
      report.state = "failed";
    }
    if (began) report.elapsedSeconds = (performance.now() - began) / 1000;
    report.finishedAt = new Date().toISOString();
    bridge?.close();
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    await save();
    console.log(
      JSON.stringify({
        state: report.state,
        passed: report.passed,
        elapsedSeconds: report.elapsedSeconds,
        faults: report.faults,
        stopConfirmed: report.stopConfirmed,
        out,
      }),
    );
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [duration, template, owner, output, mode, ...extra] = process.argv.slice(2);
  if (
    !duration ||
    !template ||
    !owner ||
    !output ||
    extra.length ||
    (mode !== undefined && mode !== "diagnostic")
  )
    throw new Error(
      "Usage: node tools/live-mk1/live-soak.mjs <hours> <verified-template> <owner-image-directory> <new-report-directory> [diagnostic]",
    );
  const result = await runLiveSoak({
    hours: duration,
    templateDirectory: resolve(template),
    ownerDirectory: resolve(owner),
    out: resolve(output),
    diagnosticOnly: mode === "diagnostic",
  });
  process.exitCode = result.passed ? 0 : 1;
}
