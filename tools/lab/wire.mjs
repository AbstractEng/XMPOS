import { createHash, createHmac } from "node:crypto";
import { labLimits } from "../../packages/lab/src/contracts.ts";
export const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function encodeFrame(message) {
  const body = Buffer.from(JSON.stringify(message));
  if (!body.length || body.length > labLimits.frameBytes)
    throw new Error("Lab frame exceeds profile");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}
export class FrameDecoder {
  constructor(consume) {
    this.consume = consume;
    this.header = Buffer.alloc(4);
    this.used = 0;
    this.body = null;
    this.offset = 0;
    this.failed = false;
  }
  push(chunk) {
    if (this.failed) throw new Error("Closed frame decoder");
    try {
      let cursor = 0;
      while (cursor < chunk.length) {
        if (!this.body) {
          const count = Math.min(4 - this.used, chunk.length - cursor);
          chunk.copy(this.header, this.used, cursor, cursor + count);
          this.used += count;
          cursor += count;
          if (this.used !== 4) continue;
          const size = this.header.readUInt32BE();
          if (!size || size > labLimits.frameBytes) throw new Error("Invalid bounded lab frame");
          this.body = Buffer.alloc(size);
          this.offset = 0;
        }
        const count = Math.min(this.body.length - this.offset, chunk.length - cursor);
        chunk.copy(this.body, this.offset, cursor, cursor + count);
        this.offset += count;
        cursor += count;
        if (this.offset === this.body.length) {
          const message = JSON.parse(this.body.toString("utf8"));
          this.body = null;
          this.used = 0;
          this.consume(message);
        }
      }
    } catch (error) {
      this.failed = true;
      this.body = null;
      throw error;
    }
  }
}
export function channelProof(socket, attestation) {
  const { proof: _proof, ...body } = attestation;
  const fields = [
    body.type,
    body.protocol,
    body.nonce,
    body.session,
    body.alias,
    body.model,
    body.buildHash,
    body.bootTier,
    body.expiresAt,
    body.fixtureHash,
    body.operations,
  ];
  const key = socket.exportKeyingMaterial(32, "xmp-host-lab-v1", Buffer.from(body.nonce, "hex"));
  return createHmac("sha256", key).update(JSON.stringify(fields)).digest("hex");
}
