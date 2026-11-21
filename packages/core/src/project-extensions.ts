import { z } from "zod";

export type ExtensionJson =
  | null
  | boolean
  | number
  | string
  | ExtensionJson[]
  | {
      [key: string]: ExtensionJson;
    };
export interface ProjectExtension {
  version: number;
  required?: boolean;
  data: { [key: string]: ExtensionJson };
}
export type ProjectExtensions = Record<string, ProjectExtension>;

// This reader supports bounded sampler profiles and input settings. Add other
// features only with their native/Wasm implementation,
// validator and round-trip tests. A file can never declare itself supported.
export function supportsProjectExtension(id: string, version: number): boolean {
  return ["xmp.extended-samples", "xmp.sampler-input"].includes(id) && version === 1;
}

function record(value: unknown): value is Record<string, unknown> {
  return (
    value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype
  );
}

function validExtensions(value: unknown): value is ProjectExtensions {
  if (!record(value) || Object.keys(value).length > 32) return false;
  let nodes = 0;
  const visit = (item: unknown, depth: number): boolean => {
    if (++nodes > 8192 || depth > 10) return false;
    if (item === null || typeof item === "boolean") return true;
    if (typeof item === "number") return Number.isFinite(item);
    if (typeof item === "string") return item.length <= 512;
    if (Array.isArray(item)) {
      if (item.length > 256) return false;
      for (const child of item) if (!visit(child, depth + 1)) return false;
      return true;
    }
    return (
      record(item) &&
      Object.keys(item).length <= 64 &&
      Object.entries(item).every(
        ([key, child]) =>
          key.length <= 64 &&
          !["__proto__", "constructor", "prototype"].includes(key) &&
          visit(child, depth + 1),
      )
    );
  };
  if (!visit(value, 0)) return false;
  for (const [id, extension] of Object.entries(value)) {
    if (
      id.length > 64 ||
      !/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(id) ||
      !record(extension) ||
      Object.keys(extension).some((key) => !["version", "required", "data"].includes(key)) ||
      !Number.isInteger(extension.version) ||
      (extension.version as number) < 1 ||
      (extension.version as number) > 65535 ||
      !record(extension.data) ||
      ("required" in extension && typeof extension.required !== "boolean")
    )
      return false;
  }
  return new TextEncoder().encode(JSON.stringify(value)).length <= 256 * 1024;
}

export const ProjectExtensionsSchema = z
  .custom<ProjectExtensions>(validExtensions, "Invalid project extensions or JSON budget exceeded")
  .superRefine((extensions, ctx) => {
    for (const [id, extension] of Object.entries(extensions)) {
      if (
        id === "xmp.extended-samples" &&
        extension.version === 1 &&
        Object.keys(extension.data).length
      )
        ctx.addIssue({ code: "custom", message: "Invalid extended sample profile" });
      if (id === "xmp.sampler-input" && extension.version === 1) {
        const tracks = extension.data.tracks;
        if (
          Object.keys(extension.data).length !== 1 ||
          !record(tracks) ||
          Object.keys(tracks).length > 8 ||
          Object.entries(tracks).some(
            ([id, s]) =>
              !/^[a-zA-Z0-9_-]{1,64}$/.test(id) ||
              !record(s) ||
              Object.keys(s).length !== 2 ||
              typeof s.monitor !== "boolean" ||
              ![1, 2, 4].includes(s.bars as number),
          )
        )
          ctx.addIssue({ code: "custom", message: "Invalid sampler input settings" });
      }
      if (extension.required && !supportsProjectExtension(id, extension.version))
        ctx.addIssue({
          code: "custom",
          message: `Required project extension ${id} v${extension.version} is not supported by this XMP build`,
        });
    }
  });

/** Features kept intact by this build but inactive until a supporting reader opens them. */
export function preservedProjectExtensions(project: { extensions?: ProjectExtensions }) {
  return Object.entries(project.extensions ?? {})
    .filter(([id, extension]) => !supportsProjectExtension(id, extension.version))
    .map(([id, extension]) => ({ id, version: extension.version }));
}
