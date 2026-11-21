import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { root } from "../../acceptance/lib/workspace.mjs";
import { bridgeCommand, openBridge, readToken } from "./bridge.mjs";

// A regression pass on the owner's MPC Live Mk1 over the control bridge
// (AGENTS.md authorization 3): it drives the running XMP session with injected
// buttons, pads and knobs, checks each page through the session's status,
// keeps a screenshot of each, records what the session plays (the bridge's
// record: what is sent to the audio card) and reads the session log.
//
// It makes no edits to the project: it only moves between pages, turns knob
// pages, plays and stops, and plays pads. With --sampling (an output patched
// into an input on the Live) it also records a take in the Sample view and
// discards it; the take never leaves the Live (authorization 7), only the
// session's log line and a screenshot of the page are read.
//
//   node tools/live-mk1/live-regression.mjs [--sampling]

const only = process.argv.includes("--sampling-only");
const sampling = only || process.argv.includes("--sampling");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const out = join(root, "reports/live-mk1", `regression-${stamp}`);
mkdirSync(out, { recursive: true });

const B = {
  menu: "7B",
  shift: "31",
  main: "34",
  play: "52",
  stop: "51",
  playStart: "53",
  rec: "49",
  level16: "28",
  qlink: "00",
  erase: "09",
  wheel: "6F",
  bankA: "23",
  bankB: "24",
};
// One connection for the whole pass (a fresh one per press lost presses);
// every reply is checked.
const link = await openBridge({ token: readToken(), log: join(out, "bridge.log") });
const bridge = async (command, ...args) => {
  try {
    return await bridgeCommand(link, command, args, out);
  } catch (error) {
    return { ok: false, error: error.message };
  }
};
const sleep = (s) => new Promise((ok) => setTimeout(ok, s * 1000));
const lines = [];
let lost = 0;
const input = async (...xs) => {
  for (const x of xs) {
    if (typeof x === "number") {
      await sleep(x);
      continue;
    }
    lines.push(x);
    const reply = await bridge("input", ...x.split(" "));
    if (!reply.ok) lost++, console.log(`input refused: ${x}: ${reply.reply ?? reply.error}`);
    await sleep(0.08);
  }
};
const press = (b) => `button ${b}`;
const hold = (b) => `button ${b} down`;
const release = (b) => `button ${b} up`;
// Menu + a pad (1-16, bottom left 1): the page that pad opens.
const page = async (pad) =>
  input(hold(B.menu), 0.2, `pad ${pad} 100`, `pad ${pad} 0`, 0.2, release(B.menu), 0.6);

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "pass" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
const status = async () => (await bridge("status")).session ?? {};
// A screenshot is 4 MB over the cable (about 45 s): only at a few places.
const shot = async (name) => (await bridge("screenshot", join(out, `${name}.png`))).ok;

// ---- the pass ----
const first = await status();
check(
  "the session runs, with audio, controller, screen and touch",
  first.audio && first.controller && first.screen && first.touch && first.project,
);
const xrunsBefore = Number(first.xruns ?? 0);
if (!only) {
  await input(press(B.stop), press(B.main), 0.5);
  check("Main: Clips", (await status()).view === "CLIPS", (await status()).view);
  await shot("01-clips");

  for (const [pad, view] of [
    [13, "PLAY"],
    [14, "STEPS"],
    [15, "SAMPLE"],
    [16, "SOUND"],
    [9, "CLIPS"],
    [10, "SONG"],
    [11, "MIX"],
    [12, "BROWSE"],
  ]) {
    await page(pad);
    const s = await status();
    check(`Menu + pad ${pad}: ${view}`, s.view === view, s.view);
    if (view === "SOUND") await shot("02-sound");
  }
  await input(press(B.main), 0.4);
  await input(hold(B.menu), 0.2, release(B.menu), 0.4);
  check("a Menu tap stays on the page", (await status()).view === "CLIPS");

  // Knob pages: in Steps, Q-Link cycles STEP, NEW STEPS, TRACK, SOUND.
  await input(press(B.level16), 0.4);
  for (let i = 0; i < 4; i++) {
    await input(press(B.qlink), 0.4);
    const page = (await status()).view;
    if (page !== "STEPS") break;
  }
  check("Q-Link: four presses, still on Steps", (await status()).view === "STEPS");

  // Playing: Play Start on Clips, a bar or two, recorded; Stop.
  await input(press(B.main), 0.3, press(B.playStart), 1.5);
  check("Play Start plays", (await status()).playing === true);
  const rec = await bridge("record", "4", join(out, "04-playing.wav"));
  check("the session's output is recorded", rec.ok, rec.error ?? "");
  if (rec.ok) {
    const wav = readFileSync(join(out, "04-playing.wav"));
    let peak = 0;
    for (let i = 44; i + 1 < wav.length; i += 2)
      peak = Math.max(peak, Math.abs(wav.readInt16LE(i)));
    const dbfs = peak ? 20 * Math.log10(peak / 32768) : -Infinity;
    check("there is sound", peak > 30, `${dbfs.toFixed(1)} dBFS peak`);
    check("the peak stays within -12 dBFS", dbfs <= -12 + 0.01, `${dbfs.toFixed(1)} dBFS`);
  }
  await shot("05-playing");
  await input(press(B.stop), 0.6);
  check("Stop stops", (await status()).playing === false);

  // Pads in the Play view on the kit track (track 1).
  await input(press(B.bankA), hold(B.shift), press(B.main), release(B.shift), 0.4);
  const playView = (await status()).view;
  check("Shift + Main: Play", playView === "PLAY", playView);
  if (playView === "PLAY")
    for (const p of [1, 2, 3, 5]) await input(`pad ${p} 100`, 0.15, `pad ${p} 0`, 0.15);
}
if (sampling) {
  // Sample view: REC arms; pads on the Play view play into the patched input; REC ends it.
  await page(15);
  await input(press(B.rec), 0.5, hold(B.shift), press(B.main), release(B.shift), 0.3);
  // Pads only on the Play view (anywhere else they would edit steps).
  const onPlay = (await status()).view === "PLAY";
  check("sampling: armed, then the Play view", onPlay);
  if (onPlay) for (const p of [1, 2, 1, 2]) await input(`pad ${p} 110`, 0.25, `pad ${p} 0`, 0.25);
  await page(15);
  await input(press(B.rec), 1.0);
  await shot("07-sample-take");
  // Discarded, so the project is unchanged: Erase held + the wheel's press.
  await input(hold(B.erase), press(B.wheel), release(B.erase), 0.5);
}

await input(press(B.main), 0.5);
// ---- the log ----
const log = await bridge("log");
const text = log.ok ? String(log.text ?? "") : "";
writeFileSync(join(out, "session-log.txt"), text);
const end = await status();
check("every press reached the session", lost === 0, `${lost} refused`);
check("no new xruns", Number(end.xruns ?? 0) === xrunsBefore, `${end.xruns} (was ${xrunsBefore})`);
check(
  "no errors in the session log",
  !/\b(error|refused|not saved|cannot)\b/i.test(
    text
      .split("\n")
      .filter((l) => !/sample: cannot open/.test(l))
      .join("\n"),
  ),
);
if (sampling) {
  const take = /sample: a take of (\d+) frames/.exec(text);
  check(
    "sampling: a take came in through the inputs",
    !!take,
    take ? `${take[1]} frames` : "no take line",
  );
  check("sampling: the take was discarded", /sample: take discarded/.test(text));
}
writeFileSync(
  join(out, "results.json"),
  `${JSON.stringify({ sampling, results, inputs: lines }, null, 2)}\n`,
);
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} passed; evidence in ${out}`);
link.close();
process.exitCode = failed.length ? 1 : 0;
