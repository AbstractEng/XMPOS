// The XMP Device app on the owner's MPC Live Mk1 (phase 3; AGENTS.md
// authorizations 2-4). Started by os/live-mk1/live-init from the XMP stick.
//
//   - serves the Device app read-only on loopback only (127.0.0.1:8080)
//   - runs Chromium full-screen in cage (a kiosk Wayland compositor) on the
//     Live's own panel, turned to landscape, with the touchscreen through libinput
//   - relays pads, buttons, knobs and the data wheel from xmp-live-input (the
//     only process that opens the controller) to the app over a same-origin
//     WebSocket (/hardware); Chromium itself has no MIDI, USB or HID access
//   - plays through ALSA "default", which live-init points at the allowed card
//     through a soft volume capped at -12 dB, or at nothing
import { execFile, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { connect, type Socket } from "node:net";
import { join } from "node:path";

const STICK = "/media/xmp/xmp";
const LOG = process.env.XMP_LIVE_LOG ?? `${STICK}/logs/device.txt`;
const started = Date.now();
function say(line: string) {
  const text = `${((Date.now() - started) / 1000).toFixed(3).padStart(9)} ${line}`;
  console.log(`XMP-DEVICE ${line}`);
  try {
    appendFileSync(LOG, `${text}\n`);
  } catch {
    /* the stick may be gone */
  }
}

// ---- the board and the network must be what the authorizations allow ----
const compatible = readFileSync("/proc/device-tree/compatible", "latin1").replaceAll("\0", " ");
if (!compatible.includes("inmusic,acv8") || /force|ada2/i.test(compatible)) {
  say(`refusing: board is not the MPC Live Mk1 (${compatible.trim()})`);
  process.exit(3);
}
// Only loopback may be up (the kernel's own inactive tunnel devices, such as
// sit0, exist without carrying anything).
const up = (
  existsSync("/sys/class/net")
    ? spawnSync("ls", ["/sys/class/net"], { encoding: "utf8" }).stdout.split(/\s+/).filter(Boolean)
    : []
).filter((name) => {
  try {
    return (
      name !== "lo" &&
      (Number.parseInt(readFileSync(`/sys/class/net/${name}/flags`, "utf8"), 16) & 1) === 1
    );
  } catch {
    return false;
  }
});
say(
  `board ${compatible.trim()}; network interfaces up besides loopback: ${up.join(" ") || "none"}`,
);

// ---- read-only asset server, loopback only, plus the hardware WebSocket ----
const root = "/opt/xmp/studio",
  origin = "http://127.0.0.1:8080";
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
    res.writeHead(200, {
      "Content-Type": types[path.split(".").at(-1) ?? ""] ?? "application/octet-stream",
      "Permissions-Policy": "midi=(), usb=(), hid=(), serial=(), microphone=(), camera=()",
      "Content-Security-Policy":
        "default-src 'self' blob: data:; script-src 'self' blob: 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:8080; frame-src 'none'; object-src 'none'",
    });
    res.end(readFileSync(path));
  } catch {
    res.writeHead(404);
    res.end();
  }
});

// Minimal RFC 6455 server side: text frames out, close/ping in, nothing else.
const clients = new Set<Socket>();
function frame(text: string) {
  const body = Buffer.from(text);
  const head =
    body.length < 126
      ? Buffer.from([0x81, body.length])
      : Buffer.from([0x81, 126, body.length >> 8, body.length & 255]);
  return Buffer.concat([head, body]);
}
server.on("upgrade", (req: IncomingMessage, socket: Socket) => {
  const key = req.headers["sec-websocket-key"];
  const fromApp = req.headers.origin === origin;
  if (
    new URL(req.url ?? "/", origin).pathname !== "/hardware" ||
    typeof key !== "string" ||
    !fromApp
  ) {
    say(`refused a WebSocket upgrade (${req.url}, origin ${req.headers.origin ?? "none"})`);
    socket.destroy();
    return;
  }
  const accept = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  clients.add(socket);
  say(`app connected to /hardware (${clients.size})`);
  // A marker for tests (the emulator's twin waits for it before playing input).
  try {
    writeFileSync("/tmp/xmp-app-ready", "1\n");
  } catch {
    /* tmpfs only */
  }
  socket.on("data", (d: Buffer) => {
    const opcode = (d[0] ?? 0) & 15;
    if (opcode === 8) return socket.end(); // close
    // Small masked text frames from the page: its errors, for the device log.
    const length = (d[1] ?? 0) & 127;
    if (opcode !== 1 || !((d[1] ?? 0) & 128) || length > 125 || d.length < 6 + length) return;
    const mask = d.subarray(2, 6),
      body = Buffer.alloc(length);
    for (let i = 0; i < length; i++) body[i] = (d[6 + i] ?? 0) ^ (mask[i % 4] ?? 0);
    if (pageLines++ < 200) say(`page: ${body.toString("utf8").replace(/[^\x20-\x7e]/g, "?")}`);
  });
  socket.on("close", () => clients.delete(socket));
  socket.on("error", () => clients.delete(socket));
});
await new Promise<void>((resolve) => server.listen(8080, "127.0.0.1", resolve));
say("app server on 127.0.0.1:8080 (loopback only)");

// ---- events from xmp-live-input ----
let powerRequested = false;
let forwarded = 0;
let pageLines = 0;
function relay() {
  const input = connect("/tmp/xmp-input.sock");
  let pending = "";
  input.on("connect", () => say("connected to xmp-live-input"));
  input.on("data", (chunk) => {
    pending += chunk.toString("utf8");
    if (pending.length > 65536) pending = "";
    for (let at = pending.indexOf("\n"); at >= 0; at = pending.indexOf("\n")) {
      const line = pending.slice(0, at);
      pending = pending.slice(at + 1);
      let event: { t?: string } | undefined;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event?.t === "power") {
        powerRequested = true;
        say("power button: shutting down");
        shutdown();
        return;
      }
      if (forwarded++ < 50) say(`hardware event to the app: ${line}`);
      for (const client of clients) client.write(frame(line));
    }
  });
  input.on("error", () => {});
  input.on("close", () => {
    if (!powerRequested) setTimeout(relay, 500);
  });
}
relay();

// ---- Chromium full-screen in cage on the Live's panel ----
mkdirSync("/data/chromium", { recursive: true });
mkdirSync(`${STICK}/songs`, { recursive: true });
const runtime = "/tmp/xdg";
mkdirSync(runtime, { recursive: true, mode: 0o700 });
const env = {
  ...process.env,
  XDG_RUNTIME_DIR: runtime,
  LIBSEAT_BACKEND: "seatd",
  WLR_RENDERER: process.env.WLR_RENDERER ?? "pixman", // software first; the GPU is phase 4
  WLR_LIBINPUT_NO_DEVICES: "1",
};
const url = `${origin}/?view=device&hardware=live-mk1`;
const cage = spawn(
  "/usr/bin/cage",
  [
    "-s",
    "--",
    "/usr/lib/chromium/chromium",
    "--ozone-platform=wayland",
    "--kiosk",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--no-first-run",
    "--no-default-browser-check",
    "--noerrdialogs",
    "--disable-pinch",
    "--overscroll-history-navigation=0",
    "--touch-events=enabled",
    "--autoplay-policy=no-user-gesture-required",
    "--alsa-output-device=default",
    `--download-default-directory=${STICK}/songs`,
    "--user-data-dir=/data/chromium",
    url,
  ],
  { env, stdio: ["ignore", "pipe", "pipe"] },
);
cage.stderr.on("data", (d: Buffer) => {
  const text = d.toString("utf8").trim();
  for (const part of text.split("\n"))
    if (
      /error|fail|cannot|unable|alsa|audio|pcm|CONSOLE/i.test(part) &&
      !/dbus|UPower|GLib|xwayland/i.test(part)
    )
      say(`cage/chromium: ${part.slice(0, 300)}`);
});
say(`cage started, Chromium on ${url}`);

// Rotate the panel to landscape once the compositor is up (the Live's panel is
// portrait, mounted turned: hardware.json display.rotation = 270).
// Never blocks the event loop: each wlr-randr call is asynchronous and killed
// after 5 s (a compositor that is still starting can accept a connection and
// not answer, and a synchronous call would then freeze the whole service).
function randr(args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(
      "/usr/bin/wlr-randr",
      args,
      { env: { ...env, WAYLAND_DISPLAY: "wayland-0" }, timeout: 5000, encoding: "utf8" },
      (error, out, err) => resolve({ ok: !error, out: out ?? "", err: err ?? "" }),
    );
  });
}
async function rotate() {
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const list = await randr([]);
    const name = /^(\S+)/m.exec(list.out)?.[1];
    if (!list.ok || !name) continue;
    const set = await randr(["--output", name, "--transform", "90"]);
    say(`display ${name} turned to landscape (${set.ok ? "ok" : set.err.trim() || "timed out"})`);
    return;
  }
  say("display: compositor did not come up for rotation within 2 minutes");
}
void rotate();

function shutdown() {
  cage.kill("SIGTERM");
  setTimeout(() => process.exit(0), 3000);
}
cage.once("exit", (code) => {
  say(`cage exited (${code})`);
  process.exit(powerRequested ? 0 : 1);
});
process.on("SIGTERM", shutdown);
