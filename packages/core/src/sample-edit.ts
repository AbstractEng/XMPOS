export interface SampleEdit {
  start: number;
  end: number;
  tune: number;
  level: number;
  fadeIn: number;
  fadeOut: number;
  reverse: boolean;
  slices: number;
}
export function sampleEdit(frames: number): SampleEdit {
  return {
    start: 0,
    end: frames,
    tune: 0,
    level: 1,
    fadeIn: 0,
    fadeOut: 0,
    reverse: false,
    slices: 1,
  };
}
export function renderSampleEdit(pcm: readonly number[], rate: number, edit: SampleEdit) {
  if (
    !Number.isInteger(edit.start) ||
    !Number.isInteger(edit.end) ||
    edit.start < 0 ||
    edit.end > pcm.length ||
    edit.end <= edit.start ||
    ![edit.tune, edit.level, edit.fadeIn, edit.fadeOut, rate].every(Number.isFinite) ||
    Math.abs(edit.tune) > 24 ||
    edit.level < 0 ||
    edit.level > 1 ||
    edit.fadeIn < 0 ||
    edit.fadeOut < 0 ||
    rate < 8000 ||
    rate > 96000
  )
    throw new Error("Invalid sample edit");
  const ratio = 2 ** (edit.tune / 12),
    length = Math.min(480000, Math.max(1, Math.round((edit.end - edit.start) / ratio)));
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const at = Math.min(edit.end - edit.start - 1, i * ratio),
      frame = edit.reverse ? edit.end - 1 - at : edit.start + at;
    const low = Math.floor(frame),
      mix = frame - low;
    const value = (pcm[low] ?? 0) * (1 - mix) + (pcm[Math.min(edit.end - 1, low + 1)] ?? 0) * mix;
    const fade = Math.min(
      1,
      edit.fadeIn ? i / ((edit.fadeIn * rate) / 1000) : 1,
      edit.fadeOut ? (length - 1 - i) / ((edit.fadeOut * rate) / 1000) : 1,
    );
    out[i] = Math.max(-1, Math.min(1, value * edit.level * Math.max(0, fade)));
  }
  return out;
}
