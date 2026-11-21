// features/26-machine-pages.feature: machine-specific pages, the Sampler and its
// chopping, the data dial, the Clips layout, clip length and the scale picker,
// in the built Device view. Only the screen, panel and file inputs are used.
import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@playwright/test";
import { DRUM_MACHINE_PADS } from "../../packages/core/src/drum-machines.ts";
import { encodeWav } from "../../packages/core/src/index.ts";
import { synthPresets } from "../../packages/core/src/instrument-schema.ts";
import { navigate, press, projectDownload } from "./production.steps.mjs";

const screen = (page) => page.locator("#device-screen");
const action = (page, id) => page.locator(`[data-action="${id}"]`).click();
const dial = (page, direction, times = 1) =>
  (async () => {
    for (let i = 0; i < times; i++)
      await action(page, direction === "right" ? "dial-right" : "dial-left");
  })();
async function selectTrack(page, n) {
  const bank = `bank-${"abcd"[(n - 1) % 4]}`;
  if (n > 4) await press(page, "shift");
  await press(page, bank);
  await expect(page.locator(".screen-identity")).toContainText(
    n === 1 ? "Drum rack" : `Track ${n}`,
  );
}
async function soundPage(page, n) {
  await selectTrack(page, n);
  await navigate(page, "Sound");
  await expect(page.locator(".screen-content")).toHaveAttribute("data-page", "sound");
}
const machineIds = {
  Kit: "xmp.sampler",
  Synth: "xmp.subtractive",
  Sampler: "melodic-sampler",
  MIDI: "xmp.midi",
};
async function makeMachine(page, n, machine) {
  await soundPage(page, n);
  const id = machineIds[machine];
  if (!(await page.locator(`[data-action="machine:${id}"]`).count()))
    await action(page, "machine-picker");
  await action(page, `machine:${id}`);
  await expect(page.locator(".machine-grid")).toHaveCount(0);
}
// Four decaying hits on a quiet bed, as tests/chop.test.ts: hits at 0.25, 0.7,
// 1.1 and 1.6 s of a two-second take.
function fourHits() {
  let seed = 12345;
  const rnd = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return (seed / 4294967296) * 2 - 1;
  };
  const pcm = new Float32Array(96000);
  for (let i = 0; i < pcm.length; i++) pcm[i] = rnd() * 0.001;
  for (const at of [12000, 33600, 52800, 76800])
    for (let i = 0; i < 6000; i++)
      pcm[at + i] = (pcm[at + i] ?? 0) + rnd() * 0.8 * Math.exp(-i / 1200);
  return Buffer.from(encodeWav([pcm], 48000));
}
const trackOf = (project, n) => project.tracks[n - 1];

// ---- machines and their pages ----
When("I open the Sound page of track {int}", async function (n) {
  await soundPage(this.page, n);
});
Then("it asks me to choose its machine from Kit, Sampler, Synth and MIDI", async function () {
  await expect(screen(this.page)).toContainText("Choose Track 2’s machine");
  for (const name of ["Kit", "Sampler", "Subtractive synth", "MIDI track"])
    await expect(this.page.locator(".machine-grid")).toContainText(name);
});
Then("pads 1 to 4 are labelled Kit, Sampler, Synth and MIDI", async function () {
  for (const [pad, name] of ["Kit", "Sampler", "Synth", "MIDI"].entries())
    await expect(this.page.locator(`.device-pad[data-pad="${pad}"]`)).toContainText(name);
});
When("I press pad {int}", async function (n) {
  await this.page.locator(`.device-pad[data-pad="${n - 1}"]`).click();
});
Then("track 2 becomes a Subtractive synth", async function () {
  await expect(this.page.locator('[data-action="machine-picker"]')).toContainText(
    "Subtractive synth",
  );
});
Then("its Sound page has Presets and Controls tabs", async function () {
  await expect(this.page.locator('[data-action="sound-tab:presets"]')).toBeVisible();
  await expect(this.page.locator('[data-action="sound-tab:controls"]')).toBeVisible();
});
Given(/^track (\d) is a (Kit|Synth|Sampler|MIDI)$/, async function (n, machine) {
  await makeMachine(this.page, Number(n), machine);
});
Given("track {int} is a Subtractive synth", async function (n) {
  await makeMachine(this.page, n, "Synth");
});
Then("the preset pads are shown", async function () {
  await expect(this.page.locator(".preset-pad").first()).toBeVisible();
});
When("I choose the Controls tab", async function () {
  await action(this.page, "sound-tab:controls");
});
Then(
  "the oscillator, tone, resonance, filter envelope, attack, detune and glide controls are shown",
  async function () {
    await expect(this.page.locator("#wb-oscillator")).toBeVisible();
    for (const name of ["Tone", "Resonance", "Filter envelope", "Attack", "Detune", "Glide"])
      await expect(this.page.locator(".sound-controls")).toContainText(name);
  },
);
Then("the top pads play notes instead of choosing presets", async function () {
  await expect(this.page.locator(".preset-pad")).toHaveCount(0);
  const before = await this.page.locator('[data-action="machine-picker"]').textContent();
  await this.page.locator('.device-pad[data-pad="12"]').click();
  await expect(this.page.locator('[data-action="machine-picker"]')).toHaveText(before ?? "");
  await expect(this.page.locator(".preset-pad")).toHaveCount(0);
});
When("I open MENU with track {int} selected", async function (n) {
  await selectTrack(this.page, n);
  await press(this.page, "menu");
});
Then("the Sample page is unavailable and says it is for Kit and Sampler tracks", async function () {
  const sample = this.page.locator('[data-action="page:sample"]');
  await expect(sample).toBeDisabled();
  await expect(sample).toContainText("Kit and Sampler tracks");
  await press(this.page, "menu");
});
Then("the Sample page opens for track 1", async function () {
  await action(this.page, "page:sample");
  await expect(this.page.locator(".screen-content")).toHaveAttribute("data-page", "sample");
});

// ---- the Sampler ----
Given("track 3 is a Sampler with a WAV take of four hits", async function () {
  await makeMachine(this.page, 3, "Sampler");
  await navigate(this.page, "Sample");
  await this.page
    .locator("#device-take-file")
    .setInputFiles({ name: "Four hits.wav", mimeType: "audio/wav", buffer: fourHits() });
  await expect(this.page.locator(".chop-count")).toHaveText("5 slices"); // transients by default
});
When(/^I chop the take by (Transients|Even|By hand)$/, async function (method) {
  const id = { Transients: "transients", Even: "even", "By hand": "hand" }[method];
  await action(this.page, `chop:${id}`);
  if (id === "hand") {
    // Pad 2 picks slice 2; its start moves a little later.
    await this.page.locator('.device-pad[data-pad="1"]').click();
    const field = this.page.locator('[data-value-key="chop:start"]');
    const start = Number(await field.getAttribute("data-value"));
    await field.click();
    await this.page.locator("#value-input").fill(String(start + 480));
    await action(this.page, "value-apply");
    await expect(field).toHaveAttribute("data-value", String(start + 480));
  }
});
When("I keep the slices", async function () {
  await action(this.page, "sample-keep");
  await expect(this.page.locator(".screen-content")).toHaveAttribute("data-page", "sound");
});
async function slicesKept(world, count) {
  await expect(world.page.locator('[data-action="edit-sample"]')).toContainText(
    "Chop or edit sample",
  );
  const { project } = await projectDownload(world);
  const t = trackOf(project, 3);
  assert.equal(t?.machine?.state.mode, "slices");
  const pads = t?.pads ?? [];
  const starts = pads.slice(0, count).map((p) => p.slice?.start);
  assert.equal(starts[0], 0);
  for (let i = 1; i < count; i++)
    assert.ok(starts[i] > starts[i - 1], `slice ${i + 1} after slice ${i}`);
  assert.equal(new Set(pads.slice(0, count).map((p) => p.sampleId)).size, 1);
  assert.equal(pads[count]?.slice, undefined);
  assert.equal(
    pads[count - 1]?.slice?.end,
    project.samples.find((s) => s.id === pads[0]?.sampleId)?.pcm.length,
  );
}
Then(
  "track 3 plays {int} slices of one sample on pads 1 to {int}, in order",
  async function (count, _last) {
    await slicesKept(this, count);
  },
);
Then("its Sound page offers to chop or edit the sample again", async function () {
  await navigate(this.page, "Sound");
  await action(this.page, "edit-sample");
  await expect(this.page.locator(".screen-content")).toHaveAttribute("data-page", "sample");
  await expect(this.page.locator('[data-action="chop:hand"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});
When("I start lazy chop and tap a pad twice as the take plays", async function () {
  await action(this.page, "chop:lazy");
  await action(this.page, "chop-lazy");
  for (const wait of [300, 450]) {
    await this.page.waitForTimeout(wait);
    await this.page.locator('.device-pad[data-pad="0"]').click();
  }
});
When("I stop lazy chop and keep the slices", async function () {
  await action(this.page, "chop-lazy");
  await expect(this.page.locator(".chop-count")).toHaveText("3 slices");
  await action(this.page, "sample-keep");
});
When("I choose Keys and keep the take", async function () {
  await action(this.page, "chop:keys");
  await expect(this.page.locator('[data-action="sample-keep"]')).toHaveText("Keep as keys");
  await action(this.page, "sample-keep");
});
Then("every pad of track 3 plays the whole sample as notes", async function () {
  const { project } = await projectDownload(this);
  const t = trackOf(project, 3);
  assert.equal(t?.machine?.state.mode, "keys");
  assert.ok(t?.pads?.every((p) => p.playback?.mode === "chromatic" && !p.slice));
});

// ---- switching back to Kit, and loading a new kit from Sound ----
const loadKitButton = (page) => screen(page).getByRole("button", { name: "Load kit", exact: true });
async function expectPadLabels(page, names) {
  await expect(screen(page).locator("[data-sound]")).toHaveCount(names.length);
  for (const [pad, name] of names.entries())
    await expect(screen(page).locator(`[data-sound="${pad}"] strong`)).toHaveText(name);
}

When(
  /^I keep the Sampler take as (Keys|Slices) and change the machine to Kit from Sound$/,
  async function (layout) {
    await action(this.page, layout === "Keys" ? "chop:keys" : "chop:even");
    await action(this.page, "sample-keep");
    await expect(this.page.locator('[data-action="edit-sample"]')).toHaveText(
      "Chop or edit sample",
    );
    await expect(loadKitButton(this.page)).toBeHidden();
    await action(this.page, "machine-picker");
    await action(this.page, "machine:xmp.sampler");
  },
);
Then(
  "track 3 has the project's 16 distinct pad sounds and Sound offers Load kit alongside its machine control",
  async function () {
    const { project } = await projectDownload(this);
    const kit = trackOf(project, 3).pads;
    assert.equal(kit.length, 16);
    assert.equal(new Set(kit.map((pad) => pad.sampleId)).size, 16);
    assert.deepEqual(
      kit.map((pad) => pad.sampleId),
      project.pads.map((pad) => pad.sampleId),
    );
    assert.ok(kit.every((pad) => !pad.slice && pad.playback?.mode !== "chromatic"));
    this.beforeKitLoad = project;
    await soundPage(this.page, 3);
    await expect(loadKitButton(this.page)).toBeVisible();
    await expect(screen(this.page).locator('[data-action="machine-picker"]')).toContainText("Kit");
    await expectPadLabels(
      this.page,
      kit.map((pad) => pad.name),
    );
  },
);
When("I load XMP 808 from the Kit Sound page", async function () {
  await loadKitButton(this.page).click();
  await expect(
    screen(this.page).getByRole("button", { name: "Kits", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(screen(this.page).locator(".browse-target")).toContainText("Load kit onto Track 3");
  await action(this.page, "load-kit:xmp-808");
  await expect(this.page.getByRole("status")).toContainText("XMP 808 style loaded");
  await screen(this.page).getByRole("button", { name: "Return to Sound", exact: true }).click();
});
Then(
  "track 3 shows the XMP 808 pad sounds and the other tracks and clips keep their settings",
  async function () {
    await expectPadLabels(this.page, DRUM_MACHINE_PADS["808"]);
    const { project } = await projectDownload(this);
    const kit = trackOf(project, 3).pads;
    assert.deepEqual(
      kit.map((pad) => pad.name),
      [...DRUM_MACHINE_PADS["808"]],
    );
    assert.equal(new Set(kit.map((pad) => pad.sampleId)).size, 16);
    assert.deepEqual(project.pads, this.beforeKitLoad.pads);
    const withoutTargetPads = (song) =>
      song.tracks.map((track, i) => (i === 2 ? { ...track, pads: undefined } : track));
    assert.deepEqual(withoutTargetPads(project), withoutTargetPads(this.beforeKitLoad));
  },
);
Then("track 3 has its previous kit again", async function () {
  await soundPage(this.page, 3);
  await expectPadLabels(
    this.page,
    trackOf(this.beforeKitLoad, 3).pads.map((pad) => pad.name),
  );
  const { project } = await projectDownload(this);
  assert.deepEqual(trackOf(project, 3), trackOf(this.beforeKitLoad, 3));
});

// ---- the data dial ----
When("I open the Mixer and turn the data dial once to the right", async function () {
  await selectTrack(this.page, 1);
  await navigate(this.page, "Mixer");
  await dial(this.page, "right");
});
Then("track 2 is selected", async function () {
  await expect(this.page.locator(".screen-identity")).toContainText("Track 2");
});
When("I open the synth's Controls, turn the data dial twice and press it", async function () {
  await navigate(this.page, "Sound");
  await action(this.page, "sound-tab:controls");
  await dial(this.page, "right", 2);
  await expect(this.page.locator('.sound-controls [data-dial="true"]')).toContainText("Resonance");
  await this.page.getByRole("button", { name: "Press data dial", exact: true }).click();
});
Then("the Resonance editor opens", async function () {
  await expect(this.page.locator("#value-input")).toBeVisible();
  await expect(this.page.locator(".value-dialog")).toContainText("Resonance");
});
When(
  "I cancel it, choose the Presets tab, turn the data dial nine times and press it",
  async function () {
    await action(this.page, "value-cancel");
    await action(this.page, "sound-tab:presets");
    await dial(this.page, "right", 9);
    await this.page.getByRole("button", { name: "Press data dial", exact: true }).click();
  },
);
Then("the tenth preset is chosen on preset page 2", async function () {
  const name = synthPresets[9]?.name ?? "";
  await expect(this.page.locator(".preset-pad.focused")).toContainText(name);
  await expect(this.page.locator(".preset-pad.dial")).toContainText(name);
});

// ---- Clips ----
When("I press MAIN", async function () {
  await press(this.page, "main");
  await expect(this.page.locator(".screen-content")).toHaveAttribute("data-page", "clips");
});
Then("no text line sits above the track names", async function () {
  await expect(this.page.locator(".screen-content .screen-toolbar")).toHaveCount(0);
  const content = await this.page.locator(".screen-content").boundingBox();
  const head = await this.page.locator(".clip-overview > [data-track]").first().boundingBox();
  assert.ok(content && head && head.y - content.y < 40, "the track names start the page");
});
Then("the four rows of clips fill the page down to the status line", async function () {
  const content = await this.page.locator(".screen-content").boundingBox();
  const grid = await this.page.locator(".clip-overview").boundingBox();
  assert.ok(content && grid, "grid on screen");
  assert.ok(
    content.y + content.height - (grid.y + grid.height) < 40,
    "no empty band under the grid",
  );
  const cell = await this.page.locator(".clip-cell").first().boundingBox();
  assert.ok(cell && cell.height > grid.height / 7, "each row takes a quarter of the free height");
});
When("I press the down arrow in the grid's corner", async function () {
  await this.page.getByRole("button", { name: "Later scenes", exact: true }).click();
});
Then("scenes 5 to 8 are shown", async function () {
  await expect(this.page.locator(".scene-launch")).toHaveText(
    ["Scene 5 ▷", "Scene 6 ▷", "Scene 7 ▷", "Scene 8 ▷"],
    { useInnerText: true },
  );
});

// ---- clip length ----
async function cellOn17(page) {
  const roll = page.locator('[data-roll-note="48"][data-roll-step="16"]');
  return (await roll.count()) ? roll : page.locator('[data-step="16"]');
}
When(
  "I open its first clip, set Length to {int} steps and add a note on step {int}",
  async function (length, step) {
    assert.equal(step, 17);
    const n = Number(
      (await this.page.locator(".screen-identity").textContent())?.match(/Track (\d)/)?.[1] ?? 1,
    );
    await press(this.page, "main");
    const slot = this.page.locator(`[data-slot="${12 + n - 1}"]`);
    await slot.click();
    if ((await this.page.locator(".screen-content").getAttribute("data-page")) === "clips")
      await slot.click();
    await expect(this.page.locator("#device-length")).toBeVisible();
    await this.page.locator("#device-length").selectOption(String(length));
    await action(this.page, "step-next");
    if (!(await this.page.locator(".piano-roll").count())) await action(this.page, "tool:draw");
    await (await cellOn17(this.page)).click();
    await expect(await cellOn17(this.page)).toHaveAttribute("aria-pressed", "true");
  },
);
When("I set Length to {int} steps but cancel the question", async function (length) {
  this.page.once("dialog", (d) => d.dismiss());
  await this.page.locator("#device-length").selectOption(String(length));
});
When("I set Length to {int} steps and confirm the question", async function (length) {
  this.page.once("dialog", (d) => d.accept());
  await this.page.locator("#device-length").selectOption(String(length));
});
Then(
  "the clip is still {int} steps long with its note on step {int}",
  async function (length, _step) {
    await expect(this.page.locator("#device-length")).toHaveValue(String(length));
    if (!(await this.page.locator('[data-roll-step="16"], [data-step="16"]').count()))
      await action(this.page, "step-next");
    await expect(await cellOn17(this.page)).toHaveAttribute("aria-pressed", "true");
  },
);
Then(
  "the clip is {int} steps long and the note on step {int} is gone",
  async function (length, _step) {
    await expect(this.page.locator("#device-length")).toHaveValue(String(length));
    await expect(this.page.locator('[data-roll-step="16"], [data-step="16"]')).toHaveCount(0);
    await expect(this.page.getByRole("status")).toContainText("removed");
  },
);
When("I press UNDO", async function () {
  await press(this.page, "undo");
});

// ---- the scale picker ----
When("I open the Play page of track {int} and choose root D and scale Dorian", async function (n) {
  await selectTrack(this.page, n);
  await press(this.page, "shift");
  await press(this.page, "main");
  await this.page.locator("#wb-root").selectOption("2");
  await this.page.locator("#wb-scale").selectOption("dorian");
});
Then("pads 1 to 8 play D3 E3 F3 G3 A3 B3 C4 D4", async function () {
  const names = ["D3", "E3", "F3", "G3", "A3", "B3", "C4", "D4"];
  for (const [pad, name] of names.entries())
    await expect(this.page.locator(`.device-pad[data-pad="${pad}"] strong`)).toHaveText(name);
});
