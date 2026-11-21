import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  canonical,
  digest,
  PackageSchema,
  validatePackage,
} from "../../packages/sdk/src/community/package.ts";
import {
  CommunityProjectSchema,
  upgradeCommunity,
  validateCommunityProject,
} from "../../packages/sdk/src/community/project.ts";

const snapshot = z
  .object({ packages: z.array(PackageSchema).max(16), project: CommunityProjectSchema.nullable() })
  .strict();
const storeSchema = z
  .object({
    format: z.literal("xmp-package-store"),
    version: z.literal(1),
    generation: z.number().int().min(0).max(1000000),
    active: snapshot,
    rollback: z
      .object({ expected: z.string().regex(/^[a-f0-9]{64}$/), snapshot })
      .strict()
      .nullable(),
  })
  .strict();
const MAX = 32 * 1024 * 1024;
async function validateSnapshot(value) {
  const state = snapshot.parse(value),
    validated = await Promise.all(state.packages.map(validatePackage));
  if (new Set(validated.map((p) => p.manifest.id)).size !== validated.length)
    throw new Error("Duplicate installed package ID");
  if (state.project) await validateCommunityProject(state.project, state.packages);
  return state;
}
export async function openPackageStore(directory, { create = false } = {}) {
  const requested = resolve(directory);
  if (create) await mkdir(requested, { recursive: true, mode: 0o700 });
  const info = await lstat(requested);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("Package store must be a real directory");
  const root = await realpath(requested);
  const file = join(root, "state.json"),
    lock = join(root, ".transaction-lock");
  const load = async () => {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX)
      throw new Error("Invalid package store file");
    const state = storeSchema.parse(JSON.parse(await readFile(file, "utf8")));
    await validateSnapshot(state.active);
    if (state.rollback) await validateSnapshot(state.rollback.snapshot);
    return state;
  };
  const commit = async (value, fail) => {
    const text = canonical(storeSchema.parse(value));
    if (Buffer.byteLength(text) > MAX) throw new Error("Package store size budget exceeded");
    const temporary = join(root, `.transaction-${randomUUID()}.partial`);
    try {
      const fd = await open(temporary, "wx", 0o600);
      try {
        await fd.writeFile(text);
        await fd.sync();
      } finally {
        await fd.close();
      }
      if (fail) await fail();
      await rename(temporary, file);
      const parentDirectory = await open(root, "r");
      try {
        await parentDirectory.sync();
      } finally {
        await parentDirectory.close();
      }
    } catch (e) {
      try {
        await unlink(temporary);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      throw e;
    }
  };
  if (create) {
    try {
      await lstat(file);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      const fd = await open(file, "wx", 0o600);
      try {
        await fd.writeFile(
          canonical({
            format: "xmp-package-store",
            version: 1,
            generation: 0,
            active: { packages: [], project: null },
            rollback: null,
          }),
        );
        await fd.sync();
      } finally {
        await fd.close();
      }
    }
  }
  await load();
  const transaction = async (expected, change, fail) => {
    await mkdir(lock, { mode: 0o700 });
    try {
      const current = await load();
      if (current.generation !== expected)
        throw new Error("Stale package store generation; reopen before retrying");
      const candidate = await change(structuredClone(current));
      await validateSnapshot(candidate.active);
      await commit(candidate, fail);
      return candidate;
    } finally {
      await rmdir(lock);
    }
  };
  return {
    root,
    read: load,
    setProject: async (project, expected, fail) =>
      transaction(
        expected,
        async (current) => {
          const active = await validateSnapshot({ ...current.active, project });
          return { ...current, generation: current.generation + 1, active, rollback: null };
        },
        fail,
      ),
    install: async (input, expected, fail) => {
      // Validate all data before obtaining the mutation lock or creating any staging file.
      const next = await validatePackage(input);
      return transaction(
        expected,
        async (current) => {
          const installed = current.active.packages.find(
            (p) =>
              p.files.find((f) => f.path === "manifest.json") &&
              JSON.parse(p.files.find((f) => f.path === "manifest.json").content).id ===
                next.manifest.id,
          );
          if (installed) {
            const previous = await validatePackage(installed);
            if (installed.sha256 !== next.pkg.sha256) {
              const oldVersion = previous.manifest.version.split(".").map(Number),
                newVersion = next.manifest.version.split(".").map(Number);
              let order = 0;
              for (let i = 0; i < 3 && !order; i++)
                order = (newVersion[i] ?? 0) - (oldVersion[i] ?? 0);
              if (order <= 0)
                throw new Error(
                  "Package versions are immutable; bump the version for an upgrade or use rollback",
                );
            }
            if (next.manifest.stateVersion < previous.manifest.stateVersion)
              throw new Error("Use transactional rollback instead of a state downgrade");
            for (const old of previous.manifest.parameters) {
              let name = old.id;
              for (let v = previous.manifest.stateVersion; v < next.manifest.stateVersion; v++) {
                const migration = next.program.migrations.find((m) => m.from === v);
                if (!migration) throw new Error(`Missing migration ${v} -> ${v + 1}`);
                name = migration.renames[name] ?? name;
              }
              const p = next.manifest.parameters.find((p) => p.id === name);
              if (!p || p.min !== old.min || p.max !== old.max || p.unit !== old.unit)
                throw new Error(
                  "Upgrade changes or drops a parameter range/unit; explicit migration policy required",
                );
            }
          }
          const packages = current.active.packages.filter((p) => p !== installed);
          packages.push(next.pkg);
          const project = current.active.project
            ? await upgradeCommunity(current.active.project, next.pkg)
            : null;
          const active = await validateSnapshot({ packages, project });
          return {
            ...current,
            generation: current.generation + 1,
            active,
            rollback: { expected: await digest(canonical(active)), snapshot: current.active },
          };
        },
        fail,
      );
    },
    rollback: async (expected, fail) =>
      transaction(
        expected,
        async (current) => {
          if (
            !current.rollback ||
            current.rollback.expected !== (await digest(canonical(current.active)))
          )
            throw new Error("No unchanged transaction is available for rollback");
          return {
            ...current,
            generation: current.generation + 1,
            active: current.rollback.snapshot,
            rollback: {
              expected: await digest(canonical(current.rollback.snapshot)),
              snapshot: current.active,
            },
          };
        },
        fail,
      ),
  };
}
