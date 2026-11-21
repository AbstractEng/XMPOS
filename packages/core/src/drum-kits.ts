import { z } from "zod";
import { type Project, ProjectSchema } from "./index.ts";
import { MAX_SAMPLES } from "./input.ts";
import { sampleInUse } from "./pads.ts";
import { decodeSampleWav } from "./recording.ts";

const MAX_KIT_FRAMES = 1000000;

const KitSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    samples: z
      .array(
        z
          .object({
            name: z.string().min(1).max(120),
            sampleRate: z.number().int().min(8000).max(96000),
            pcm: z.array(z.number().finite().min(-1).max(1)).min(1).max(480000),
            /** Choke group 1-8: a pad stops the others in its group (hi-hats). */
            choke: z.number().int().min(0).max(8).optional(),
            /**
             * A multi-sampled sound: velocity layers, softest first, each up to a
             * velocity (the last reaching 1), of 1-8 round-robin takes. `pcm`
             * stays the sound editors show; a take equal to it shares its sample.
             */
            layers: z
              .array(
                z
                  .object({
                    upTo: z.number().finite().min(0).max(1),
                    takes: z
                      .array(
                        z
                          .object({
                            sampleRate: z.number().int().min(8000).max(96000),
                            pcm: z.array(z.number().finite().min(-1).max(1)).min(1).max(480000),
                          })
                          .strict(),
                      )
                      .min(1)
                      .max(8),
                  })
                  .strict(),
              )
              .min(1)
              .max(8)
              .optional(),
          })
          .strict(),
      )
      .min(1)
      .max(16),
  })
  .strict();
export type DrumKit = z.infer<typeof KitSchema>;

export function validateDrumKit(value: unknown): DrumKit {
  if (
    !value ||
    typeof value !== "object" ||
    !("samples" in value) ||
    !Array.isArray(value.samples) ||
    value.samples.length < 1 ||
    value.samples.length > 16
  )
    throw new Error("A drum kit needs 1–16 samples");
  let frames = 0,
    sounds = 0;
  for (const sample of value.samples) {
    if (!sample || typeof sample !== "object" || !Array.isArray(sample.pcm))
      throw new Error("Invalid drum kit sample");
    const takes: unknown[] = [];
    if ("layers" in sample && sample.layers !== undefined) {
      if (!Array.isArray(sample.layers)) throw new Error("Invalid drum kit sample");
      for (const layer of sample.layers) {
        if (!layer || typeof layer !== "object" || !Array.isArray(layer.takes))
          throw new Error("Invalid drum kit sample");
        for (const take of layer.takes) {
          if (!take || typeof take !== "object" || !Array.isArray(take.pcm))
            throw new Error("Invalid drum kit sample");
          if (!samePcm(take.pcm, sample.pcm)) takes.push(take.pcm);
        }
      }
    }
    for (const pcm of [sample.pcm, ...takes] as unknown[][]) {
      frames += pcm.length;
      sounds++;
      if (pcm.length > 480000 || frames > MAX_KIT_FRAMES - (value.samples.length < 16 ? 1 : 0))
        throw new Error("Drum kit exceeds the one-million-frame project budget");
    }
  }
  if (sounds > MAX_KIT_SOUNDS) throw new Error("A drum kit holds at most 120 sounds");
  const kit = KitSchema.parse(value);
  for (const sample of kit.samples) {
    let top = 0;
    for (const layer of sample.layers ?? []) {
      if (!(layer.upTo > top)) throw new Error("Drum kit layers must rise in velocity");
      top = layer.upTo;
    }
    if (sample.layers && top !== 1)
      throw new Error("A drum kit sound's last layer must reach full velocity");
  }
  return kit;
}
/** The most sounds (own sounds and distinct takes) one kit may bring. */
export const MAX_KIT_SOUNDS = 120;
function samePcm(a: unknown[], b: unknown[]) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// Kick, snare and hats retain their usual positions when comparing kits.
function rank(name: string) {
  if (/kick|bass[ _-]?drum|\bbd\b/i.test(name)) return 0;
  if (/snare|\bsd\b/i.test(name)) return 1;
  if (/closed.*(hat|hh)|(hat|hh).*closed|\bchh\b/i.test(name)) return 2;
  if (/open.*(hat|hh)|(hat|hh).*open|\bohh\b/i.test(name)) return 3;
  if (/hat|\bhh\b/i.test(name)) return 4;
  return 5;
}

export function drumKitFromWavs(
  name: string,
  files: readonly { name: string; bytes: Uint8Array }[],
): DrumKit {
  if (files.length < 1 || files.length > 16) throw new Error("Choose 1–16 WAV one-shots");
  if (files.reduce((total, file) => total + file.bytes.length, 0) > 16 * 1024 * 1024)
    throw new Error("Kit files must total at most 16 MiB");
  const samples: DrumKit["samples"] = [];
  let frames = 0;
  const sorted = [...files].sort(
    (a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name, "en", { numeric: true }),
  );
  const primary = [0, 1, 2, 3].flatMap((group) => {
    const match = sorted.find((file) => rank(file.name) === group);
    return match ? [match] : [];
  });
  const ordered = [...primary, ...sorted.filter((file) => !primary.includes(file))];
  for (const file of ordered) {
    if (!/\.wav$/i.test(file.name)) throw new Error("Choose WAV files, not archives or plugins");
    const decoded = decodeSampleWav(file.bytes);
    frames += decoded.pcm.length;
    if (frames > MAX_KIT_FRAMES - (files.length < 16 ? 1 : 0))
      throw new Error("Drum kit exceeds the one-million-frame project budget");
    samples.push({
      name: file.name.replace(/\.wav$/i, "").slice(0, 120),
      sampleRate: decoded.sampleRate,
      pcm: Array.from(decoded.pcm),
    });
  }
  return validateDrumKit({ name, samples });
}

/**
 * Replace a kit atomically: the track's own kit when `trackId` names a track
 * with one, else the project's pads. Musical events and track machines stay
 * intact; samples no pad plays any more are dropped.
 */
export function applyDrumKit(project: Project, input: unknown, trackId?: string): Project {
  const kit = validateDrumKit(input),
    next = structuredClone(project),
    track = next.tracks.find((t) => t.id === trackId && t.pads),
    old = track?.pads ?? next.pads;
  const fresh = old.map(({ layers: _layers, ...pad }) => ({ ...pad, sampleId: "" }));
  if (track) track.pads = fresh;
  else next.pads = fresh;
  next.samples = next.samples.filter((s) => sampleInUse(next, s.id));
  const taken = new Set(next.samples.map((s) => s.id)),
    unique = (base: string) => {
      let id = base;
      for (let n = 1; taken.has(id); n++) id = `${base}-${n}`;
      taken.add(id);
      return id;
    };
  const ids = kit.samples.map((_s, i) => unique(`kit-${i}`));
  next.samples.push(
    ...kit.samples.map(({ choke: _choke, layers: _layers, ...sample }, i) => ({
      ...sample,
      id: ids[i] ?? "",
    })),
  );
  // Each layered sound's takes, after every sound (ids kit-<pad>-<layer>-<take>).
  const layers = kit.samples.map((sample, i) =>
    sample.layers?.map((layer, l) => ({
      upTo: layer.upTo,
      samples: layer.takes.map((take, t) => {
        if (samePcm(take.pcm, sample.pcm)) return ids[i] ?? "";
        const id = unique(`kit-${i}-${l}-${t}`);
        next.samples.push({ id, name: `${sample.name} ${l + 1}.${t + 1}`.slice(0, 120), ...take });
        return id;
      }),
    })),
  );
  const empty = kit.samples.length < 16 ? unique("kit-empty") : "";
  if (empty)
    next.samples.push({
      id: empty,
      name: "Empty",
      sampleRate: 48000,
      pcm: [0],
    });
  const pads = old.map((pad, i) => ({
    id: pad.id,
    name: kit.samples[i]?.name.slice(0, 40) ?? "Empty",
    sampleId: kit.samples[i] ? (ids[i] ?? "") : empty,
    playback: {
      mode: "one-shot" as const,
      rootNote: 60,
      chokeGroup: kit.samples[i]?.choke ?? 0,
    },
    ...(layers[i] ? { layers: layers[i] } : {}),
  }));
  if (track) track.pads = pads;
  else next.pads = pads;
  if (next.samples.length > MAX_SAMPLES)
    throw new Error(
      "Project already uses too many sounds. Free sample slots before loading this kit.",
    );
  return ProjectSchema.parse(next);
}
