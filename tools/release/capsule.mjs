import { createHash, createPublicKey, sign, verify } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { root } from "../../acceptance/lib/workspace.mjs";
import { imageIdentity } from "../os/vm.mjs";

export const sha = (data) => createHash("sha256").update(data).digest("hex");
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const imageFiles = [
  "manifest.json",
  "kernel",
  "rootfs.cpio.gz",
  "sources.json",
  "sbom.json",
  "THIRD-PARTY-NOTICES.txt",
];
export const CapsuleManifest = z
  .object({
    format: z.literal("xmp-vm-development-release"),
    version: z.literal(1),
    sequence: z.number().int().min(1).max(1000000),
    target: z.string().regex(/^[a-z0-9_-]{1,64}$/),
    architecture: z.enum(["x86_64", "armv7"]),
    imageBuildId: digest,
    sourceHash: digest,
    compatibility: z
      .object({
        project: z.number().int().min(1).max(100),
        sdk: z.number().int().min(1).max(100),
        dsp: z.number().int().min(1).max(100),
      })
      .strict(),
    files: z
      .array(
        z
          .object({
            name: z.enum(imageFiles),
            bytes: z.number().int().min(1).max(134217728),
            sha256: digest,
          })
          .strict(),
      )
      .length(6),
    developmentOnly: z.literal(true),
    publicRedistributionApproved: z.literal(false),
  })
  .strict();
const Envelope = z
  .object({ manifest: CapsuleManifest, keyId: digest, signature: z.string().max(128) })
  .strict();
export function canonicalManifest(input) {
  const manifest = CapsuleManifest.parse(input);
  if (new Set(manifest.files.map((f) => f.name)).size !== 6)
    throw new Error("Missing/duplicate signed image component");
  manifest.files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return manifest;
}
function signedBytes(manifest) {
  return Buffer.from(
    `XMP_VM_DEVELOPMENT_RELEASE_V1\0${JSON.stringify(canonicalManifest(manifest))}`,
  );
}
export function keyId(publicKey) {
  return sha(
    (publicKey.type === "public" ? publicKey : createPublicKey(publicKey)).export({
      type: "spki",
      format: "der",
    }),
  );
}
export function signManifest(manifest, privateKey) {
  return {
    manifest: canonicalManifest(manifest),
    keyId: keyId(privateKey),
    signature: sign(null, signedBytes(manifest), privateKey).toString("base64"),
  };
}
export function verifyEnvelope(input, trustedKey, minimumSequence = 0) {
  const envelope = Envelope.parse(input),
    manifest = canonicalManifest(envelope.manifest);
  const signature = Buffer.from(envelope.signature, "base64");
  if (
    signature.length !== 64 ||
    signature.toString("base64") !== envelope.signature ||
    envelope.keyId !== keyId(trustedKey) ||
    !verify(null, signedBytes(manifest), trustedKey, signature)
  )
    throw new Error("Invalid release signature or untrusted signer");
  if (manifest.target !== "p10-qemu-x86_64-v1" || manifest.architecture !== "x86_64")
    throw new Error("Wrong VM target/model; physical devices unsupported");
  if (
    manifest.compatibility.project !== 6 ||
    manifest.compatibility.sdk !== 2 ||
    manifest.compatibility.dsp !== 1
  )
    throw new Error("Incompatible project/SDK/DSP dependency set");
  if (manifest.sequence <= minimumSequence)
    throw new Error("Stale release sequence; external downgrade refused");
  return { manifest, releaseId: sha(signedBytes(manifest)), keyId: envelope.keyId };
}
export async function ownedDirectory(path) {
  const requested = resolve(path),
    prefix = realpathPrefix();
  if (
    !requested.startsWith(`${resolve(root, "reports")}/`) &&
    !requested.startsWith(`${resolve(root, "artifacts")}/`) &&
    !requested.startsWith(`${resolve(root, "build")}/`)
  )
    throw new Error("Owned workspace directory required; no devices or mounted volumes");
  const actual = await realpath(requested);
  if ((await lstat(requested)).isSymbolicLink() || !actual.startsWith(await prefix))
    throw new Error("Escaping/symlink release directory rejected");
  return actual;
}
async function realpathPrefix() {
  return `${await realpath(root)}/`;
}
export async function componentBytes(directory, name) {
  if (!imageFiles.includes(name)) throw new Error("Unknown signed component");
  const path = join(directory, name),
    info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 134217728)
    throw new Error("Regular bounded image component required");
  return readFile(path);
}
export async function sealImage(directory, sequence, privateKey) {
  const image = await imageIdentity(directory),
    files = [];
  for (const name of imageFiles) {
    const bytes = await componentBytes(image.directory, name);
    files.push({ name, bytes: bytes.length, sha256: sha(bytes) });
  }
  return signManifest(
    {
      format: "xmp-vm-development-release",
      version: 1,
      sequence,
      target: image.manifest.profile,
      architecture: "x86_64",
      imageBuildId: image.manifest.buildId,
      sourceHash: image.manifest.sourceHash,
      compatibility: { project: 6, sdk: 2, dsp: 1 },
      files,
      developmentOnly: true,
      publicRedistributionApproved: false,
    },
    privateKey,
  );
}
export async function verifyCapsule(directory, input, trustedKey, minimumSequence = 0) {
  const result = verifyEnvelope(input, trustedKey, minimumSequence);
  const owned = await ownedDirectory(directory);
  for (const component of result.manifest.files) {
    const bytes = await componentBytes(owned, component.name);
    if (bytes.length !== component.bytes || sha(bytes) !== component.sha256)
      throw new Error(`Corrupted signed component: ${component.name}`);
  }
  const image = await imageIdentity(owned);
  if (
    image.manifest.buildId !== result.manifest.imageBuildId ||
    image.manifest.sourceHash !== result.manifest.sourceHash ||
    image.manifest.profile !== result.manifest.target
  )
    throw new Error("Signed image identity mismatch");
  return { ...result, directory: owned };
}
