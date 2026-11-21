import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyseWav,
  canvasToFb,
  canvasToRaw,
  EXPECTED_STARTUP,
  feedbackBytesAllowed,
  hardware,
  onsets,
  PAD_SCRIPT,
  PEAK_LIMIT,
  parsePpm,
  SEQ_SCRIPT,
  sentBytes,
} from "../tools/live-mk1/session-vm.mjs";

const root = join(import.meta.dirname, "..");
const session = readFileSync(join(root, "native/src/live_session.cpp"), "utf8");
const platform = readFileSync(join(root, "native/include/xmp/live_platform_linux.hpp"), "utf8");
const init = readFileSync(join(root, "os/live-mk1/session-init.c"), "utf8");
const twin = readFileSync(join(root, "os/live-mk1/live-twin.c"), "utf8");
const controls = readFileSync(join(root, "native/include/xmp/live_controls.hpp"), "utf8");
const builder = readFileSync(join(root, "tools/live-mk1/session-image.mjs"), "utf8");

// Hardware boundary for the XMP session (AGENTS.md, "Device-specific authorization 2").
describe("Live Mk1 session hardware boundary", () => {
  it("allowlists startup and guarded button/pad display feedback", () => {
    const writes = [...`${session}\n${platform}`.matchAll(/snd_rawmidi_write\s*\(([^)]*)\)/g)].map(
      (match) => match[1],
    );
    expect(writes).toEqual(["out, bytes, size", "feedback_out[port],data,size"]);
    expect(platform).toContain(
      "qlink_led_controller_allowed(compatible, card_identity(card), card_description(card))",
    );
    expect(`${session}\n${platform}`.match(/snd_rawmidi_open\([^;]*&out/g)).toHaveLength(1);
    expect(platform).toContain("(!identity && !startup)");
    expect(platform).toContain("std::equal(bytes, bytes+size, kIdentityRequest.begin())");
    expect(platform).toContain("std::equal(bytes, bytes+size, kStartupSequence.begin())");
    expect(platform).toContain("!live_controller_card(card_identity(card))");
    expect(session.match(/controller\.send\(/g)).toHaveLength(2);
    const sends = [
      ...session.matchAll(
        /controller\.send\(port, xmp::live::(\w+)\.data\(\), xmp::live::(\w+)\.size\(\)/g,
      ),
    ].map((m) => [m[1], m[2]]);
    expect(sends).toEqual([
      ["kIdentityRequest", "kIdentityRequest"],
      ["kStartupSequence", "kStartupSequence"],
    ]);
    expect(controls).toContain("kQLinkLedPort = 1");
    expect(platform.match(/snd_rawmidi_open\([^;]*&feedback_out\[port\]/g)).toHaveLength(1);
    expect(platform).toContain(
      "snd_rawmidi_open(nullptr,&feedback_out[port],name,SND_RAWMIDI_NONBLOCK)",
    );
    expect(session).toMatch(
      /port == xmp::live::kQLinkLedPort\)\s+controller\.open_feedback\(compatible\);/,
    );
    expect(platform).toMatch(
      /feedback\.sync\(port,lights,[\s\S]*?snd_rawmidi_write\(feedback_out\[port\],data,size\)/,
    );
    expect(session).toContain(
      "controller.update_feedback(face.panel_lights(board, workbench.now_state()))",
    );
  });

  it("has one build: no emulator-only code in the session", () => {
    expect(session).not.toMatch(/XMP_SESSION_EMULATOR|test-midi|dummy-virt|46f4/);
  });

  it("never logs the serial number from the controller's identity reply", () => {
    expect(session).toMatch(/hex\(bytes, identity \? 14 : parser\.sysex_size\(\)\)/);
    expect(session).toMatch(/serial number not logged/);
  });

  it("takes the Live build's board and audio-card rules from the shared header", () => {
    expect(session).toMatch(/return xmp::live::is_live_mk1\(compatible\);/);
    expect(session).toMatch(/return xmp::live::live_audio_card_allowed\(identity, compatible\);/);
    expect(session).toMatch(/xmp::live::limit\(left\[i\]\), r = xmp::live::limit\(right\[i\]\)/);
    expect(session).not.toMatch(/"(hw|plughw|default)"|"default:/);
    expect(session).not.toMatch(/xmos|touch-fw|firmware-update|mmcblk|\/dev\/sd/);
  });

  it("only mounts the stick, never internal storage, and has no network", () => {
    const mounts = [...init.matchAll(/\bmount\(([^)]*)\)/g)].map((m) => m[1] ?? "");
    expect(mounts.filter((m) => m.includes("STICK"))).toEqual([
      "NULL, STICK, NULL, MS_REMOUNT | MS_NOSUID | MS_NODEV | MS_NOEXEC, NULL",
    ]);
    expect(
      mounts.filter((m) => !m.includes("STICK")).every((m) => /"(proc|sysfs|devtmpfs)"/.test(m)),
    ).toBe(true);
    expect(init).toMatch(
      /strstr\(target, EMMC_CONTROLLER\) != NULL \|\| strstr\(target, INTERNAL_SD_CONTROLLER\)/,
    );
    expect(`${init}\n${session}`).not.toMatch(/AF_INET|AF_INET6|AF_PACKET/);
    // The session's only socket is the bridge's local Unix control socket.
    expect(session.match(/::socket\(/g)).toHaveLength(1);
    expect(session).toMatch(/::socket\(AF_UNIX, SOCK_STREAM/);
  });

  it("the twin is started only by the emulator init and ships only in the emulator image", () => {
    expect(init).toMatch(/#ifdef XMP_SESSION_EMULATOR\s+\/\* Emulator image only: the Live twin/);
    expect(builder).toMatch(
      /install -m 755 \/w\/live-twin \/w\/emulator\/usr\/lib\/xmp\/xmp-live-twin/,
    );
    expect(builder).not.toMatch(/live-twin \/w\/live\//);
    // Same session binary in both images.
    expect(builder).toMatch(
      /install -m 755 \/w\/session \/w\/live\/usr\/lib\/xmp\/xmp-live-session/,
    );
    expect(builder).toMatch(
      /install -m 755 \/w\/session \/w\/emulator\/usr\/lib\/xmp\/xmp-live-session/,
    );
  });
});

describe("Live hardware profile and the twin", () => {
  const hw = hardware();
  it("matches the session's own constants", () => {
    expect(controls).toContain(`id.find("${hw.audio.usbId}")`);
    expect(controls).toContain(`id.find("${hw.controller.usbId}")`);
    expect(controls).toContain(`c.find("${hw.board.compatible[0]}")`);
    expect(hw.display.rotation).toBe(270);
    expect(hw.board.isolatedCpus).toBe("2-3");
    expect(JSON.stringify(hw)).not.toMatch(/serial(?!s)[^"]*"\s*:\s*"[A-Z0-9]{8,}/i);
  });
  it("the twin presents the Live's USB IDs and touch ranges", () => {
    expect(twin).toContain(
      `"0x${hw.controller.usbId.split(":")[0]}", "0x${hw.controller.usbId.split(":")[1]}", "${hw.controller.card}"`,
    );
    // The audio card is QEMU's usb-audio, patched to carry the card's ID and name.
    const vm = readFileSync(join(root, "tools/live-mk1/session-vm.mjs"), "utf8");
    const patch = readFileSync(join(root, "os/live-mk1/qemu-usb-audio-ids.patch"), "utf8");
    expect(vm).toContain("vendorid=0x${hw.audio.usbId.split");
    expect(vm).toContain("manufacturer=XMP emulator,product=${hw.audio.card}");
    expect(patch).toMatch(/DEFINE_PROP_UINT32\("vendorid"/);
    expect(twin).not.toMatch(/uac2\.usb/);
    expect(twin).toContain("0x26, 0x00, 0x05"); // X max 1280
    expect(twin).toContain("0x26, 0xD0, 0x02"); // Y max 720
    expect(twin).toContain('"XMP emulator"');
  });
  it("maps canvas touches to raw units the session maps back", () => {
    const points: [number, number][] = [
      [0, 0],
      [527, 57],
      [1200, 697],
      [1279, 799],
    ];
    for (const [x, y] of points) {
      const [rx, ry] = canvasToRaw(x, y, hw);
      const fx = Math.floor((rx * 800) / 1281),
        fy = Math.floor((ry * 1280) / 721);
      expect(Math.abs(fx - y)).toBeLessThanOrEqual(1);
      expect(Math.abs(1279 - fy - x)).toBeLessThanOrEqual(2);
      expect(canvasToFb(x, y, hw)).toEqual([y, 1279 - x]);
    }
  });
});

describe("Live Mk1 session emulator test helpers", () => {
  const wav = (samples: number[], rate = 48000) => {
    const data = Buffer.alloc(samples.length * 2);
    for (const [i, s] of samples.entries()) data.writeInt16LE(s, i * 2);
    const header = Buffer.alloc(44);
    header.write("RIFF", 0);
    header.writeUInt32LE(36 + data.length, 4);
    header.write("WAVEfmt ", 8);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(2, 22);
    header.writeUInt32LE(rate, 24);
    header.writeUInt32LE(rate * 4, 28);
    header.writeUInt16LE(4, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36);
    header.writeUInt32LE(data.length, 40);
    return Buffer.concat([header, data]);
  };

  it("measures peak and loud time of a 16-bit stereo WAV", () => {
    const result = analyseWav(wav([0, 0, 8000, -8230, 100, 0, 0, 0]));
    expect(result).toMatchObject({ channels: 2, rate: 48000, frames: 4 });
    expect(result.peak).toBeCloseTo(8230 / 32768, 6);
    expect(result.peak).toBeLessThanOrEqual(PEAK_LIMIT);
    expect(result.loudSeconds).toBeCloseTo(2 / 48000, 9);
    expect(() => analyseWav(Buffer.from("not a wav file at all, really"))).toThrow();
  });

  it("finds hit onsets even when the attack ramps up", () => {
    const rate = 1000;
    const samples: number[] = [];
    for (let ms = 0; ms < 400; ms++) {
      const local = ms % 125;
      // ramp through the quiet band, a loud burst, then silence
      const v = local === 0 ? 500 : local < 10 ? 3000 : 0;
      samples.push(v, v);
    }
    const found = onsets(wav(samples, rate));
    expect(found.map((t: number) => Math.round(t * 1000))).toEqual([1, 126, 251, 376]);
  });

  it("the sequencer script touches inside the touchscreen's raw ranges", () => {
    const touches = SEQ_SCRIPT()
      .split("\n")
      .filter((l: string) => l.includes(" touch "));
    expect(touches).toHaveLength(21);
    for (const line of touches) {
      const [, , x, y] = line.split(" ");
      expect(Number(x)).toBeLessThanOrEqual(1280);
      expect(Number(y)).toBeLessThanOrEqual(720);
    }
  });

  it("rejects non-display traffic in emulator controller captures", () => {
    const codes = [
      0x23, 0x24, 0x25, 0x26, 0x0b, 0x27, 0x28, 0x35, 0x49, 0x50, 0x51, 0x52, 0x53, 0x5a, 0x5b,
      0x5c, 0x5d,
    ];
    const hex = (n: number) => n.toString(16).toUpperCase().padStart(2, "0");
    const sent = {
      private: EXPECTED_STARTUP + " " + codes.map((n) => `B0 ${hex(n)} 00`).join(" "),
      public: Array.from(
        { length: 16 },
        (_, p) => `F0 47 7F 3B 65 00 04 ${hex(p)} 00 00 00 F7`,
      ).join(" "),
    };
    expect(feedbackBytesAllowed(sent)).toBe(true);
    expect(feedbackBytesAllowed({ ...sent, private: sent.private + " B0 01 03" })).toBe(false);
    expect(feedbackBytesAllowed({ ...sent, public: sent.public.replace("3B 65", "40 65") })).toBe(
      false,
    );
    expect(
      feedbackBytesAllowed({ ...sent, public: sent.public.replace("00 00 00 F7", "80 00 00 F7") }),
    ).toBe(false);
    expect(
      feedbackBytesAllowed({ ...sent, public: sent.public + " F0 47 7F 3B 41 00 00 F7" }),
    ).toBe(false);
  });

  it("collects the bytes sent per port and knows the authorized sequence", () => {
    const sent = sentBytes("1.0 port 1: F0 7E 00 06 01 F7\n1.1 port 1: F0 47\n");
    expect(sent).toEqual({ public: "", private: "F0 7E 00 06 01 F7 F0 47" });
    expect(EXPECTED_STARTUP.split(" ")).toHaveLength(6 + 83);
  });

  it("reads binary PPM screenshots", () => {
    const ppm = Buffer.concat([
      Buffer.from("P6\n# c\n2 1\n255\n"),
      Buffer.from([1, 2, 3, 4, 5, 6]),
    ]);
    const shot = parsePpm(ppm);
    expect([shot.width, shot.height]).toEqual([2, 1]);
    expect(shot.pixel(1, 0)).toEqual([4, 5, 6]);
  });

  it("the pad script is well-formed controller bytes", () => {
    for (const line of PAD_SCRIPT.split("\n").filter((l: string) => l && !l.startsWith("#"))) {
      const [at, ...rest] = line.split(" ");
      const bytes = rest[0] === "p1" ? rest.slice(1) : rest;
      expect(Number(at)).toBeGreaterThan(0);
      for (const b of bytes) expect(b).toMatch(/^[0-9A-F]{2}$/);
    }
  });
});
