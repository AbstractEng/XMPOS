// Runs only inside an identity-bound, network-isolated generic Linux guest.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";
import { openProject } from "../../packages/core/src/project-io.ts";
import {
  compareParity,
  parityFixtures,
  referenceParity,
  verifyParityOracle,
} from "../../packages/sdk/src/parity.ts";
import { decodeResult, encodePlan } from "../../tools/sdk/parity-host.mjs";
import { DeviceCommand } from "./device-contract.ts";
import { probeHardware, systemReader } from "./hardware.ts";
import { isFileCommand, VmSongTransfer } from "./song-transfer.ts";

const hash = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const build = JSON.parse(readFileSync("/etc/xmp-build.json", "utf8"));
if (
  process.platform !== "linux" ||
  !["device-qemu-x86_64-v1", "device-qemu-armv7-az01-v1"].includes(build.profile) ||
  !readFileSync("/proc/cmdline", "utf8").includes(`xmp.build=${build.buildId}`)
)
  throw new Error("Device guest identity required");
const nativeArm = build.architecture === "armv7";
// Emulated ARM runs several times slower than the x86 guest; its frozen VM
// profile already allows longer limits, so browser calls scale with it.
const browserTimeoutMs = nativeArm ? 180000 : 60000;
const readinessTimeoutMs = nativeArm ? 360000 : 45000;
// The official az01 kernel builds in IPv6 SIT, which always creates a fallback
// "sit0" tunnel. It is tolerated only while it is a down SIT device (type 776);
// any other non-loopback interface still stops the guest.
const sysNet = (name: string, file: string) => {
  try {
    return readFileSync(`/sys/class/net/${name}/${file}`, "utf8").trim();
  } catch {
    return "";
  }
};
const inactiveKernelTunnels = readdirSync("/sys/class/net").filter(
  (n) =>
    nativeArm && n === "sit0" && sysNet(n, "type") === "776" && sysNet(n, "operstate") === "down",
);
const net = readdirSync("/sys/class/net").filter((n) => !inactiveKernelTunnels.includes(n));
if (
  net.some((n) => n !== "lo") ||
  /\s(?:9p|virtiofs|nfs|cifs)\s/.test(readFileSync("/proc/mounts", "utf8"))
)
  throw new Error("Isolated guest required");
const root = "/opt/xmp/studio",
  origin = "http://127.0.0.1:8080";
const server = createServer((req, res) => {
  try {
    if (req.method !== "GET") throw new Error("Read-only asset server");
    const path = realpathSync(
      join(
        root,
        decodeURIComponent(new URL(req.url ?? "/", origin).pathname),
        req.url?.split("?")[0]?.endsWith("/") ? "index.html" : "",
      ),
    );
    if (!path.startsWith(`${root}/`) || !statSync(path).isFile()) throw new Error("Invalid asset");
    const types: Record<string, string> = {
      html: "text/html",
      js: "text/javascript",
      css: "text/css",
      json: "application/json",
      wav: "audio/wav",
      svg: "image/svg+xml",
      png: "image/png",
      woff2: "font/woff2",
    };
    res.writeHead(200, {
      "Content-Type": types[path.split(".").at(-1) ?? ""] ?? "application/octet-stream",
      "Permissions-Policy": "midi=(), usb=(), hid=(), serial=(), microphone=(), camera=()",
      "Content-Security-Policy":
        "default-src 'self' blob: data:; script-src 'self' blob: 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-src 'none'; object-src 'none'",
    });
    res.end(readFileSync(path));
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise<void>((resolve) => server.listen(8080, "127.0.0.1", resolve));
mkdirSync("/data/chromium", { recursive: true });
mkdirSync("/data/downloads", { recursive: true });
const browser = spawn(
  "/usr/lib/chromium/chromium",
  [
    "--headless",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-audio-output",
    "--mute-audio",
    "--autoplay-policy=no-user-gesture-required",
    "--window-size=1600,1000",
    "--user-data-dir=/data/chromium",
    "--remote-debugging-pipe",
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"], detached: true },
);
const browserExit = new Promise<void>((resolve) => browser.once("exit", () => resolve()));
function stopGuestBrowserHelpers(signal: NodeJS.Signals) {
  for (const pid of readdirSync("/proc").filter((name) => /^[0-9]+$/.test(name))) {
    try {
      const exe = readlinkSync(`/proc/${pid}/exe`);
      if (["/usr/lib/chromium/chromium", "/usr/lib/chromium/chrome_crashpad_handler"].includes(exe))
        process.kill(Number(pid), signal);
    } catch {
      /* A guest process may already have exited. */
    }
  }
}
const decoder = new StringDecoder("utf8");
const writer = browser.stdio[3] as import("node:stream").Writable;
const reader = browser.stdio[4] as import("node:stream").Readable;
let next = 1,
  buffer = "",
  sessionId = "",
  blocked = 0,
  screenshot = Buffer.alloc(0);
const errors: string[] = [];
let confirmedDialog = false;
type CdpResult = {
  root?: { nodeId: number };
  nodeId?: number;
  targetId: string;
  sessionId: string;
  data: string;
  result: { value: unknown };
  exceptionDetails?: unknown;
};
const pending = new Map<
  number,
  {
    resolve: (r: CdpResult) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
function cdp(method: string, params: object = {}, session = sessionId): Promise<CdpResult> {
  if (pending.size > 32) throw new Error("CDP budget");
  return new Promise((resolve, reject) => {
    const id = next++,
      timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, browserTimeoutMs);
    pending.set(id, { resolve, reject, timer });
    writer.write(
      `${JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) })}\0`,
    );
  });
}
browser.stderr?.on("data", (b) => {
  if (errors.length < 8 && /FATAL|error while loading shared libraries/.test(b.toString()))
    errors.push(b.toString().slice(0, 240));
});
browser.on("exit", () => {
  for (const p of pending.values()) {
    clearTimeout(p.timer);
    p.reject(new Error("Guest Chromium exited"));
  }
  pending.clear();
});
reader.on("data", (b) => {
  buffer += decoder.write(b);
  if (buffer.length > 8_000_000) {
    browser.kill();
    return;
  }
  let end = buffer.indexOf("\0");
  while (end >= 0) {
    const m = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    if (m.id) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (p) {
        clearTimeout(p.timer);
        if (m.error) p.reject(new Error(JSON.stringify(m.error)));
        else p.resolve(m.result);
      }
    }
    end = buffer.indexOf("\0");
    if (m.method === "Runtime.exceptionThrown" && errors.length < 8)
      errors.push(JSON.stringify(m.params.exceptionDetails).slice(0, 240));
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error" && errors.length < 8) {
      const message = m.params.args[0]?.value;
      if (typeof message === "string" && message.startsWith("[XMP] XMP startup failed:"))
        errors.push(message.slice(0, 240));
    }
    if (m.method === "Page.javascriptDialogOpening")
      void cdp("Page.handleJavaScriptDialog", { accept: confirmedDialog });
    if (m.method === "Fetch.requestPaused") {
      const allowed =
        m.params.request.url.startsWith(`${origin}/`) ||
        /^(blob:|data:)/.test(m.params.request.url);
      if (!allowed) blocked++;
      void cdp(allowed ? "Fetch.continueRequest" : "Fetch.failRequest", {
        requestId: m.params.requestId,
        ...(!allowed ? { errorReason: "BlockedByClient" } : {}),
      });
    }
  }
});
const target = await cdp("Target.createTarget", { url: "about:blank" });
sessionId = (await cdp("Target.attachToTarget", { targetId: target.targetId, flatten: true }))
  .sessionId;
for (const method of ["Page.enable", "Runtime.enable"]) await cdp(method);
await cdp("Emulation.setDeviceMetricsOverride", {
  width: 1600,
  height: 1000,
  deviceScaleFactor: 1,
  mobile: false,
});
await cdp(
  "Browser.setDownloadBehavior",
  { behavior: "allowAndName", downloadPath: "/data/downloads" },
  "",
);
await cdp("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
await cdp("Page.addScriptToEvaluateOnNewDocument", {
  source: `globalThis.__hardwareAttempts=[];for(const [o,keys] of [[navigator,['requestMIDIAccess']],[navigator.usb,['requestDevice','getDevices']],[navigator.hid,['requestDevice','getDevices']],[navigator.serial,['requestPort','getPorts']],[navigator.mediaDevices,['getUserMedia','enumerateDevices']]])for(const k of keys)if(o&&typeof o[k]==='function')Object.defineProperty(o,k,{value:()=>{__hardwareAttempts.push(k);throw Error('Hardware forbidden')}});`,
});
async function evaluate(expression: string) {
  const r = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error("Guest UI operation failed");
  return r.result.value as Record<string, unknown>;
}
async function waitFor(expression: string) {
  const end = Date.now() + readinessTimeoutMs;
  do {
    if (await evaluate(expression)) return;
    await new Promise((r) => setTimeout(r, 100));
  } while (Date.now() < end);
  throw new Error("Guest UI readiness timeout");
}
const deviceReady = `({
  failed: !!document.querySelector('#boot-recovery:not([hidden])'),
  ready: !!document.querySelector('#app:not([inert]) .device-chassis')
})`;
async function waitForDevice() {
  const end = Date.now() + readinessTimeoutMs;
  do {
    const state = await evaluate(deviceReady);
    if (state.failed) throw new Error(`Guest Device startup failed: ${errors.join("; ")}`);
    if (state.ready) return;
    await new Promise((r) => setTimeout(r, 1000));
  } while (Date.now() < end);
  const state = await evaluate(
    `({ document: document.readyState, bootScreen: !!document.getElementById('boot-screen'),
      chassis: !!document.querySelector('.device-chassis'),
      loading: !!document.querySelector('.device-loading') })`,
  );
  throw new Error(`Guest Device startup timed out: ${JSON.stringify({ state, errors })}`);
}
await cdp("Page.navigate", { url: `${origin}/?layout=hardware` });
await waitForDevice();
async function click(selector: string) {
  const rect = await evaluate(
    `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)throw Error('Unavailable control');const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`,
  );
  await pointer(Number(rect.x), Number(rect.y));
}
async function pointer(x: number, y: number) {
  for (const type of ["mousePressed", "mouseReleased"])
    await cdp("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
}
async function status() {
  return evaluate(
    `(()=>({device:!!document.querySelector('.device-chassis'),page:document.querySelector('.screen-header strong')?.textContent?.slice(0,80),message:document.querySelector('[role=status]')?.textContent?.slice(0,160),transport:document.querySelector('#device-audio-state')?.textContent,clock:document.querySelector('#device-clock')?.textContent,pads:[...document.querySelectorAll('.device-pad-grid button')].map(e=>Number(e.dataset.pad)),logical:[document.querySelector('#device-screen')?.dataset.logicalWidth,document.querySelector('#device-screen')?.dataset.logicalHeight],steps:[...document.querySelectorAll('[data-step][aria-pressed=true]')].map(e=>Number(e.dataset.step)),attempts:globalThis.__hardwareAttempts??[]}))()`,
  );
}
const emit = (m: unknown) => process.stdout.write(`XMP!${JSON.stringify(m)}\n`);
emit({
  ready: true,
  buildId: build.buildId,
  profile: build.profile,
  kernel: readFileSync("/proc/sys/kernel/osrelease", "utf8").trim(),
  renderer: "guest-chromium",
  networkInterfaces: net,
  inactiveKernelTunnels,
  hostShares: false,
  physicalAccess: false,
  physicalAudioQualified: false,
  mpcDriversQualified: false,
});
const input = createInterface({ input: process.stdin });
const songTransfer = new VmSongTransfer({ cdp, evaluate, click, waitFor });
let queue = Promise.resolve();
input.on("line", (line) => {
  queue = queue.then(async () => {
    let id = 0;
    try {
      if (line.length > 4096) throw new Error("Command budget");
      const m = JSON.parse(line);
      id = m.id;
      if (!Number.isSafeInteger(id) || id < 1) throw new Error("Request identity");
      const c = DeviceCommand.parse(m.command);
      confirmedDialog = "confirmed" in c && c.confirmed === true;
      let result: unknown = {};
      const destructive =
        c.op === "device-click"
          ? await evaluate(
              `!!document.elementFromPoint(${c.x},${c.y})?.closest('[data-action="new"]')`,
            )
          : c.op === "device-control"
            ? c.kind === "action" && c.id === "new"
            : c.op === "device-key" && ["Enter", " "].includes(c.key)
              ? await evaluate(`!!document.activeElement?.closest('[data-action="new"]')`)
              : false;
      if (destructive && !confirmedDialog) {
        emit({
          id,
          ok: true,
          result: {
            confirmationRequired: "Start a new empty song and replace this VM's autosave?",
          },
        });
        return;
      }
      if (isFileCommand(c)) result = await songTransfer.handle(c);
      else if (c.op === "device-status")
        result = {
          ...(await status()),
          errors,
          blockedRequests: blocked,
          renderer: "guest-chromium",
        };
      else if (c.op === "device-click") await pointer(c.x, c.y);
      else if (c.op === "device-control")
        await click(
          c.kind === "page" ? `[data-action="page:${c.id}"]` : `[data-${c.kind}="${c.id}"]`,
        );
      else if (c.op === "device-select") {
        await evaluate(
          `(()=>{const e=document.getElementById(${JSON.stringify(c.id)});const v=${JSON.stringify(c.value)};if(!e||![...e.options].some(o=>o.value===v))throw Error('Invalid option');e.value=v;e.dispatchEvent(new Event('change',{bubbles:true}))})()`,
        );
      } else if (c.op === "device-key") {
        const keyCodes = {
          Tab: 9,
          Enter: 13,
          Escape: 27,
          ArrowLeft: 37,
          ArrowUp: 38,
          ArrowRight: 39,
          ArrowDown: 40,
          " ": 32,
        };
        for (const type of ["keyDown", "keyUp"])
          await cdp("Input.dispatchKeyEvent", {
            type,
            key: c.key,
            windowsVirtualKeyCode: keyCodes[c.key],
          });
      } else if (c.op === "device-reload") {
        await cdp("Page.reload");
        await waitForDevice();
      } else if (c.op === "device-snapshot") {
        screenshot = Buffer.from(
          (await cdp("Page.captureScreenshot", { format: "png" })).data,
          "base64",
        );
        if (screenshot.length > 2_000_000) throw new Error("Screenshot budget");
        result = { bytes: screenshot.length, sha256: hash(screenshot), width: 1600, height: 1000 };
      } else if (c.op === "device-chunk")
        result = {
          offset: c.offset,
          data: screenshot.subarray(c.offset, c.offset + 2048).toString("base64"),
        };
      else if (c.op === "device-export") {
        await click('[data-panel="menu"]');
        await click('[data-action="page:project"]');
        const previous = new Set(readdirSync("/data/downloads"));
        await click('[data-action="save"]');
        const end = Date.now() + 30000;
        let file: string | undefined;
        while (!file && Date.now() < end) {
          file = readdirSync("/data/downloads").find(
            (f) => !previous.has(f) && /^[0-9a-f-]{36}$/.test(f),
          );
          if (!file) await new Promise((r) => setTimeout(r, 100));
        }
        if (!file) throw new Error("Project download timeout");
        const text = readFileSync(join("/data/downloads", file), "utf8"),
          p = await openProject(text);
        result = {
          projectHash: hash(Buffer.from(JSON.stringify(p))),
          name: p.name,
          tracks: p.tracks.map((t) => ({
            id: t.id,
            machine: t.machine?.id ?? "xmp.sampler",
            clips: t.clips.map((cl) => ({ id: cl.id, steps: cl.steps.length })),
          })),
          songParts: p.performance?.chain.length,
          songChain: p.performance?.chain.map((part) => part.sceneId),
          persistedInGuest: true,
        };
      } else if (c.op === "arm-test" || c.op === "arm-parity") {
        const manifest = JSON.parse(readFileSync("/opt/xmp/arm/manifest.json", "utf8"));
        for (const [name, entry] of Object.entries(manifest.binaries) as [
          string,
          { sha256: string },
        ][]) {
          if (
            !/^xmp_(parity_render|sampler_test|engine_test)$/.test(name) ||
            hash(readFileSync(`/opt/xmp/arm/bin/${name}`)) !== entry.sha256
          )
            throw new Error("ARM binary identity");
        }
        const work = mkdtempSync("/run/arm-case-");
        const run = (name: string, args: string[]) => {
          process.stderr.write(`XMPARM ${name} ${args[0] ?? "sampler"}\n`);
          try {
            // On the ARMv7 image the binaries run natively on the az01 kernel.
            return execFileSync(
              nativeArm ? `/opt/xmp/arm/bin/${name}` : "/usr/bin/qemu-arm",
              nativeArm
                ? args
                : ["-cpu", "cortex-a15", "-strace", `/opt/xmp/arm/bin/${name}`, ...args],
              {
                timeout: 60000,
                cwd: work,
                encoding: "utf8",
                maxBuffer: 65536,
              },
            );
          } catch (e) {
            const error = e as { stderr?: string; status?: number; signal?: string };
            process.stderr.write(String(error.stderr ?? "").slice(-2000));
            throw Object.assign(
              new Error(`ARM execution failed: ${name} ${args[0] ?? "sampler"}`),
              { exitStatus: error.status, signal: error.signal },
            );
          }
        };
        const identity = {
          target: manifest.target,
          execution: nativeArm
            ? "native-armv7-official-az01-kernel"
            : "qemu-arm-inside-linux-guest",
          sourceHash: manifest.sourceHash,
          physicalAccess: false,
          mpcBootable: false,
        };
        if (c.op === "arm-test") {
          result = {
            ...identity,
            name: c.name,
            output: run(
              c.name === "sampler" ? "xmp_sampler_test" : "xmp_engine_test",
              c.name === "sampler" ? [] : [c.name],
            )
              .trim()
              .slice(-512),
          };
        } else {
          const parity = [];
          for (const f of parityFixtures()) {
            writeFileSync(join(work, `${f.id}.plan`), encodePlan(f.plan));
            run("xmp_parity_render", [`${f.id}.plan`, `${f.id}.result`]);
            const native = decodeResult(readFileSync(join(work, `${f.id}.result`))),
              reference = referenceParity(f.plan);
            verifyParityOracle(f.id, native);
            parity.push({ id: f.id, ...compareParity(reference, native) });
          }
          writeFileSync(join(work, "bad.plan"), Buffer.from("bad"));
          let malformedRejected = false;
          try {
            run("xmp_parity_render", ["bad.plan", "bad.result"]);
          } catch (e) {
            const rejected = e as { exitStatus?: number; signal?: string };
            if (rejected.exitStatus !== 4 || rejected.signal) throw e;
            malformedRejected = true;
          }
          if (!malformedRejected) throw new Error("Malformed ARM plan accepted");
          result = {
            ...identity,
            parity,
            malformedRejected,
          };
        }
      } else if (c.op === "hardware-probe") {
        // Read-only discovery plus the G1-built hardware tools (ARM image only).
        const g1 = (args: string[]) => {
          try {
            return execFileSync(`/opt/g1/bin/${args[0]}`, args.slice(1), {
              timeout: 30000,
              encoding: "utf8",
              maxBuffer: 16384,
              env: { PATH: "/opt/g1/bin", ALSA_CONFIG_DIR: "/opt/g1/share/alsa" },
            }).slice(-400);
          } catch (e) {
            return `error: ${String((e as { status?: number }).status ?? e)}`;
          }
        };
        result = {
          profile: probeHardware(systemReader()),
          g1: nativeArm
            ? {
                aplay: g1(["aplay", "-l"]),
                amixer: g1(["amixer", "-c", "0", "scontrols"]),
                gpiodetect: g1(["gpiodetect"]),
                listdevs: g1(["listdevs"]),
              }
            : null,
          physicalAccess: false,
        };
      } else if (c.op === "shutdown") {
        await cdp("Browser.close", {}, "");
        await Promise.race([browserExit, new Promise((r) => setTimeout(r, 3000))]);
        // Only this owned guest browser's process group; never a host process.
        try {
          if (browser.pid) process.kill(-browser.pid, "SIGTERM");
        } catch {}
        await new Promise((r) => setTimeout(r, 200));
        try {
          if (browser.pid) process.kill(-browser.pid, "SIGKILL");
        } catch {}
        await browserExit;
        // Crashpad may start its own session; it also holds the guest profile disk.
        stopGuestBrowserHelpers("SIGTERM");
        await new Promise((r) => setTimeout(r, 200));
        stopGuestBrowserHelpers("SIGKILL");
        server.close();
        input.close();
      }
      emit({ id, ok: true, result });
      if (c.op === "shutdown") setTimeout(() => process.exit(0), 50);
    } catch (e) {
      emit({ id, ok: false, error: "DEVICE_COMMAND_REJECTED" });
      process.stderr.write(`${String(e).slice(0, 240)}\n`);
    }
  });
});
