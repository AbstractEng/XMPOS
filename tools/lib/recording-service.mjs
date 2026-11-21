import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireMacBookDevice } from "../../packages/core/src/acoustic.ts";
import { decodeSampleWav } from "../../packages/core/src/recording.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
export function createRecordingService({
  inspect,
  launch,
  baseDirectory = resolve(root, "reports/recordings"),
  platform = process.platform,
  ci = Boolean(process.env.CI),
} = {}) {
  const sessions = new Map();
  let active = false;
  const helper = resolve(root, "build/native/xmp_acoustic_capture");
  inspect ??= () => {
    const r = spawnSync(helper, ["--inspect"], {
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 65536,
    });
    if (r.status !== 0)
      throw new Error("Build native tools and grant microphone access before recording");
    return JSON.parse(r.stdout);
  };
  launch ??= (directory, done) => {
    const child = spawn(helper, ["--record", directory], {
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 15000,
    });
    let finished = false;
    const finish = () => {
      if (!finished) {
        finished = true;
        done();
      }
    };
    child.once("error", finish);
    child.once("exit", finish);
    return child;
  };
  const input = () => {
    if (platform !== "darwin" || ci)
      throw new Error("Mac recording is unavailable in this profile");
    const inventory = inspect();
    requireMacBookDevice(inventory.input, true);
    return inventory.input;
  };
  return {
    input,
    start(bpm) {
      if (active) throw new Error("A recording is already active");
      if (sessions.size >= 16)
        throw new Error("Recording session budget reached; restart the local server");
      if (!Number.isFinite(bpm) || bpm < 30 || bpm > 300)
        throw new Error("Invalid recording tempo");
      const source = input(),
        frames = Math.round(((8 * 60) / bpm) * source.sampleRate);
      if (frames > 480000 || frames / source.sampleRate > 10)
        throw new Error("Two bars exceed the recording budget");
      mkdirSync(baseDirectory, { recursive: true });
      const directory = mkdtempSync(resolve(baseDirectory, "take-"));
      chmodSync(directory, 0o700);
      writeFileSync(resolve(directory, "record.json"), JSON.stringify({ frames }));
      const id = randomUUID();
      sessions.set(id, { directory, source, frames, done: false });
      active = true;
      try {
        launch(directory, () => {
          active = false;
          const session = sessions.get(id);
          if (session) session.done = true;
        });
      } catch (error) {
        active = false;
        sessions.delete(id);
        throw error;
      }
      return { id, frames, sampleRate: source.sampleRate };
    },
    status(id) {
      const session = sessions.get(id);
      if (!session) throw new Error("Unknown recording session");
      let meter = { peak: 0, frames: 0 };
      try {
        meter = JSON.parse(readFileSync(resolve(session.directory, "meter.json"), "utf8"));
      } catch {}
      let report;
      try {
        report = JSON.parse(
          readFileSync(resolve(session.directory, "device-capture.json"), "utf8"),
        );
      } catch {}
      if (session.done && !report)
        return {
          state: "failed",
          reason: "Native recorder failed; no take was committed",
          peak: 0,
        };
      return {
        state: session.done ? (report?.outcome ?? "failed") : "recording",
        peak: meter.peak,
        frames: report?.inputFrames ?? meter.frames,
        targetFrames: session.frames,
        reason: report?.reason,
        io:
          session.done && report
            ? {
                input: report.input,
                outputStreamsStarted: report.outputStreamsStarted,
                inputStreamsStarted: report.inputStreamsStarted,
                streamsStopped: report.streamsStopped,
                callbackErrors: report.callbackErrors,
                protectedDeviceOperations: report.protectedDeviceOperations,
              }
            : undefined,
        hasTake: existsSync(resolve(session.directory, "capture.wav")),
      };
    },
    take(id) {
      const session = sessions.get(id);
      if (!session?.done) throw new Error("Take is not finalized");
      const status = this.status(id);
      if (!status.hasTake) throw new Error("No valid recorded take");
      const bytes = readFileSync(resolve(session.directory, "capture.wav"));
      const decoded = decodeSampleWav(bytes),
        report = JSON.parse(
          readFileSync(resolve(session.directory, "device-capture.json"), "utf8"),
        );
      requireMacBookDevice(report.input, true);
      if (
        report.input.id !== session.source.id ||
        report.input.uid !== session.source.uid ||
        report.input.sampleRate !== session.source.sampleRate ||
        report.streamsStopped !== true ||
        report.outputStreamsStarted !== 0 ||
        report.inputStreamsStarted !== 1 ||
        report.inputFrames !== decoded.pcm.length ||
        decoded.sampleRate !== session.source.sampleRate ||
        decoded.pcm.length > session.frames ||
        !["recorded", "interrupted"].includes(report.outcome)
      )
        throw new Error("Native take identity, duration or cleanup mismatch");
      return bytes;
    },
  };
}
export function recordingPlugin() {
  return {
    name: "xmp-local-recording",
    configureServer(server) {
      const service = createRecordingService();
      server.middlewares.use("/api/recording", async (req, res) => {
        const send = (code, value) => {
          res.statusCode = code;
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Cache-Control", "no-store");
          res.end(JSON.stringify(value));
        };
        try {
          const host = req.headers.host,
            origin = req.headers.origin,
            remote = req.socket.remoteAddress;
          if (
            !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote) ||
            !["127.0.0.1:5173", "localhost:5173"].includes(host) ||
            (origin && origin !== `http://${host}`) ||
            req.headers["sec-fetch-site"] === "cross-site" ||
            (req.method === "POST" && origin !== `http://${host}`)
          )
            return send(403, { error: "Same-origin local recording only" });
          const url = new URL(req.url, "http://127.0.0.1:5173");
          if (req.method === "GET" && url.pathname === "/input") return send(200, service.input());
          if (req.method === "GET" && url.pathname === "/status")
            return send(200, service.status(url.searchParams.get("id")));
          if (req.method === "GET" && url.pathname === "/take") {
            const bytes = service.take(url.searchParams.get("id"));
            res.setHeader("Content-Type", "audio/wav");
            res.setHeader("Cache-Control", "no-store");
            return res.end(bytes);
          }
          if (req.method !== "POST" || url.pathname !== "/start")
            return send(404, { error: "Unknown recording operation" });
          let body = "";
          for await (const chunk of req) {
            body += chunk;
            if (body.length > 512) throw new Error("Recording request exceeds budget");
          }
          const data = JSON.parse(body);
          if (Object.keys(data).length !== 1 || typeof data.bpm !== "number")
            throw new Error("Expected a tempo-only recording request");
          return send(200, service.start(data.bpm));
        } catch (error) {
          return send(400, { error: error.message });
        }
      });
    },
  };
}
