import { createHash } from "node:crypto";

// Read-only parser for inMusic "AZ01" update containers (MPC firmware 3.4+).
// Layout as documented by MPC-LiveXplore's image tools: a header with the image
// name, a compatible-device table, then one "PARTL" partition record (56 bytes
// plus a hash) followed by the compressed partition and an "EOF" marker.
// Nothing here executes or unpacks vendor code.

const MAX_HEADER = 64 * 1024;

export function parseAz01(bytes) {
  const data = Buffer.from(bytes);
  if (data.length < 128 || data.toString("latin1", 0, 4) !== "AZ01")
    throw new Error("Not an AZ01 update container");
  const nameLength = data.readUInt32LE(12);
  if (nameLength < 1 || nameLength > 256) throw new Error("Invalid AZ01 image name");
  const name = data.toString("latin1", 16, 16 + nameLength).replace(/\0.*$/s, "");
  const partl = data.indexOf("PARTL", 16, "latin1");
  if (partl < 0 || partl > MAX_HEADER) throw new Error("AZ01 partition record not found");
  const header = data.subarray(0, partl).toString("latin1");
  const compatible = [
    ...new Set([...header.matchAll(/inmusic,[a-z0-9]+/g)].map((m) => m[0])),
  ].sort();
  const record = data.subarray(partl, partl + 56);
  if (record.length < 56) throw new Error("Truncated AZ01 partition record");
  const text = (from, to) => record.toString("latin1", from, to).replace(/\0.*$/s, "");
  const size = Number(record.readBigUInt64LE(8));
  const hashLength = record.readUInt32LE(52);
  if (hashLength !== 20) throw new Error("Unsupported AZ01 partition hash length");
  const payloadOffset = partl + 76;
  if (!Number.isSafeInteger(size) || size < 1 || payloadOffset + size > data.length)
    throw new Error("AZ01 partition exceeds the container");
  const tail = data.subarray(payloadOffset + size, payloadOffset + size + 16).toString("latin1");
  return {
    name,
    compatible,
    partition: {
      name: text(20, 28),
      compression: text(32, 36),
      hashAlgorithm: text(44, 52),
      hash: data.subarray(partl + 56, partl + 76).toString("hex"),
      offset: payloadOffset,
      size,
    },
    eofMarker: tail.includes("EOF"),
  };
}

// Verifies the partition payload against the hash stored in the container.
export function verifyAz01(bytes, parsed = parseAz01(bytes)) {
  const data = Buffer.from(bytes);
  const { offset, size, hash, hashAlgorithm } = parsed.partition;
  if (hashAlgorithm !== "sha1") throw new Error(`Unsupported AZ01 hash ${hashAlgorithm}`);
  const actual = createHash("sha1")
    .update(data.subarray(offset, offset + size))
    .digest("hex");
  return { ...parsed, verified: actual === hash && parsed.eofMarker, actualHash: actual };
}

// Builds a synthetic container (tests only; never a vendor image).
export function buildAz01(name, compatible, payload) {
  const nameBytes = Buffer.from(`${name}\0`, "latin1");
  const head = Buffer.alloc(16);
  head.write("AZ01", 0, "latin1");
  head.writeUInt32LE(1, 4);
  head.writeUInt32LE(0x108, 8);
  head.writeUInt32LE(nameBytes.length, 12);
  const devices = Buffer.concat(
    compatible.map((device) => {
      const entry = Buffer.alloc(24);
      entry.writeUInt32LE(device.length, 0);
      entry.write(device, 4, "latin1");
      return entry;
    }),
  );
  const record = Buffer.alloc(56);
  record.write("PARTL", 0, "latin1");
  record.writeBigUInt64LE(BigInt(payload.length), 8);
  record.write("rootfs", 20, "latin1");
  record.write("xz", 32, "latin1");
  record.write("sha1", 44, "latin1");
  record.writeUInt32LE(20, 52);
  const hash = createHash("sha1").update(payload).digest();
  const body = Buffer.concat([head, nameBytes, devices, Buffer.alloc(8), record, hash, payload]);
  return Buffer.concat([body, Buffer.alloc((8 - (body.length % 8)) % 8), Buffer.from("EOF")]);
}
