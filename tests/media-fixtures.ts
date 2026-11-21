// Random WAV files (valid, odd and damaged) for the file tests:
// tests/parity/files-parity.test.ts and tests/media.test.ts.
export function wavBytes(r: () => number) {
  const pick = <T>(list: readonly T[]) => list[Math.floor(r() * list.length)] as T;
  const format = pick([1, 1, 1, 3, 2]),
    channels = pick([1, 2, 2, 3]),
    bits = format === 3 ? pick([32, 32, 16]) : pick([16, 24, 32, 8]),
    rate = pick([48000, 44100, 22050, 7000]),
    frames = pick([0, 1, 7, 100, 1000]),
    align = (channels * bits) / 8;
  const data: number[] = [];
  for (let i = 0; i < frames * channels; i++) {
    const v = r() * 2.2 - 1.1;
    if (format === 3) {
      const b = new DataView(new ArrayBuffer(4));
      b.setFloat32(0, r() < 0.01 ? Number.NaN : v, true);
      for (let k = 0; k < 4; k++) data.push(b.getUint8(k));
    } else {
      const max = 2 ** (bits - 1),
        n = Math.max(-max, Math.min(max - 1, Math.round(v * max)));
      for (let k = 0; k < bits / 8; k++) data.push((n >> (8 * k)) & 255);
    }
  }
  const chunk = (id: string, body: number[]) => [
    ...Array.from(id, (c) => c.charCodeAt(0)),
    ...[0, 8, 16, 24].map((s) => (body.length >> s) & 255),
    ...body,
    ...(body.length % 2 ? [0] : []),
  ];
  const fmt = [
    format & 255,
    format >> 8,
    channels,
    0,
    ...[0, 8, 16, 24].map((s) => (rate >> s) & 255),
    ...[0, 8, 16, 24].map((s) => ((rate * align) >> s) & 255),
    align,
    0,
    bits,
    0,
  ];
  const chunks = [
    ...(r() < 0.2 ? chunk("LIST", [1, 2, 3]) : []),
    ...(r() < 0.97 ? chunk("fmt ", fmt) : []),
    ...(r() < 0.97 ? chunk("data", data) : []),
  ];
  const body = [..."WAVE"].map((c) => c.charCodeAt(0)).concat(chunks);
  let bytes = [..."RIFF"]
    .map((c) => c.charCodeAt(0))
    .concat(
      [0, 8, 16, 24].map((s) => (body.length >> s) & 255),
      body,
    );
  if (r() < 0.05) bytes = bytes.slice(0, Math.floor(r() * bytes.length));
  if (r() < 0.05 && bytes.length > 12)
    bytes[Math.floor(r() * bytes.length)] = Math.floor(r() * 256);
  return Uint8Array.from(bytes);
}
