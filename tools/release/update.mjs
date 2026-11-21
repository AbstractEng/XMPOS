import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { root } from "../../acceptance/lib/workspace.mjs";
import { bootVm, cloneVmSession, createVmSession } from "../os/vm.mjs";
import { componentBytes, imageFiles, ownedDirectory, sha, verifyCapsule } from "./capsule.mjs";

const ref = z
  .object({
    releaseId: z.string().regex(/^[a-f0-9]{64}$/),
    runId: z.string().regex(/^[a-f0-9]{32}$/),
  })
  .strict();
const State = z
  .object({
    format: z.literal("xmp-owned-vm-update-state"),
    version: z.literal(1),
    sequence: z.number().int().min(1),
    active: ref,
    previous: ref.nullable(),
  })
  .strict();
async function atomic(path, data) {
  const text = JSON.stringify(data),
    temporary = `${path}.pending`;
  for (const file of [path, temporary]) {
    try {
      const s = await lstat(file);
      if (!s.isFile() || s.isSymbolicLink()) throw new Error("Regular update ledger required");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const file = await open(temporary, "w", 0o600);
  try {
    await file.writeFile(text);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  const directory = await open(resolve(path, ".."), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
export class VmUpdateStore {
  constructor(directory, trustedKey) {
    this.directory = resolve(directory);
    this.trustedKey = trustedKey;
    this.boots = [];
    this.captures = [];
    if (
      !this.directory.startsWith(`${resolve(root, "reports")}/`) &&
      !this.directory.startsWith(`${resolve(root, "artifacts")}/`)
    )
      throw new Error("Updates require an owned workspace store; no hardware target");
  }
  async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await ownedDirectory(this.directory);
    const marker = join(this.directory, "owner.json");
    const entries = await readdir(this.directory);
    if (!entries.length)
      await writeFile(marker, JSON.stringify({ format: "xmp-vm-update-owner", version: 1 }), {
        flag: "wx",
        mode: 0o600,
      });
    const s = await lstat(marker);
    if (
      !s.isFile() ||
      s.isSymbolicLink() ||
      JSON.parse(await readFile(marker, "utf8")).format !== "xmp-vm-update-owner"
    )
      throw new Error("Foreign update store rejected");
  }
  async state() {
    await ownedDirectory(this.directory);
    return State.parse(JSON.parse(await readFile(join(this.directory, "active.json"), "utf8")));
  }
  async stage(directory, envelope, verified) {
    const destination = join(this.directory, "versions", verified.releaseId);
    try {
      await lstat(destination);
      await verifyCapsule(destination, envelope, this.trustedKey);
      return destination;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await mkdir(destination, { recursive: true, mode: 0o700 });
    for (const name of imageFiles) {
      const bytes = await componentBytes(directory, name);
      await writeFile(join(destination, name), bytes, { flag: "wx", mode: 0o600 });
    }
    await writeFile(join(destination, "capsule.json"), JSON.stringify(envelope), {
      flag: "wx",
      mode: 0o600,
    });
    await verifyCapsule(destination, envelope, this.trustedKey);
    return destination;
  }
  async activeSession() {
    const state = await this.state(),
      image = join(this.directory, "versions", state.active.releaseId);
    const envelope = JSON.parse(await readFile(join(image, "capsule.json"), "utf8"));
    await verifyCapsule(image, envelope, this.trustedKey);
    return createVmSession(join(this.directory, "runs", state.active.runId), image);
  }
  async health(session, startupUiFailure = false) {
    const vm = await bootVm(session, { startupUiFailure });
    this.boots.push({ ...vm.boot, args: vm.args, emulator: vm.emulator });
    let result, failure;
    try {
      if (vm.boot.recovery || vm.boot.playable === false || vm.boot.storageRecoveryRequired)
        throw new Error("Candidate is not playable");
      const status = await vm.request({ op: "status" }),
        fixture = await vm.request({ op: "fixture" });
      if (
        !status.projectHash ||
        status.projectRecovery?.readOnly ||
        !fixture.assertedInsideGuest ||
        fixture.frames !== 96000 ||
        fixture.firstNonzeroFrame !== 24000 ||
        fixture.peak !== 16384
      )
        throw new Error("Candidate musical health check failed");
      result = {
        buildId: vm.boot.buildId,
        projectHash: status.projectHash,
        fixtureHash: fixture.sha256,
        boot: vm.boot,
      };
    } catch (error) {
      failure = error;
    }
    const stopped = await vm.finish();
    this.captures.push({
      audio: stopped.audio,
      sha256: sha(await readFile(stopped.audio)),
      log: stopped.log,
      code: stopped.code,
      signal: stopped.signal,
      fault: false,
    });
    if (failure) throw failure;
    if (stopped.code !== 0 || !stopped.log.includes('XMPBOOT {"event":"storage-closed"}'))
      throw new Error("Candidate shutdown failed");
    return result;
  }

  async seed(directory, envelope, sourceSession) {
    const verified = await verifyCapsule(directory, envelope, this.trustedKey);
    if (sourceSession.manifest.buildId !== verified.manifest.imageBuildId)
      throw new Error("Seed disk and image mismatch");
    await this.initialize();
    try {
      await lstat(join(this.directory, "active.json"));
      throw new Error("Update store already seeded");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const image = await this.stage(directory, envelope, verified),
      runId = randomBytes(16).toString("hex");
    const session = await cloneVmSession(sourceSession, join(this.directory, "runs", runId), image),
      health = await this.health(session);
    await atomic(join(this.directory, "active.json"), {
      format: "xmp-owned-vm-update-state",
      version: 1,
      sequence: verified.manifest.sequence,
      active: { releaseId: verified.releaseId, runId },
      previous: null,
    });
    return health;
  }
  async attempt(
    directory,
    envelope,
    { startupUiFailure = false, interruptAfterSnapshot = false } = {},
  ) {
    // Signature/target/dependency and payload checks happen before any store write.
    const verified = await verifyCapsule(directory, envelope, this.trustedKey);
    const state = await this.state();
    if (verified.manifest.sequence <= state.sequence)
      throw new Error("Stale release sequence; no update writes performed");
    const lockPath = join(this.directory, "transaction.lock"),
      lock = await open(lockPath, "wx", 0o600);
    try {
      await lock.writeFile(JSON.stringify({ format: "xmp-vm-update-lock", pid: process.pid }));
      await lock.sync();
      const source = await this.activeSession(),
        sourceDiskHash = sha(await readFile(source.disk));
      const image = await this.stage(directory, envelope, verified),
        runId = randomBytes(16).toString("hex");
      const candidate = await cloneVmSession(source, join(this.directory, "runs", runId), image);
      const receipt = {
        format: "xmp-vm-update-transaction",
        previous: state.active,
        candidate: { releaseId: verified.releaseId, runId },
        sourceDiskHash,
        candidateBuildId: candidate.manifest.buildId,
      };
      await atomic(join(this.directory, "transaction.json"), receipt);
      if (interruptAfterSnapshot) throw new Error("FIXTURE_UPDATE_INTERRUPTED_AFTER_SNAPSHOT");
      let health;
      try {
        health = await this.health(candidate, startupUiFailure);
      } catch {
        if (sha(await readFile(source.disk)) !== sourceDiskHash)
          throw new Error("Known-good VM data changed during failed update");
        await atomic(join(this.directory, "last-result.json"), {
          ...receipt,
          outcome: "rolled-back",
          activeUnchanged: true,
        });
        await unlink(join(this.directory, "transaction.json"));
        return {
          outcome: "rolled-back",
          active: state.active,
          sourceDiskHash,
          activeUnchanged: true,
          hardwareQualified: false,
        };
      }
      if (sha(await readFile(source.disk)) !== sourceDiskHash)
        throw new Error("Known-good VM data changed during health check");
      await atomic(join(this.directory, "active.json"), {
        ...state,
        sequence: verified.manifest.sequence,
        previous: state.active,
        active: { releaseId: verified.releaseId, runId },
      });
      await atomic(join(this.directory, "last-result.json"), {
        ...receipt,
        outcome: "promoted",
        health,
      });
      await unlink(join(this.directory, "transaction.json"));
      return {
        outcome: "promoted",
        health,
        sourceDiskHash,
        previousDataUnchanged: true,
        hardwareQualified: false,
      };
    } finally {
      await lock.close();
      await unlink(lockPath);
    }
  }
  async recoverInterrupted() {
    const state = await this.state(),
      path = join(this.directory, "transaction.json");
    const transaction = JSON.parse(await readFile(path, "utf8"));
    ref.parse(transaction.previous);
    ref.parse(transaction.candidate);
    if (
      state.active.releaseId !== transaction.previous.releaseId ||
      state.active.runId !== transaction.previous.runId
    )
      throw new Error("Committed update requires explicit review; no automatic pointer rewrite");
    await this.activeSession();
    await atomic(join(this.directory, "last-result.json"), {
      ...transaction,
      outcome: "aborted-before-promotion",
    });
    await unlink(path);
    return {
      recovered: true,
      active: state.active,
      candidatePromoted: false,
      hardwareQualified: false,
    };
  }
}
