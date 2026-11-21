import assert from "node:assert/strict";
// Musical outcomes from the real portable download, rather than UI implementation
// details. Shared by recording and the fresh browser regression journey.
export function checkSliceAudio(pads, sample, assets = []) {
  const asset = assets.find((entry) => entry.hash === sample.assetHash);
  let pcm = sample.pcm ?? asset?.pcm;
  if (!pcm && asset?.chunks) {
    const bytes = Buffer.concat(asset.chunks.map((chunk) => Buffer.from(chunk, "base64")));
    const size = asset.encoding === "pcm-f32le" ? 4 : 8;
    assert.ok(
      ["pcm-f32le", "pcm-f64le"].includes(asset.encoding) && bytes.length === asset.frames * size,
    );
    pcm = Array.from({ length: asset.frames }, (_, i) =>
      size === 4 ? bytes.readFloatLE(i * size) : bytes.readDoubleLE(i * size),
    );
  }
  assert.ok(pcm?.length, "Verify sliced audio, not only slice marker positions");
  for (const [index, pad] of pads.entries()) {
    const first = pad.slice.start,
      last = Math.min(pcm.length, pad.slice.end);
    let power = 0;
    for (let i = first; i < last; i++) power += pcm[i] * pcm[i];
    assert.ok(
      last > first && Math.sqrt(power / (last - first)) > 0.005,
      `Slice ${index + 1} must contain audible music`,
    );
  }
}
export function checkLessonProject(id, p, assets = []) {
  const lesson = Number(id.slice(0, 2));
  const drums = p.tracks[0];
  const original = drums.clips.find((c) => c.id === p.scenes[0].clips[drums.id]);
  const positions = (clip, pad) =>
    clip.steps
      .filter((s) => s.pad === pad)
      .map((s) => s.step)
      .sort((a, b) => a - b);
  if (lesson === 1) assert.equal(drums.clips.length, 0);
  if (lesson >= 2) {
    assert.deepEqual(positions(original, 0), [0, 4, 8, 12], `${id}: keep the four kicks`);
    assert.deepEqual(positions(original, 1), [4, 12], `${id}: keep the original backbeat`);
  }
  if (lesson >= 3) {
    assert.deepEqual(positions(original, 2), [0, 2, 4, 6, 8, 10, 12, 14]);
    assert.equal(original.steps.find((s) => s.pad === 2 && s.step === 14).velocity, 0.5);
  }
  if (lesson >= 4) {
    const bass = p.tracks[1];
    assert.equal(bass.machine.id, "xmp.subtractive");
    assert.deepEqual(
      bass.clips[0].steps.map((s) => s.note),
      [48, 48, 52],
    );
  }
  if (lesson >= 5) {
    const variation = drums.clips.find((c) => c.id === p.scenes[1].clips[drums.id]);
    assert.notEqual(variation.id, original.id);
    assert.deepEqual(positions(variation, 1), [4, 12, 14]);
  }
  if (lesson >= 9) {
    assert.equal(p.tracks[2].machine.id, "xmp.subtractive");
    assert.ok(
      p.tracks[2].clips.some((c) => c.steps.length >= 3 || c.sequence?.notes?.length >= 3),
      `${id}: the performed take must contain notes`,
    );
  }
  if (lesson >= 10)
    assert.notEqual(
      drums.pads[0].sampleId,
      p.pads[0].sampleId,
      `${id}: load a separate kit on the drum track`,
    );
  if (lesson >= 11)
    assert.notEqual(drums.pads[4].sampleId, "kit-4-1", `${id}: keep the edited clap`);
  if (lesson >= 13)
    assert.match(drums.pads[1].name, /NEWCLAP/i, `${id}: the imported clap replaces the snare`);
  if (lesson >= 7) {
    assert.deepEqual(
      p.performance?.chain.map((c) => c.sceneId),
      ["scene-0", "scene-1", "scene-0"],
      `${id}: keep the three-part song`,
    );
    assert.equal(p.performance.chain[2].repeats, 2);
  }
  if (lesson === 16) {
    const pads = p.tracks[3].pads ?? p.pads;
    assert.equal(pads[0].sampleId, pads[3].sampleId, "Four slices share the original asset");
    assert.ok(
      pads.slice(0, 4).every((pad) => pad.slice),
      "All four pads have a slice",
    );
    const starts = pads.slice(0, 4).map((pad) => pad.slice.start);
    const loop = p.samples.find((sample) => sample.id === pads[0].sampleId);
    assert.ok(
      (loop.frames ?? loop.pcm?.length ?? 0) > 190000,
      "Slice the supplied four-second loop, not a short drum hit",
    );
    checkSliceAudio(pads.slice(0, 4), loop, assets);
    assert.ok(
      starts.every((n, i) => i === 0 || n > starts[i - 1]),
      "Slices advance through the loop",
    );
  }
}
