import { z } from "zod";
import { migrateProject, type Project, ProjectSchema, parseProject } from "./index.ts";
import {
  extendedSampleProfile,
  MAX_LOOP_PROJECT_FRAMES,
  MAX_LOOP_SAMPLE_FRAMES,
  MAX_PROJECT_BYTES,
  MAX_SAMPLE_FRAMES,
  MAX_SAMPLES,
  preflightProjectText,
} from "./input.ts";
import { projectReadError } from "./project-errors.ts";
import { type ProjectExtensions, preservedProjectExtensions } from "./project-extensions.ts";

const hashSchema = z.string().regex(/^sha256-[a-f0-9]{64}$/);
const assetSchema = z
  .object({
    hash: hashSchema,
    sampleRate: z.number().int().min(8000).max(96000),
    pcm: z.array(z.number().finite().min(-1).max(1)).min(1).max(MAX_LOOP_SAMPLE_FRAMES),
  })
  .strict();
const descriptors = z
  .array(
    z
      .object({
        id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
        name: z.string().min(1).max(120),
        assetHash: hashSchema,
      })
      .strict(),
  )
  .min(1)
  .max(MAX_SAMPLES);
const envelopeSchema = z
  .object({
    format: z.literal("xmp-bundle"),
    version: z.literal(1),
    project: z.record(z.string(), z.unknown()),
    assets: z.array(z.unknown()).min(1).max(MAX_SAMPLES),
  })
  .strict();
export async function hashSample(
  sampleRate: number,
  pcm: readonly number[] | Float32Array | Float64Array,
): Promise<string> {
  if (
    !Number.isInteger(sampleRate) ||
    sampleRate < 8000 ||
    sampleRate > 96000 ||
    pcm.length < 1 ||
    pcm.length > MAX_LOOP_SAMPLE_FRAMES
  )
    throw new Error("Invalid sample bounds");
  const bytes = new ArrayBuffer(8 + pcm.length * 8);
  const view = new DataView(bytes);
  view.setUint32(0, sampleRate, true);
  view.setUint32(4, pcm.length, true);
  pcm.forEach((value, index) => {
    if (!Number.isFinite(value) || value < -1 || value > 1)
      throw new Error("Invalid sample amplitude");
    view.setFloat64(8 + index * 8, value === 0 ? 0 : value, true);
  });
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256-${Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("")}`;
}
export async function exportPortable(project: Project): Promise<string> {
  const validated = ProjectSchema.parse(project);
  const assets = new Map<string, z.infer<typeof assetSchema>>();
  const samples = [];
  for (const sample of validated.samples) {
    const hash = await hashSample(sample.sampleRate, sample.pcm);
    if (!assets.has(hash))
      assets.set(hash, { hash, sampleRate: sample.sampleRate, pcm: sample.pcm });
    samples.push({ id: sample.id, name: sample.name, assetHash: hash });
  }
  const text = JSON.stringify({
    format: "xmp-bundle",
    version: 1,
    project: { ...validated, samples },
    assets: [...assets.values()],
  });
  preflightProjectText(text, true);
  return text;
}
export async function importPortable(
  text: string,
  options: SongImportOptions = {},
): Promise<Project> {
  preflightProjectText(text, true);
  const value: unknown = JSON.parse(text);
  const profile = value && typeof value === "object" && "project" in value ? value.project : value;
  if (!extendedSampleProfile(profile) && new TextEncoder().encode(text).length > MAX_PROJECT_BYTES)
    throw new Error("Project exceeds 24 MiB");
  if (
    typeof value === "object" &&
    value !== null &&
    "format" in value &&
    value.format === "xmp-bundle" &&
    "version" in value &&
    value.version !== 1 &&
    value.version !== 2
  )
    throw projectReadError("Unsupported song file version. Update XMP OS or use a legacy copy.");
  if (
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    "format" in value &&
    value.format === "xmp-bundle" &&
    value.version === 2
  )
    return importSongValue(value, options);
  if (
    typeof value === "object" &&
    value !== null &&
    "format" in value &&
    value.format === "xmp-project"
  )
    return parseProject(text);
  const envelope = envelopeSchema.parse(value);
  const samples = descriptors.parse(envelope.project.samples);
  // Total PCM bounds precede number validation and any hashing/canonical buffers.
  const extended = extendedSampleProfile(envelope.project);
  let frames = 0;
  for (const raw of envelope.assets) {
    if (typeof raw !== "object" || raw === null || !("pcm" in raw) || !Array.isArray(raw.pcm))
      throw new Error("Invalid sample asset");
    if (raw.pcm.length > (extended ? MAX_LOOP_SAMPLE_FRAMES : 480000))
      throw new Error("Sample exceeds 480000 frames");
    for (const value of raw.pcm)
      if (typeof value !== "number" || !Number.isFinite(value) || value < -1 || value > 1)
        throw new Error("Invalid sample amplitude");
    frames += raw.pcm.length;
    if (frames > (extended ? MAX_LOOP_PROJECT_FRAMES : MAX_SAMPLE_FRAMES))
      throw new Error("Asset import exceeds two million frames");
  }
  const assets = new Map<string, z.infer<typeof assetSchema>>();
  for (const raw of envelope.assets) {
    const asset = assetSchema.parse(raw);
    if (assets.has(asset.hash)) throw new Error("Duplicate asset hash");
    if ((await hashSample(asset.sampleRate, asset.pcm)) !== asset.hash)
      throw new Error("Corrupt sample hash; project was not changed");
    assets.set(asset.hash, asset);
  }
  if ([...assets.keys()].some((hash) => !samples.some((sample) => sample.assetHash === hash)))
    throw new Error("Unreferenced asset in package");
  const embedded = samples.map((sample) => {
    const asset = assets.get(sample.assetHash);
    if (!asset) throw new Error(`Missing asset ${sample.assetHash}`);
    return { id: sample.id, name: sample.name, sampleRate: asset.sampleRate, pcm: asset.pcm };
  });
  return migrateProject({ ...envelope.project, samples: embedded });
}

// Version 2 is the cross-platform song interchange format. Autosaves and older
// SDK clients may continue to write version 1 with exportPortable.
export const SONG_EXTENSION = ".xmpsong";
const sampleDescriptor = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    name: z.string().min(1).max(120),
    assetHash: hashSchema,
    sampleRate: z.number().int().min(8000).max(96000),
    frames: z.number().int().min(1).max(MAX_LOOP_SAMPLE_FRAMES),
  })
  .strict();
export type SongSample = z.infer<typeof sampleDescriptor>;
export type SongAsset = {
  sampleRate: number;
  pcm: readonly number[] | Float32Array | Float64Array;
};
export interface SongImportOptions {
  resolveAsset?: (sample: SongSample) => Promise<SongAsset | undefined>;
}
const binaryAsset = z
  .object({
    hash: hashSchema,
    sampleRate: z.number().int().min(8000).max(96000),
    frames: z.number().int().min(1).max(MAX_LOOP_SAMPLE_FRAMES),
    encoding: z.enum(["pcm-f32le", "pcm-f64le"]),
    // Chunks stay below the existing parser's string budget. No new parser limits.
    chunks: z
      .array(
        z
          .string()
          .min(4)
          .max(960)
          .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
      )
      .min(1)
      .max(Math.ceil((MAX_LOOP_SAMPLE_FRAMES * 8) / 720)),
  })
  .strict();
const songEnvelope = z
  .object({
    format: z.literal("xmp-bundle"),
    version: z.literal(2),
    sampleMode: z.enum(["embedded", "referenced"]),
    projectHash: hashSchema,
    project: z.record(z.string(), z.unknown()),
    assets: z.array(binaryAsset).max(MAX_SAMPLES),
  })
  .strict();
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function base64(bytes: Uint8Array): string {
  let result = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0,
      b = bytes[i + 1] ?? 0,
      c = bytes[i + 2] ?? 0;
    const bits = a * 65536 + b * 256 + c;
    result +=
      (alphabet[(bits >>> 18) & 63] ?? "") +
      (alphabet[(bits >>> 12) & 63] ?? "") +
      (i + 1 < bytes.length ? alphabet[(bits >>> 6) & 63] : "=") +
      (i + 2 < bytes.length ? alphabet[bits & 63] : "=");
  }
  return result;
}
function decodeAsset(asset: z.infer<typeof binaryAsset>): number[] {
  const width = asset.encoding === "pcm-f32le" ? 4 : 8;
  const byteCount = asset.frames * width;
  if (asset.chunks.length !== Math.ceil(byteCount / 720))
    throw new Error("Invalid audio chunk count");
  const bytes = new Uint8Array(byteCount);
  let offset = 0;
  for (const chunk of asset.chunks) {
    const size = Math.min(720, byteCount - offset);
    if (chunk.length !== Math.ceil(size / 3) * 4) throw new Error("Invalid audio chunk length");
    const part = new Uint8Array(size);
    let at = 0;
    for (let i = 0; i < chunk.length; i += 4) {
      const bits =
        (alphabet.indexOf(chunk[i] ?? "") << 18) |
        (alphabet.indexOf(chunk[i + 1] ?? "") << 12) |
        (Math.max(0, alphabet.indexOf(chunk[i + 2] ?? "")) << 6) |
        Math.max(0, alphabet.indexOf(chunk[i + 3] ?? ""));
      if (at < size) part[at++] = (bits >>> 16) & 255;
      if (at < size) part[at++] = (bits >>> 8) & 255;
      if (at < size) part[at++] = bits & 255;
    }
    if (base64(part) !== chunk) throw new Error("Noncanonical audio encoding");
    bytes.set(part, offset);
    offset += size;
  }
  const view = new DataView(bytes.buffer);
  return Array.from({ length: asset.frames }, (_, i) =>
    width === 4 ? view.getFloat32(i * 4, true) : view.getFloat64(i * 8, true),
  );
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
async function descriptorHash(project: unknown) {
  const bytes = new TextEncoder().encode(canonical(project));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256-${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
export class MissingSongAssetsError extends Error {
  readonly missing: SongSample[];
  constructor(missing: SongSample[]) {
    super(
      `Missing samples: ${missing.map((s) => s.name).join(", ")}. Locate matching WAV files or open a copy packaged with samples. Your song was not changed.`,
    );
    this.name = "MissingSongAssetsError";
    this.missing = missing;
  }
}
export async function exportSong(
  project: Project,
  { packageSamples = true } = {},
): Promise<string> {
  const validated = ProjectSchema.parse(project);
  if (typeof packageSamples !== "boolean") throw new Error("Invalid sample packaging option");
  const samples: SongSample[] = [],
    assets = new Map<string, z.infer<typeof binaryAsset>>();
  for (const sample of validated.samples) {
    const hash = await hashSample(sample.sampleRate, sample.pcm);
    samples.push({
      id: sample.id,
      name: sample.name,
      assetHash: hash,
      sampleRate: sample.sampleRate,
      frames: sample.pcm.length,
    });
    if (packageSamples && !assets.has(hash)) {
      const width = sample.pcm.every((v) => Math.fround(v) === v) ? 4 : 8;
      const bytes = new Uint8Array(sample.pcm.length * width),
        view = new DataView(bytes.buffer);
      sample.pcm.forEach((v, i) => {
        if (width === 4) view.setFloat32(i * 4, v === 0 ? 0 : v, true);
        else view.setFloat64(i * 8, v === 0 ? 0 : v, true);
      });
      const chunks: string[] = [];
      for (let i = 0; i < bytes.length; i += 720) chunks.push(base64(bytes.subarray(i, i + 720)));
      assets.set(hash, {
        hash,
        sampleRate: sample.sampleRate,
        frames: sample.pcm.length,
        encoding: width === 4 ? "pcm-f32le" : "pcm-f64le",
        chunks,
      });
    }
  }
  // Remove undefined optional fields, as on the wire, before canonical hashing.
  const descriptor = JSON.parse(JSON.stringify({ ...validated, samples }));
  const text = JSON.stringify({
    format: "xmp-bundle",
    version: 2,
    sampleMode: packageSamples ? "embedded" : "referenced",
    projectHash: await descriptorHash(descriptor),
    project: descriptor,
    assets: [...assets.values()],
  });
  preflightProjectText(text, true);
  return text;
}
async function prepareSong(value: unknown) {
  // Reject amplification before Zod walks chunk arrays or allocates issue lists.
  if (
    !value ||
    typeof value !== "object" ||
    !("assets" in value) ||
    !Array.isArray(value.assets) ||
    value.assets.length > MAX_SAMPLES
  )
    throw new Error("Invalid song asset table");
  if (
    !("project" in value) ||
    !value.project ||
    typeof value.project !== "object" ||
    !("samples" in value.project) ||
    !Array.isArray(value.project.samples) ||
    value.project.samples.length < 1 ||
    value.project.samples.length > MAX_SAMPLES
  )
    throw new Error("Invalid song sample descriptors");
  const extended = extendedSampleProfile(value.project);
  const maxSample = extended ? MAX_LOOP_SAMPLE_FRAMES : 480000;
  const maxTotal = extended ? MAX_LOOP_PROJECT_FRAMES : MAX_SAMPLE_FRAMES;
  let sampleFrames = 0;
  for (const sample of value.project.samples) {
    if (
      !sample ||
      !Number.isInteger(sample.frames) ||
      sample.frames < 1 ||
      sample.frames > maxSample
    )
      throw new Error("Invalid song sample bounds");
    sampleFrames += sample.frames;
    if (sampleFrames > maxTotal)
      throw new Error(
        extended ? "Song exceeds extended sample budget" : "Song exceeds two million sample frames",
      );
  }
  let declaredFrames = 0;
  for (const raw of value.assets) {
    if (
      !raw ||
      typeof raw !== "object" ||
      !Number.isInteger(raw.frames) ||
      raw.frames < 1 ||
      raw.frames > maxSample ||
      !Array.isArray(raw.chunks) ||
      !["pcm-f32le", "pcm-f64le"].includes(raw.encoding) ||
      raw.chunks.length !== Math.ceil((raw.frames * (raw.encoding === "pcm-f32le" ? 4 : 8)) / 720)
    )
      throw new Error("Invalid song audio bounds");
    declaredFrames += raw.frames;
    if (declaredFrames > maxTotal)
      throw new Error(
        extended
          ? "Song assets exceed extended sample budget"
          : "Song assets exceed two million frames",
      );
  }
  const envelope = songEnvelope.parse(value),
    samples = z.array(sampleDescriptor).min(1).max(MAX_SAMPLES).parse(envelope.project.samples);
  if ((await descriptorHash(envelope.project)) !== envelope.projectHash)
    throw new Error("Corrupt song metadata; project was not changed");
  let frames = 0;
  const unique = new Map<string, SongSample>();
  for (const sample of samples) {
    frames += sample.frames;
    if (frames > maxTotal)
      throw new Error(
        extended ? "Song exceeds extended sample budget" : "Song exceeds two million sample frames",
      );
    const previous = unique.get(sample.assetHash);
    if (
      previous &&
      (previous.frames !== sample.frames || previous.sampleRate !== sample.sampleRate)
    )
      throw new Error("Conflicting sample descriptors");
    if (!previous) unique.set(sample.assetHash, sample);
  }
  // Validate the complete musical model and slice bounds before any resolver I/O.
  // Placeholders are internal validation data and are never returned as a song.
  migrateProject({
    ...envelope.project,
    samples: samples.map((s) => ({
      id: s.id,
      name: s.name,
      sampleRate: s.sampleRate,
      pcm: new Array<number>(s.frames).fill(0),
    })),
  });
  if (envelope.sampleMode === "referenced" && envelope.assets.length)
    throw new Error("Referenced song must not contain embedded audio");
  let embeddedFrames = 0;
  for (const asset of envelope.assets) {
    embeddedFrames += asset.frames;
    if (embeddedFrames > maxTotal)
      throw new Error(
        extended
          ? "Song assets exceed extended sample budget"
          : "Song assets exceed two million frames",
      );
  }
  const assets = new Map<string, SongAsset>();
  for (const asset of envelope.assets) {
    const expected = unique.get(asset.hash);
    if (
      assets.has(asset.hash) ||
      !expected ||
      expected.frames !== asset.frames ||
      expected.sampleRate !== asset.sampleRate
    )
      throw new Error("Duplicate, unreferenced or conflicting audio asset");
    const pcm = decodeAsset(asset);
    if ((await hashSample(asset.sampleRate, pcm)) !== asset.hash)
      throw new Error("Corrupt sample hash; project was not changed");
    assets.set(asset.hash, { sampleRate: asset.sampleRate, pcm });
  }
  if (envelope.sampleMode === "embedded" && assets.size !== unique.size)
    throw new Error("Packaged song is missing embedded audio");
  return { envelope, samples, assets, unique };
}
async function importSongValue(value: unknown, options: SongImportOptions): Promise<Project> {
  const prepared = await prepareSong(value),
    missing: SongSample[] = [];
  for (const sample of prepared.unique.values()) {
    if (prepared.assets.has(sample.assetHash)) continue;
    const resolved = await options.resolveAsset?.(sample);
    if (!resolved) {
      missing.push(sample);
      continue;
    }
    if (
      resolved.sampleRate !== sample.sampleRate ||
      !(
        Array.isArray(resolved.pcm) ||
        resolved.pcm instanceof Float32Array ||
        resolved.pcm instanceof Float64Array
      ) ||
      resolved.pcm.length !== sample.frames
    )
      throw new Error(`Sample content does not match ${sample.name}; project was not changed`);
    const pcm = Array.from(resolved.pcm);
    if ((await hashSample(sample.sampleRate, pcm)) !== sample.assetHash)
      throw new Error(`Sample content does not match ${sample.name}; project was not changed`);
    prepared.assets.set(sample.assetHash, { sampleRate: sample.sampleRate, pcm });
  }
  if (missing.length) throw new MissingSongAssetsError(missing);
  return migrateProject({
    ...prepared.envelope.project,
    samples: prepared.samples.map((s) => {
      const asset = prepared.assets.get(s.assetHash);
      if (!asset) throw new Error("Unresolved song asset");
      return { id: s.id, name: s.name, sampleRate: asset.sampleRate, pcm: Array.from(asset.pcm) };
    }),
  });
}
export async function inspectSong(text: string) {
  preflightProjectText(text, true);
  const value: unknown = JSON.parse(text);
  const profile = value && typeof value === "object" && "project" in value ? value.project : value;
  if (!extendedSampleProfile(profile) && new TextEncoder().encode(text).length > MAX_PROJECT_BYTES)
    throw new Error("Project exceeds 24 MiB");
  if (
    typeof value === "object" &&
    value !== null &&
    "format" in value &&
    "version" in value &&
    value.format === "xmp-bundle" &&
    value.version === 2
  ) {
    const p = await prepareSong(value);
    return {
      version: 2,
      sampleMode: p.envelope.sampleMode,
      name: String(p.envelope.project.name),
      samples: p.samples,
      embeddedAssets: p.assets.size,
      preservedExtensions: preservedProjectExtensions({
        extensions: p.envelope.project.extensions as ProjectExtensions | undefined,
      }),
    };
  }
  const project = await importPortable(text);
  return {
    version: 1,
    sampleMode: "embedded" as const,
    name: project.name,
    samples: await Promise.all(
      project.samples.map(async (s) => ({
        id: s.id,
        name: s.name,
        assetHash: await hashSample(s.sampleRate, s.pcm),
        sampleRate: s.sampleRate,
        frames: s.pcm.length,
      })),
    ),
    embeddedAssets: project.samples.length,
    preservedExtensions: preservedProjectExtensions(project),
  };
}
