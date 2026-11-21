import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { inspectSong } from "../../packages/core/src/assets.ts";
import { decodeSampleWav } from "../../packages/core/src/recording.ts";
import type { DeviceCommand } from "./device-contract.ts";

type FileCommand = Extract<
  DeviceCommand,
  {
    op:
      | "device-file-start"
      | "device-file-write"
      | "device-file-open"
      | "device-file-save"
      | "device-file-read";
  }
>;
export const isFileCommand = (c: DeviceCommand): c is FileCommand =>
  c.op.startsWith("device-file-");
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
interface Ui {
  cdp(method: string, params?: object): Promise<{ root?: { nodeId: number }; nodeId?: number }>;
  evaluate(expression: string): Promise<unknown>;
  click(selector: string): Promise<void>;
  waitFor(expression: string): Promise<void>;
}
export class VmSongTransfer {
  #upload: { kind: "song" | "sample"; data: Buffer; offset: number; sha256: string } | undefined;
  #download: { id: string; data: Buffer } | undefined;
  private ui: Ui;
  constructor(ui: Ui) {
    this.ui = ui;
    const build = JSON.parse(readFileSync("/etc/xmp-build.json", "utf8"));
    if (
      process.platform !== "linux" ||
      !["device-qemu-x86_64-v1", "device-qemu-armv7-az01-v1"].includes(build.profile) ||
      !readFileSync("/proc/cmdline", "utf8").includes(`xmp.build=${build.buildId}`)
    )
      throw new Error("File transfer is limited to the owned generic VM");
  }
  async handle(c: FileCommand): Promise<object> {
    if (c.op === "device-file-start") {
      if (c.kind === "sample" && c.bytes > 16 * 1024 * 1024) throw new Error("WAV exceeds 16 MiB");
      this.#upload = { kind: c.kind, data: Buffer.alloc(c.bytes), offset: 0, sha256: c.sha256 };
      return { accepted: true };
    }
    if (c.op === "device-file-write") {
      const u = this.#upload,
        bytes = Buffer.from(c.data, "base64");
      if (
        !u ||
        c.offset !== u.offset ||
        bytes.length > 2048 ||
        !bytes.length ||
        bytes.toString("base64") !== c.data ||
        u.offset + bytes.length > u.data.length
      )
        throw new Error("Invalid upload chunk");
      bytes.copy(u.data, u.offset);
      u.offset += bytes.length;
      return { offset: u.offset };
    }
    if (c.op === "device-file-open") {
      const u = this.#upload;
      this.#upload = undefined;
      if (!u || u.offset !== u.data.length || sha(u.data) !== u.sha256)
        throw new Error("Incomplete or corrupt upload");
      if (u.kind === "song") await inspectSong(u.data.toString("utf8"));
      else decodeSampleWav(u.data);
      mkdirSync("/data/imports", { recursive: true, mode: 0o700 });
      const directory = mkdtempSync("/data/imports/transfer-"),
        path = join(directory, u.kind === "song" ? "song.xmpsong" : "sample.wav");
      try {
        writeFileSync(path, u.data, { flag: "wx", mode: 0o600 });
        await this.ui.click('[data-panel="menu"]');
        await this.ui.click('[data-action="page:project"]');
        const selector = u.kind === "song" ? "#device-project-file" : "#song-missing-files";
        const doc = await this.ui.cdp("DOM.getDocument"),
          input = await this.ui.cdp("DOM.querySelector", { nodeId: doc.root?.nodeId, selector });
        if (!input.nodeId) throw new Error("Song file input unavailable");
        await this.ui.cdp("DOM.setFileInputFiles", { nodeId: input.nodeId, files: [path] });
        await this.ui.waitFor(
          `(()=>{const s=document.querySelector('[role=status]')?.textContent??'';return !!s && s!=='Opening song…'})()`,
        );
        const message = String(
          await this.ui.evaluate("document.querySelector('[role=status]')?.textContent??''"),
        );
        return { opened: message.startsWith("Project opened"), message };
      } finally {
        unlinkSync(path);
        rmdirSync(directory);
      }
    }
    if (c.op === "device-file-save") {
      await this.ui.click('[data-panel="menu"]');
      await this.ui.click('[data-action="page:project"]');
      await this.ui.evaluate(
        `(()=>{const e=document.querySelector('#song-package-samples');if(!e)throw Error('File options unavailable');e.checked=${c.packageSamples};e.dispatchEvent(new Event('change',{bubbles:true}))})()`,
      );
      const previous = new Set(readdirSync("/data/downloads"));
      await this.ui.click('[data-action="save"]');
      const end = Date.now() + 30000;
      let file: string | undefined;
      while (!file && Date.now() < end) {
        file = readdirSync("/data/downloads").find(
          (f) => !previous.has(f) && /^[0-9a-f-]{36}$/.test(f),
        );
        if (!file) await new Promise((r) => setTimeout(r, 100));
      }
      if (!file) throw new Error("Song download did not complete");
      const data = readFileSync(join("/data/downloads", file));
      await inspectSong(data.toString("utf8"));
      this.#download = { id: randomUUID(), data };
      return { id: this.#download.id, bytes: data.length, sha256: sha(data), name: "song.xmpsong" };
    }
    const d = this.#download;
    if (!d || c.id !== d.id || c.offset >= d.data.length)
      throw new Error("Unknown download or invalid offset");
    return {
      id: d.id,
      offset: c.offset,
      data: d.data.subarray(c.offset, c.offset + 2048).toString("base64"),
    };
  }
}
