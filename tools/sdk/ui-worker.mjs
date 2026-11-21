import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

// This trusted UI model has no audio engine, device API, package evaluator or network imports.
let state = { revision: 0, parameters: {} },
  token = "",
  ids = [];
process.on("message", (message) => {
  if (!message || typeof message !== "object" || Buffer.byteLength(JSON.stringify(message)) > 4096)
    return;
  const { op, request } = message;
  if (!Number.isSafeInteger(request) || request < 1) return;
  const reply = (value) => process.send?.({ request, ...value });
  if (op === "restore") {
    if (
      typeof message.token !== "string" ||
      message.token.length !== 32 ||
      !message.state ||
      !Number.isSafeInteger(message.state.revision) ||
      message.state.revision < 0 ||
      Object.keys(message.state.parameters ?? {}).length > 16 ||
      Object.values(message.state.parameters ?? {}).some(
        (v) => typeof v !== "number" || !Number.isFinite(v),
      )
    )
      return;
    token = message.token;
    state = structuredClone(message.state);
    ids = Object.keys(state.parameters);
    reply({ ack: state });
  } else if (message.token === token) {
    if (
      op === "set" &&
      ids.includes(message.id) &&
      typeof message.value === "number" &&
      Number.isFinite(message.value)
    ) {
      state.parameters[message.id] = message.value;
      state.revision++;
      reply({ ack: state });
    }
    if (op === "snapshot") reply({ ack: state });
    if (op === "crash") process.exit(23);
    if (op === "permission-probe") {
      let writeDenied = false,
        spawnDenied = false;
      try {
        writeFileSync(message.path, "blocked");
      } catch (e) {
        writeDenied = e.code === "ERR_ACCESS_DENIED";
      }
      try {
        spawnSync(process.execPath, ["-e", "process.exit(0)"]);
      } catch (e) {
        spawnDenied = e.code === "ERR_ACCESS_DENIED";
      }
      reply({ permissions: { writeDenied, spawnDenied } });
    }
  }
});
process.send?.({ ready: true });
