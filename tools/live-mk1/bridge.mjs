import { execFileSync, spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  writeSync,
} from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { join, relative, resolve } from "node:path";
import { ReadStream } from "node:tty";
import { deflateSync } from "node:zlib";
import { root } from "../../acceptance/lib/workspace.mjs";
import { prepareStickToken } from "./stick-token.mjs";
import { verifyOwnerImage } from "./verify-owner-image.mjs";

// The Mac side of the XMP control bridge (AGENTS.md authorizations 3 and 4).
// It talks over exactly one link: the USB-to-USB null-modem cable (an FTDI
// FT232R at each end, 0403:6001) between a USB-A port on the Live and the Mac
// (authorization 3's link amendment), or the XMP bridge gadget (USB 1209:0001,
// "XMP bridge") on the Live's USB-B port, or, for tests, the emulator's
// socket. It refuses Akai devices (09e8:*) and anything that is not exactly
// one link, says hello with the stick's token, and logs every command in
// reports/live-mk1/.
//
//   npm run live:bridge -- status | log | screenshot [out.png] | record [seconds]
//                          | input "<line>" | script FILE | push [system.img]
//                          | restart | reboot | power-off | prepare-stick
//   (add --socket PATH to use the emulator's bridge socket)

export const BRIDGE_ID = { vendor: 0x1209, product: 0x0001, name: "XMP bridge" };
export const CABLE_ID = {
  vendor: 0x0403,
  product: 0x6001,
  name: "FTDI USB-to-USB null-modem cable",
};
// The cable runs at 921600 baud with hardware flow control, as the Live's end does.
export const CABLE_BAUD = 921600;
const AKAI_VENDOR = 0x09e8;
const TOKEN_FILE = join(root, "artifacts/live-mk1/bridge-token");
const MAX_FRAME = 64 * 1024 * 1024;

// ---- device discovery (read-only macOS USB registry) ----
// Parses `ioreg -r -c IOUSBHostDevice -l -w0`: one block per USB device, with
// its properties and the serial callout of any CDC-ACM child.
export function parseIoreg(text) {
  const devices = [];
  let current = null;
  for (const line of text.split("\n")) {
    // With -r every matching device is printed as its own root block.
    const start = /^\+-o (.+?)@.*<class IOUSBHostDevice/.exec(line);
    if (start) {
      current = { name: start[1], vendor: null, product: null, callouts: [] };
      devices.push(current);
      continue;
    }
    if (!current) continue;
    const vendor = /"idVendor" = (\d+)/.exec(line);
    if (vendor && current.vendor === null) current.vendor = Number(vendor[1]);
    const product = /"idProduct" = (\d+)/.exec(line);
    if (product && current.product === null) current.product = Number(product[1]);
    const callout = /"IOCalloutDevice" = "([^"]+)"/.exec(line);
    if (callout) current.callouts.push(callout[1]);
  }
  return devices;
}

// Exactly one XMP bridge; never an Akai device.
export function chooseBridge(devices) {
  const bridges = devices.filter(
    (d) => d.vendor === BRIDGE_ID.vendor && d.product === BRIDGE_ID.product,
  );
  if (bridges.length === 0)
    throw new Error(
      "No XMP bridge on USB: switch the Live on with the XMP stick and connect its USB-B port to the Mac",
    );
  if (bridges.length > 1)
    throw new Error("More than one XMP bridge is connected; connect only one Live");
  const [bridge] = bridges;
  if (bridge.vendor === AKAI_VENDOR) throw new Error("Refusing an Akai device");
  const callouts = bridge.callouts.filter((c) => /^\/dev\/cu\.usbmodem[\w.-]+$/.test(c));
  if (callouts.length !== 1)
    throw new Error("The XMP bridge has no single serial port yet; wait a moment and retry");
  return callouts[0];
}

// Exactly one link: the FTDI cable, else the gadget; never an Akai device.
export function chooseLink(devices) {
  const cables = devices.filter(
    (d) => d.vendor === CABLE_ID.vendor && d.product === CABLE_ID.product,
  );
  const bridges = devices.filter(
    (d) => d.vendor === BRIDGE_ID.vendor && d.product === BRIDGE_ID.product,
  );
  if (cables.length > 1)
    throw new Error("More than one FTDI cable is connected; connect only the one to the Live");
  if (cables.length === 1 && bridges.length > 0)
    throw new Error("Both the FTDI cable and the USB-B bridge are connected; unplug one");
  if (cables.length === 0) return { kind: "gadget", port: chooseBridge(devices) };
  const [cable] = cables;
  if (cable.vendor === AKAI_VENDOR) throw new Error("Refusing an Akai device");
  const callouts = cable.callouts.filter((c) => /^\/dev\/cu\.usbserial-[\w.-]+$/.test(c));
  if (callouts.length !== 1)
    throw new Error("The FTDI cable has no single serial port yet; wait a moment and retry");
  return { kind: "cable", port: callouts[0] };
}

function findLink() {
  const text = execFileSync("ioreg", ["-r", "-c", "IOUSBHostDevice", "-l", "-w0"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return chooseLink(parseIoreg(text));
}

// ---- framing: 4-byte big-endian length + payload ----
export function frame(payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (body.length > MAX_FRAME) throw new Error("Frame too large");
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length);
  return Buffer.concat([head, body]);
}

export class FrameReader {
  constructor() {
    this.buffer = Buffer.alloc(0);
    this.waiting = [];
    this.frames = [];
  }
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < 4) return;
      const size = this.buffer.readUInt32BE(0);
      if (size > MAX_FRAME) throw new Error("Bridge sent an oversized frame");
      if (this.buffer.length < 4 + size) return;
      const body = this.buffer.subarray(4, 4 + size);
      this.buffer = this.buffer.subarray(4 + size);
      const waiter = this.waiting.shift();
      if (waiter) waiter.resolve(body);
      else this.frames.push(body);
    }
  }
  next(timeoutMs = 15000) {
    if (this.frames.length) return Promise.resolve(this.frames.shift());
    return new Promise((resolveFrame, reject) => {
      const timer = setTimeout(() => reject(new Error("Bridge did not answer in time")), timeoutMs);
      this.waiting.push({
        resolve: (b) => {
          clearTimeout(timer);
          resolveFrame(b);
        },
      });
    });
  }
}

// ---- connection ----
async function drainLine(fd) {
  const chunk = Buffer.alloc(65536);
  const until = Date.now() + 300000;
  let quietSince = Date.now();
  while (Date.now() < until && Date.now() - quietSince < 500) {
    try {
      if (readSync(fd, chunk, 0, chunk.length, null) > 0) quietSince = Date.now();
    } catch (error) {
      if (error.code !== "EAGAIN") throw error;
      await new Promise((wait) => setTimeout(wait, 20));
    }
  }
}

export async function openBridge({ socket = null, token = null, log = null } = {}) {
  const reader = new FrameReader();
  let write;
  let close;
  if (socket) {
    const s = connect(socket);
    await new Promise((ok, fail) => {
      s.once("connect", ok);
      s.once("error", fail);
    });
    s.on("data", (c) => reader.push(c));
    write = (b) => new Promise((ok) => s.write(b, ok));
    close = () => s.destroy();
  } else {
    const { kind, port } = findLink();
    // Open first (O_NONBLOCK keeps a cable without carrier from blocking), then
    // set the line: the cable at 921600 baud with RTS/CTS flow control.
    const fd = openSync(port, constants.O_RDWR | constants.O_NOCTTY | constants.O_NONBLOCK);
    const args =
      kind === "cable"
        ? [
            "-f",
            port,
            "raw",
            "-echo",
            "clocal",
            "crtscts",
            "cs8",
            "-parenb",
            "-cstopb",
            String(CABLE_BAUD),
          ]
        : ["-f", port, "raw", "-echo", "115200"];
    const set = spawnSync("stty", args, { encoding: "utf8", timeout: 10000 });
    if (set.status !== 0) {
      closeSync(fd);
      throw new Error(`Could not set up ${port}: ${(set.stderr || "").trim()}`);
    }
    // Whatever a broken earlier connection left on the line (the rest of a
    // large reply) is drained first: until the line is quiet for half a
    // second, or 5 minutes at most.
    if (kind === "cable") await drainLine(fd);
    const stream = new ReadStream(fd);
    stream.on("data", (c) => reader.push(c));
    write = async (b) => {
      for (let at = 0; at < b.length; ) {
        try {
          at += writeSync(fd, b, at, Math.min(65536, b.length - at));
        } catch (error) {
          // Flow control holds the line (the cable's RTS/CTS): wait and go on.
          if (error.code !== "EAGAIN") throw error;
          await new Promise((wait) => setTimeout(wait, 2));
        }
      }
    };
    close = () => {
      stream.destroy();
      try {
        closeSync(fd);
      } catch {}
    };
  }
  const record = async (line) => {
    if (log) await appendFile(log, `${new Date().toISOString()} ${line}\n`);
  };
  const request = async (object, timeoutMs) => {
    await record(`> ${JSON.stringify(object)}`);
    await write(frame(JSON.stringify(object)));
    const reply = JSON.parse((await reader.next(timeoutMs)).toString("utf8"));
    await record(`< ${JSON.stringify(reply)}`);
    return reply;
  };
  // Replies still queued from a broken earlier connection come first: they
  // are skipped until the hello's own (which names the board).
  await record(`> {"cmd":"hello"}`);
  await write(frame(JSON.stringify({ cmd: "hello", token: token ?? "" })));
  let hello = { ok: false, error: "no hello reply" };
  for (let skipped = 0; skipped < 256; skipped++) {
    let reply;
    try {
      reply = JSON.parse((await reader.next(30000)).toString("utf8"));
    } catch (error) {
      if (/did not answer/.test(error.message)) {
        close();
        throw error;
      }
      continue; // a stale binary frame (a screenshot's or a log's)
    }
    if (reply.board !== undefined || reply.error) {
      hello = reply;
      break;
    }
    await record(`< (stale) ${JSON.stringify(reply)}`);
  }
  if (hello.ok !== true || hello.protocol !== 1) {
    close();
    throw new Error(`Bridge refused hello/protocol: ${hello.error ?? hello.protocol}`);
  }
  if (
    typeof hello.board !== "string" ||
    !hello.board.split(/[\s\0]+/).includes("inmusic,acv8") ||
    /force|ada2/i.test(hello.board)
  ) {
    close();
    throw new Error(`Bridge board is not the MPC Live Mk1: ${hello.board}`);
  }
  return { hello, request, binary: (t) => reader.next(t), write, close, record };
}

// A system image without its empty space, for the bridge's push: records of
// [kind, 1 byte][length, 4 bytes big-endian], kind 0 a run of zero bytes and
// kind 1 that many bytes of data, in whole 4 KiB blocks.
export function packSparse(bytes, block = 4096) {
  const parts = [];
  const record = (kind, length) => {
    const head = Buffer.alloc(5);
    head[0] = kind;
    head.writeUInt32BE(length, 1);
    parts.push(head);
  };
  const empty = (at) => {
    const end = Math.min(bytes.length, at + block);
    for (let i = at; i < end; i++) if (bytes[i] !== 0) return false;
    return true;
  };
  for (let at = 0; at < bytes.length; ) {
    const kind = empty(at) ? 0 : 1;
    let end = at + block;
    while (end < bytes.length && (empty(end) ? 0 : 1) === kind) end += block;
    end = Math.min(end, bytes.length);
    record(kind, end - at);
    if (kind === 1) parts.push(bytes.subarray(at, end));
    at = end;
  }
  return Buffer.concat(parts);
}
// ---- images ----
// A run-length encoded framebuffer (runs of [count, 2 bytes big-endian][pixel,
// 4 bytes]) back to `size` bytes of pixels. Refuses anything that does not
// decode to exactly that size.
export function unpackRle(packed, size) {
  if (!Number.isInteger(size) || size <= 0 || size > 64 * 1024 * 1024 || packed.length % 6 !== 0)
    throw new Error("Screenshot is not a run-length encoded framebuffer");
  const raw = Buffer.alloc(size);
  let at = 0;
  for (let i = 0; i < packed.length; i += 6) {
    const run = packed.readUInt16BE(i);
    if (run === 0 || at + run * 4 > size) throw new Error("Screenshot runs exceed the screen");
    const pixel = packed.readUInt32LE(i + 2);
    for (let k = 0; k < run; k++, at += 4) raw.writeUInt32LE(pixel, at);
  }
  if (at !== size) throw new Error("Screenshot is shorter than the screen");
  return raw;
}
// Framebuffer (XRGB, portrait) to a landscape PNG for rotation 270.
export function screenshotPng(
  raw,
  { width, height, red = 16, green = 8, blue = 0 },
  rotation = 270,
) {
  const turned = rotation === 90 || rotation === 270;
  const w = turned ? height : width,
    h = turned ? width : height;
  const rows = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    rows[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const [fx, fy] =
        rotation === 270 ? [y, height - 1 - x] : rotation === 90 ? [width - 1 - y, x] : [x, y];
      const v = raw.readUInt32LE((fy * width + fx) * 4);
      const at = y * (w * 3 + 1) + 1 + x * 3;
      rows[at] = (v >> red) & 255;
      rows[at + 1] = (v >> green) & 255;
      rows[at + 2] = (v >> blue) & 255;
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b) => {
    let c = 0xffffffff;
    for (const byte of b) c = crcTable[(c ^ byte) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- commands ----
export async function bridgeCommand(bridge, command, args, outDir, { timeoutScale = 1 } = {}) {
  const out = (name) => join(outDir, name);
  const t = (ms) => ms * timeoutScale;
  switch (command) {
    case "status":
      return bridge.request({ cmd: "status" }, t(15000));
    case "log": {
      const reply = await bridge.request({ cmd: "log" }, t(15000));
      if (!reply.ok) return reply;
      const text = await bridge.binary(t(60000));
      await writeFile(out("session-log.txt"), text);
      return { ...reply, saved: out("session-log.txt"), text: text.toString("utf8") };
    }
    case "screenshot": {
      // Run-length encoded when the Live's bridge can (an older one sends 4 MB
      // of raw pixels, about 45 s over the cable).
      const reply = await bridge.request({ cmd: "screenshot", rle: 1 }, t(15000));
      if (!reply.ok) return reply;
      const sent = await bridge.binary(t(240000));
      const raw = reply.encoding === "rle" ? unpackRle(sent, reply.width * reply.height * 4) : sent;
      const file = args[0] ? resolve(args[0]) : out(`screenshot-${Date.now()}.png`);
      await writeFile(file, screenshotPng(raw, reply));
      return { ...reply, saved: file };
    }
    case "record": {
      const seconds = Number(args[0] ?? 3);
      const reply = await bridge.request({ cmd: "record", seconds }, t(seconds * 1000 + 30000));
      if (!reply.ok) return reply;
      const wav = await bridge.binary(t(60000));
      const file = args[1] ? resolve(args[1]) : out(`record-${Date.now()}.wav`);
      await writeFile(file, wav);
      return { ...reply, saved: file };
    }
    case "input":
      return bridge.request({ cmd: "input", line: args.join(" ") }, t(15000));
    case "script": {
      // Lines: "wait <seconds>" or an input line (pad N V | button HH [down|up] | control HH VV | touch X Y).
      const results = [];
      for (const line of (await readFile(resolve(args[0]), "utf8")).split("\n")) {
        const text = line.trim();
        if (!text || text.startsWith("#")) continue;
        const wait = /^wait (\d+(?:\.\d+)?)$/.exec(text);
        if (wait) await new Promise((r) => setTimeout(r, Math.min(60, Number(wait[1])) * 1000));
        else results.push(await bridge.request({ cmd: "input", line: text }));
      }
      return { ok: results.every((r) => r.ok), inputs: results.length };
    }
    case "push": {
      const image = resolve(args[0] ?? (await latestSystemImage()));
      const { bytes, sha256, manifest, manifestSha256 } = await verifyOwnerImage(image);
      if (bridge.hello?.imageUpdateProfile !== "xmp-owner-image-v1")
        throw new Error(
          "This bridge needs the corrected update implementation. Power off and copy the verified owner image to the USB stick on the Mac first.",
        );
      const state = await bridge.request({ cmd: "status" }, t(15000));
      if (
        !state.ok ||
        state.session?.playing !== false ||
        state.session?.recording !== false ||
        state.session?.saveState !== "saved"
      )
        throw new Error("Stop and wait for Saved on stick before updating");
      const ready = await bridge.request(
        {
          cmd: "push-image",
          profile: "xmp-owner-image-v1",
          target: manifest.target,
          mpcOsVersion: manifest.mpcOsVersion,
          sourceHash: manifest.sourceHash,
          manifestSha256,
          size: bytes.length,
          sha256,
          sparse: 1,
        },
        t(15000),
      );
      if (!ready.ok) return ready;
      // Without its empty space when the Live's bridge can (an older one takes
      // the whole image: 24 MB, 4.5 minutes over the cable).
      const sent = ready.sparse === true ? packSparse(bytes) : bytes;
      await bridge.record(`> [${bytes.length} image bytes, ${sent.length} sent]`);
      await bridge.write(frame(sent));
      const done = JSON.parse((await bridge.binary(t(600000))).toString("utf8"));
      await bridge.record(`< ${JSON.stringify(done)}`);
      return { ...done, image: relative(root, image), bytes: bytes.length, sent: sent.length };
    }
    case "restart":
    case "reboot":
    case "power-off":
      return bridge.request({ cmd: command }, t(15000));
    default:
      throw new Error(`Unknown bridge command ${command}`);
  }
}

async function latestSystemImage() {
  const pointer = join(root, "artifacts/live-mk1/latest-owner-session-image.json");
  if (!existsSync(pointer))
    throw new Error("Assemble the owner-local image first: npm run live:assemble");
  return join(resolve(root, JSON.parse(await readFile(pointer, "utf8")).directory), "system.img");
}

// The token the bridge requires, shared through the stick. prepare-stick
// writes it to xmp/bridge.token on a mounted XMP stick and keeps the Mac copy.
export async function prepareStick() {
  const volumes = readdirSync("/Volumes").filter((v) => v === "XMP" || v === "XMPPROBE");
  if (volumes.length !== 1)
    throw new Error("Mount exactly one XMP stick (label XMP or XMPPROBE) on the Mac");
  await prepareStickToken(join("/Volumes", volumes[0]), TOKEN_FILE);
  return { ok: true, stick: volumes[0] };
}

export const readToken = (file = TOKEN_FILE) =>
  existsSync(file) ? readFileSync(file, "utf8").trim() : "";

if (process.argv[1] === import.meta.filename) {
  const args = process.argv.slice(2);
  let socket = null;
  const socketAt = args.indexOf("--socket");
  if (socketAt >= 0) {
    socket = resolve(args[socketAt + 1] ?? "");
    args.splice(socketAt, 2);
  }
  const [command, ...rest] = args;
  if (!command)
    throw new Error(
      "Usage: npm run live:bridge -- <command> (status, log, screenshot, record, input, script, push, restart, reboot, power-off, prepare-stick)",
    );
  if (command === "prepare-stick") {
    console.log(JSON.stringify(await prepareStick(), null, 2));
  } else {
    const outDir = join(root, "reports/live-mk1/bridge");
    await mkdir(outDir, { recursive: true });
    const log = join(
      root,
      "reports/live-mk1",
      `bridge-${new Date().toISOString().slice(0, 10)}.log`,
    );
    // Refuse bad images before discovery or opening a hardware connection.
    if (command === "push") await verifyOwnerImage(resolve(rest[0] ?? (await latestSystemImage())));
    const bridge = await openBridge({ socket, token: readToken(), log });
    try {
      const result = await bridgeCommand(bridge, command, rest, outDir);
      if (result.text) {
        process.stdout.write(result.text);
        delete result.text;
      }
      console.log(JSON.stringify(result, null, 2));
    } finally {
      bridge.close();
    }
  }
}
