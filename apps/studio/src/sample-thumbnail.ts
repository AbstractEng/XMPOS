/** A bounded visual preview of the original asset, independent of the audio engine. */
export function sampleThumbnail(pcm: readonly number[]): string {
  if (!pcm.length) return "";
  const bars: string[] = [];
  for (let bin = 0; bin < 32; bin++) {
    const start = Math.floor((bin * pcm.length) / 32);
    const end = Math.max(start + 1, Math.floor(((bin + 1) * pcm.length) / 32));
    const stride = Math.max(1, Math.ceil((end - start) / 32));
    let peak = 0;
    for (let frame = start; frame < end; frame += stride)
      peak = Math.max(peak, Math.abs(pcm[frame] ?? 0));
    const height = Math.min(1, peak) * 11;
    bars.push(`M${bin * 4 + 2} ${(14 - height).toFixed(1)}v${(height * 2).toFixed(1)}`);
  }
  return bars.join("");
}
