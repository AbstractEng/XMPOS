import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BRIDGE_ID,
  CABLE_ID,
  chooseBridge,
  chooseLink,
  FrameReader,
  frame,
  packSparse,
  parseIoreg,
  screenshotPng,
  unpackRle,
} from "../tools/live-mk1/bridge.mjs";

const root = join(import.meta.dirname, "..");
const daemon = readFileSync(join(root, "os/live-mk1/xmp-bridge.c"), "utf8");
const init = readFileSync(join(root, "os/live-mk1/session-init.c"), "utf8");

// Control bridge boundary (AGENTS.md authorizations 3 and 4).
describe("Live Mk1 control bridge: device side", () => {
  it("uses XMP's own USB ID, serial only, never Akai's", () => {
    expect(daemon).toContain('put(GADGET "/idVendor", "0x1209")');
    expect(daemon).toContain('put(GADGET "/idProduct", "0x0001")');
    expect(daemon).toMatch(/functions\/acm\.usb0/);
    expect(daemon).not.toMatch(/mass_storage|rndis|ecm\.|eem\./i);
    // Akai's vendor ID appears once, as the one it refuses.
    expect([...daemon.matchAll(/0x09e8/gi)]).toHaveLength(1);
    expect(daemon).toMatch(/if \(vendor == AKAI_VENDOR\) continue;/);
  });
  it("opens only the FTDI cable's port, and only when exactly one is attached", () => {
    expect(daemon).toMatch(/#define CABLE_VENDOR 0x0403\n#define CABLE_PRODUCT 0x6001/);
    expect(daemon).toMatch(/vendor == CABLE_VENDOR && product == CABLE_PRODUCT/);
    expect(daemon).toMatch(/if \(cables == 1\) \{\s+link_fd = open_cable\(cable\);/);
    expect(daemon).toMatch(/CRTSCTS/);
    // Only ttyUSB ports are considered, by their USB device in sysfs.
    expect(daemon).toMatch(/strncmp\(e->d_name, "ttyUSB", 6\) != 0/);
  });
  it("never executes anything it receives", () => {
    expect(daemon).not.toMatch(/\b(system|popen|execv|execl|execve|execvp|dlopen)\s*\(/);
    expect(daemon).not.toMatch(/\b(socket\(AF_INET|AF_INET6|bind\()/);
  });
  it("has the fixed command set and requires the token first", () => {
    const commands = [...daemon.matchAll(/strcmp\(cmd, "([a-z-]+)"\) == 0/g)].map((m) => m[1]);
    expect(new Set(commands)).toEqual(
      new Set([
        "hello",
        "status",
        "log",
        "screenshot",
        "input",
        "record",
        "push-image",
        "restart",
        "reboot",
        "power-off",
      ]),
    );
    expect(daemon).toMatch(/if \(!\*authorized\) return send_json/);
  });
  it("only accepts the four input forms", () => {
    expect(daemon).toMatch(
      /strncmp\(line, "pad ", 4\) == 0 \|\| strncmp\(line, "button ", 7\) == 0 \|\|/,
    );
  });
  it("writes only below the stick, verifies pushed images, keeps the previous one", () => {
    expect(daemon).toContain('openat(dir, "system.img.new", O_RDWR | O_CREAT | O_EXCL');
    expect(daemon).toContain("xmp_image_envelope(fd)");
    expect(daemon).toContain("xmp_promote_image(dir)");
    expect(daemon).toContain("strcmp(actual, expected) != 0");
    expect(daemon).toContain('"%s/xmp", stick');
    expect(init).toContain('#define BRIDGE_UDC "none"');
    expect(daemon).toContain('const char *udc_arg = "none"');
  });
  it("falls back once to the previous image after a failed session", () => {
    expect(init).toContain("xmp_fallback_image(dir) == 0");
    expect(init).toContain("if (!restored || umount2(STICK, 0))");
    expect(init).not.toContain("unlink(FALLBACK_MARKER)");
    expect(init).toMatch(/reboot\(RB_AUTOBOOT\)/);
  });
});

describe("Live Mk1 control bridge: Mac side", () => {
  const ioreg = (vendor: number, product: number, callout = "/dev/cu.usbmodem1101") =>
    `+-o Dev@01100000  <class IOUSBHostDevice, id 0x1>\n  |   "idVendor" = ${vendor}\n  |   "idProduct" = ${product}\n      | "IOCalloutDevice" = "${callout}"\n`;
  it("finds exactly one XMP bridge", () => {
    expect(chooseBridge(parseIoreg(ioreg(BRIDGE_ID.vendor, BRIDGE_ID.product)))).toBe(
      "/dev/cu.usbmodem1101",
    );
    expect(() =>
      chooseBridge(parseIoreg(ioreg(BRIDGE_ID.vendor, BRIDGE_ID.product).repeat(2))),
    ).toThrow(/More than one/);
  });
  it("never picks an Akai device or a non-bridge serial port", () => {
    expect(() => chooseBridge(parseIoreg(ioreg(0x09e8, 0x003b)))).toThrow(/No XMP bridge/);
    expect(() => chooseBridge(parseIoreg(ioreg(0x09e8, BRIDGE_ID.product)))).toThrow(
      /No XMP bridge/,
    );
    expect(() =>
      chooseBridge(parseIoreg(ioreg(BRIDGE_ID.vendor, BRIDGE_ID.product, "/dev/tty.evil; rm"))),
    ).toThrow();
  });
  it("prefers exactly one FTDI cable, and refuses two links or Akai devices", () => {
    const cable = ioreg(CABLE_ID.vendor, CABLE_ID.product, "/dev/cu.usbserial-TEST0001");
    expect(chooseLink(parseIoreg(cable))).toEqual({
      kind: "cable",
      port: "/dev/cu.usbserial-TEST0001",
    });
    expect(() => chooseLink(parseIoreg(cable.repeat(2)))).toThrow(/More than one FTDI cable/);
    expect(() =>
      chooseLink(parseIoreg(cable + ioreg(BRIDGE_ID.vendor, BRIDGE_ID.product))),
    ).toThrow(/Both the FTDI cable and the USB-B bridge/);
    expect(chooseLink(parseIoreg(ioreg(BRIDGE_ID.vendor, BRIDGE_ID.product)))).toEqual({
      kind: "gadget",
      port: "/dev/cu.usbmodem1101",
    });
    expect(() => chooseLink(parseIoreg(ioreg(0x09e8, 0x6001, "/dev/cu.usbserial-AKAI")))).toThrow(
      /No XMP bridge/,
    );
    expect(() =>
      chooseLink(parseIoreg(ioreg(CABLE_ID.vendor, CABLE_ID.product, "/dev/cu.usbserial-x; rm"))),
    ).toThrow(/no single serial port/);
  });
  it("frames and reassembles split frames", async () => {
    const reader = new FrameReader();
    const bytes = Buffer.concat([frame("one"), frame(Buffer.from([1, 2, 3]))]);
    reader.push(bytes.subarray(0, 5));
    reader.push(bytes.subarray(5));
    expect((await reader.next()).toString()).toBe("one");
    expect([...(await reader.next())]).toEqual([1, 2, 3]);
  });
  it("turns the portrait framebuffer into a landscape PNG", () => {
    const raw = Buffer.alloc(2 * 3 * 4);
    raw.writeUInt32LE(0x00ff0000, 0); // framebuffer (0,0) red -> canvas (0, 1) for rotation 270... any pixel lands
    const png = screenshotPng(raw, { width: 2, height: 3 });
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect(png.readUInt32BE(16)).toBe(3); // width = framebuffer height
    expect(png.readUInt32BE(20)).toBe(2);
  });
  it("packs an image without its empty blocks", () => {
    const image = Buffer.alloc(4 * 8 + 3);
    image[9] = 7; // block 1 (of 8 bytes) has data
    image[34] = 5; // the short last block has data
    const packed = packSparse(image, 8);
    // zeros 8, data 8, zeros 16, data 3
    expect([...packed.subarray(0, 5)]).toEqual([0, 0, 0, 0, 8]);
    expect([...packed.subarray(5, 10)]).toEqual([1, 0, 0, 0, 8]);
    expect([...packed.subarray(18, 23)]).toEqual([0, 0, 0, 0, 16]);
    expect([...packed.subarray(23, 28)]).toEqual([1, 0, 0, 0, 3]);
    expect(packed.length).toBe(5 + 5 + 8 + 5 + 5 + 3);
    // What the Live's bridge rebuilds from the records is the image.
    const out: number[] = [];
    for (let i = 0; i < packed.length; ) {
      const kind = packed[i],
        length = packed.readUInt32BE(i + 1);
      i += 5;
      if (kind === 0) out.push(...new Array(length).fill(0));
      else out.push(...packed.subarray(i, i + length)), (i += length);
    }
    expect(Buffer.from(out).equals(image)).toBe(true);
    expect(daemon).toMatch(/json_number\(request, "sparse", 0\) == 1/);
    // The whole image's hash is still checked before it replaces the stick's.
    expect(daemon).toMatch(/if \(sparse && left != 0\) failed = 1;/);
  });
  it("unpacks a run-length encoded screenshot, and refuses one of the wrong size", () => {
    const packed = Buffer.from([0, 3, 1, 2, 3, 4, 0, 1, 9, 8, 7, 6]);
    expect([...unpackRle(packed, 16)]).toEqual([1, 2, 3, 4, 1, 2, 3, 4, 1, 2, 3, 4, 9, 8, 7, 6]);
    expect(() => unpackRle(packed, 12)).toThrow(/exceed/);
    expect(() => unpackRle(packed, 20)).toThrow(/shorter/);
    expect(() => unpackRle(packed.subarray(0, 5), 16)).toThrow(/run-length/);
    expect(() => unpackRle(Buffer.from([0, 0, 1, 2, 3, 4]), 16)).toThrow(/exceed/);
    expect(daemon).toMatch(/json_number\(request, "rle", 0\) == 1/);
  });
});

it("fingerprints exact executable bytes and refuses symlinks", () => {
  const directory = mkdtempSync(join(tmpdir(), "xmp-bridge-hash-"));
  try {
    const source = join(directory, "hash.c"),
      binary = join(directory, "hash");
    const code = daemon.slice(
      daemon.indexOf("typedef struct {"),
      daemon.indexOf("/* ---- minimal JSON"),
    );
    writeFileSync(
      source,
      `#include <stdint.h>\n#include <stddef.h>\n#include <stdio.h>\n#include <string.h>\n#include <fcntl.h>\n#include <sys/stat.h>\n#include <unistd.h>\n#include <errno.h>\n${code}\nint main(int argc, char **argv) { if(argc!=2)return 2; char out[65]; executable_hash(argv[1],out); puts(out); return 0; }\n`,
    );
    const compiled = spawnSync(
      "cc",
      [
        "-std=c11",
        "-D_GNU_SOURCE",
        "-D_DARWIN_C_SOURCE",
        "-O2",
        "-Wall",
        "-Wextra",
        "-Werror",
        source,
        "-o",
        binary,
      ],
      { encoding: "utf8" },
    );
    expect(compiled.status, compiled.stderr).toBe(0);
    const file = join(directory, "input"),
      data = Buffer.alloc(100003, 0x53);
    writeFileSync(file, data);
    expect(spawnSync(binary, [file], { encoding: "utf8" }).stdout.trim()).toBe(
      createHash("sha256").update(data).digest("hex"),
    );
    const link = join(directory, "link");
    symlinkSync(file, link);
    expect(spawnSync(binary, [link], { encoding: "utf8" }).stdout.trim()).toBe("");
    expect(
      spawnSync(binary, [join(directory, "missing")], { encoding: "utf8" }).stdout.trim(),
    ).toBe("");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
