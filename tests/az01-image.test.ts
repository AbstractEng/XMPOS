import { describe, expect, it } from "vitest";
import { buildAz01, parseAz01, verifyAz01 } from "../tools/live-mk1/az01-image.mjs";

// Synthetic containers only; no vendor image is used in tests.
const payload = Buffer.from("synthetic compressed rootfs payload");
const image = buildAz01("SNAPSHOT-TEST", ["inmusic,acv8", "inmusic,acv5"], payload);

describe("AZ01 update container reader", () => {
  it("reads the name, compatible boards and partition record", () => {
    const parsed = parseAz01(image);
    expect(parsed.name).toBe("SNAPSHOT-TEST");
    expect(parsed.compatible).toEqual(["inmusic,acv5", "inmusic,acv8"]);
    expect(parsed.partition).toMatchObject({
      name: "rootfs",
      compression: "xz",
      hashAlgorithm: "sha1",
      size: payload.length,
    });
    expect(parsed.eofMarker).toBe(true);
    expect(
      image.subarray(parsed.partition.offset, parsed.partition.offset + payload.length),
    ).toEqual(payload);
  });

  it("verifies the payload against the container's own hash", () => {
    expect(verifyAz01(image).verified).toBe(true);
    const tampered = Buffer.from(image);
    const offset = parseAz01(image).partition.offset;
    tampered.writeUInt8(tampered.readUInt8(offset) ^ 0xff, offset);
    expect(verifyAz01(tampered).verified).toBe(false);
  });

  it("rejects foreign or truncated data", () => {
    expect(() => parseAz01(Buffer.alloc(256))).toThrow(/Not an AZ01/);
    expect(() => parseAz01(image.subarray(0, image.length - payload.length))).toThrow(/exceeds/);
  });
});
