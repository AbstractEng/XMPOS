import { describe, expect, it } from "vitest";
import { type HardwareReader, parseSoundCards, probeHardware } from "../os/guest/hardware.ts";
import {
  assertLiveTarget,
  auditFragment,
  classifyCompatible,
  describeBoard,
  explicitlyDisabled,
  parseKernelConfig,
} from "../tools/live-mk1/board.mjs";
import { dockerCreateArgs } from "../tools/live-mk1/container.mjs";
import { hubStrings, parseDtb } from "../tools/live-mk1/fdt.mjs";
import { parseBootLog } from "../tools/live-mk1/kernel.mjs";

// --- Synthetic DTB encoder (test fixture only; never written to disk) -------
type Value = string | string[] | number | Buffer;
interface Node {
  name: string;
  props?: Record<string, Value>;
  children?: Node[];
}
function encodeDtb(root: Node): Buffer {
  const strings: string[] = [];
  const stringOffset = (key: string) => {
    let offset = 0;
    for (const s of strings) {
      if (s === key) return offset;
      offset += s.length + 1;
    }
    strings.push(key);
    return offset;
  };
  const parts: Buffer[] = [];
  const u32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n);
    return b;
  };
  const pad = (b: Buffer) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]);
  const value = (v: Value) =>
    Buffer.isBuffer(v)
      ? v
      : typeof v === "number"
        ? u32(v)
        : Buffer.from(`${(Array.isArray(v) ? v : [v]).join("\0")}\0`, "latin1");
  const emit = (node: Node) => {
    parts.push(u32(1), pad(Buffer.from(`${node.name}\0`, "latin1")));
    for (const [key, v] of Object.entries(node.props ?? {})) {
      const data = value(v);
      parts.push(u32(3), u32(data.length), u32(stringOffset(key)), pad(data));
    }
    for (const child of node.children ?? []) emit(child);
    parts.push(u32(2));
  };
  emit(root);
  parts.push(u32(9));
  const struct = Buffer.concat(parts);
  const stringBlock = Buffer.from(strings.map((s) => `${s}\0`).join(""), "latin1");
  const header = Buffer.alloc(40);
  const structOffset = 40 + 16;
  const stringsOffset = structOffset + struct.length;
  const total = stringsOffset + stringBlock.length;
  [
    0xd00dfeed,
    total,
    structOffset,
    stringsOffset,
    40,
    17,
    16,
    0,
    stringBlock.length,
    struct.length,
  ].forEach((n, i) => {
    header.writeUInt32BE(n, i * 4);
  });
  return Buffer.concat([header, Buffer.alloc(16), struct, stringBlock]);
}
const utf16 = (s: string) => Buffer.from(s, "utf16le");
function liveTree(
  overrides: { compatible?: string[]; hub?: string; rotation?: number; battery?: boolean } = {},
) {
  return encodeDtb({
    name: "",
    props: {
      model: "InMusic MPC ACV8",
      compatible: overrides.compatible ?? ["inmusic,acv8", "inmusic,az01", "rockchip,rk3288"],
      "inmusic,product-code": "ACV8",
      "inmusic,panel-rotation": 270,
    },
    children: [
      { name: "chosen", props: { "inmusic,internal-sd-fitted": Buffer.alloc(0) } },
      { name: "ac-power", props: { compatible: "inmusic,az01-power" } },
      { name: "gpio-keys", props: { compatible: "gpio-keys" } },
      { name: "leds", props: { compatible: "gpio-leds" } },
      {
        name: "dsi@ff960000",
        children: [
          {
            name: "panel@0",
            props: { compatible: "urt,umo-p076md-t", rotation: overrides.rotation ?? 270 },
          },
        ],
      },
      {
        name: "i2c@ff150000",
        children:
          overrides.battery === false
            ? []
            : [{ name: "battery@b", props: { compatible: ["ti,bq40z50", "sbs,sbs-battery"] } }],
      },
      {
        name: "usb5537@2c",
        props: {
          "smsc,config-file": Buffer.concat([
            Buffer.from("CFGB"),
            utf16("Akai Professional"),
            Buffer.from([0, 0]),
            utf16(overrides.hub ?? "MPC Live Hub"),
          ]),
        },
      },
    ],
  });
}

describe("Live Mk1 device tree reader", () => {
  it("describes the ACV8 board and accepts it as the target", () => {
    const board = assertLiveTarget(describeBoard(liveTree()));
    expect(board).toMatchObject({
      role: "target",
      productCode: "ACV8",
      soc: "rockchip,rk3288",
      display: { panel: "urt,umo-p076md-t", rotation: 270, boardRotation: 270 },
      power: { battery: ["ti,bq40z50", "sbs,sbs-battery"], mains: true },
      internalSd: true,
      gpioKeys: true,
    });
    expect(board.usbHub).toContain("MPC Live Hub");
  });

  it("refuses the protected Force even when it also claims ACV8", () => {
    const force = describeBoard(
      liveTree({ compatible: ["inmusic,acv8", "inmusic,ada2"], hub: "Force Hub" }),
    );
    expect(force.role).toBe("protected");
    expect(() => assertLiveTarget(force)).toThrow(/Force is protected/);
    expect(classifyCompatible(["inmusic,ada2", "inmusic,az01"]).role).toBe("protected");
  });

  it("rejects other MPC boards and a mismatched ACV8 tree", () => {
    expect(() =>
      assertLiveTarget(describeBoard(liveTree({ compatible: ["inmusic,acv5"] }))),
    ).toThrow(/not the MPC Live Mk1/);
    expect(() =>
      assertLiveTarget(describeBoard(liveTree({ hub: "MPC X Hub", rotation: 90, battery: false }))),
    ).toThrow(/hub is not the MPC Live Hub; no SBS battery node; panel rotation is not 270/);
  });

  it("rejects malformed or oversized blobs", () => {
    expect(() => parseDtb(Buffer.alloc(64))).toThrow(/Not a flattened device tree/);
    const good = liveTree();
    expect(() => parseDtb(good.subarray(0, good.length - 8))).toThrow();
    const lying = Buffer.from(good);
    lying.writeUInt32BE(0x7fffffff, 36);
    expect(() => parseDtb(lying)).toThrow(/exceed/);
  });

  it("decodes hub product strings from UTF-16 configuration data", () => {
    expect(hubStrings(Buffer.concat([Buffer.from([1, 2, 3]), utf16("MPC Live Hub")]))).toContain(
      "MPC Live Hub",
    );
  });
});

describe("kernel configuration audit", () => {
  const official = parseKernelConfig(
    'CONFIG_A=y\n# CONFIG_B is not set\nCONFIG_C="x"\n# CONFIG_E is not set\n',
  );
  const disabled = explicitlyDisabled("CONFIG_A=y\n# CONFIG_E is not set\n");
  it("accepts a fragment that only enables default-off options", () => {
    const merged = parseKernelConfig('CONFIG_A=y\nCONFIG_B=y\nCONFIG_C="x"\nCONFIG_D=y\n');
    expect(auditFragment(official, merged, { CONFIG_D: "y" }, disabled)).toEqual([]);
  });
  it("rejects changing an official option or enabling an explicitly disabled one", () => {
    const merged = parseKernelConfig('CONFIG_C="z"\nCONFIG_E=y\n');
    expect(auditFragment(official, merged, { CONFIG_D: "y" }, disabled)).toEqual([
      "CONFIG_A changed from y to n",
      'CONFIG_C changed from "x" to "z"',
      "CONFIG_E is disabled by the official defconfig but was enabled",
      "CONFIG_D must be y",
    ]);
  });
});

describe("container policy", () => {
  const args = dockerCreateArgs({
    image: "xmp-live-mk1-builder:1",
    volumes: [{ source: "xmp-live-mk1-work", target: "/work" }],
    command: "true",
  });
  it("has no network, devices, host directories, capabilities or privilege escalation", () => {
    expect(args).toEqual(
      expect.arrayContaining(["--network", "none", "--cap-drop", "ALL", "no-new-privileges"]),
    );
    expect(args.join(" ")).not.toMatch(/--privileged|--device|type=bind|-v |host|\/dev\//);
  });
  it("refuses host directories, devices and other volumes", () => {
    for (const source of ["/dev/bus/usb", "/Users", "other-volume"])
      expect(() =>
        dockerCreateArgs({ image: "x", volumes: [{ source, target: "/work" }], command: "true" }),
      ).toThrow(/Refusing/);
  });
});

describe("boot log parsing", () => {
  it("decodes framed files, lists and test results", () => {
    const hex = (s: string) => Buffer.from(s).toString("hex");
    const log = [
      "noise",
      "XMP-LIVE-BOOT begin",
      `XMP-FILE /proc/version ${hex("Linux version 6.18.44-az01")}`,
      `XMP-LIST /sys/class/power_supply ${hex("a\nb\n")}`,
      "XMP-MISSING /proc/asound/cards 2",
      "XMP-TEST sampler 0",
      `XMP-OUTPUT sampler ${hex("ok")}`,
      "XMP-LIVE-BOOT end",
    ].join("\r\n");
    expect(parseBootLog(log)).toEqual({
      began: true,
      ended: true,
      files: { "/proc/version": "Linux version 6.18.44-az01", "/proc/asound/cards": null },
      lists: { "/sys/class/power_supply": ["a", "b"] },
      tests: { sampler: { exit: 0, output: "ok" } },
    });
  });
});

// --- Runtime probe -----------------------------------------------------------
function reader(files: Record<string, string>, seen: string[] = []): HardwareReader {
  return {
    read: (path) => {
      seen.push(path);
      return files[path] ?? null;
    },
    list: (path) => {
      seen.push(path);
      const prefix = `${path}/`;
      return [
        ...new Set(
          Object.keys(files)
            .filter((p) => p.startsWith(prefix))
            .map((p) => p.slice(prefix.length).split("/")[0] ?? ""),
        ),
      ].sort();
    },
  };
}
// Synthetic Live Mk1 system derived from the official ACV8 device tree; not a capture from a unit.
const syntheticLive = {
  "/proc/device-tree/compatible": "inmusic,acv8\0inmusic,az01\0rockchip,rk3288\0",
  "/proc/device-tree/model": "InMusic MPC ACV8\0",
  "/proc/sys/kernel/osrelease": "6.18.44-az01-2026-08-10\n",
  "/sys/kernel/realtime": "1\n",
  "/sys/class/power_supply/az01-ac-power/type": "Mains\n",
  "/sys/class/power_supply/az01-ac-power/online": "1\n",
  "/sys/class/power_supply/sbs-3-000b/type": "Battery\n",
  "/sys/class/power_supply/sbs-3-000b/capacity": "87\n",
  "/sys/class/power_supply/sbs-3-000b/status": "Charging\n",
  "/proc/asound/cards":
    " 0 [Live           ]: USB-Audio - MPC Live\n                      Akai Professional MPC Live at usb-ff500000.usb-1.1\n",
  "/sys/class/drm/card0-DSI-1/status": "connected\n",
  "/sys/class/input/input0/name": "ili2117\n",
};

describe("runtime hardware probe", () => {
  it("reports every Live Mk1 subsystem the official device tree promises", () => {
    const profile = probeHardware(reader(syntheticLive));
    expect(profile.status).toBe("live-mk1-unverified");
    expect(profile.missing).toEqual([]);
    expect(profile.power?.battery).toEqual({
      name: "sbs-3-000b",
      capacity: 87,
      status: "Charging",
    });
    expect(profile.audio?.cards[0]).toEqual({ index: 0, driver: "USB-Audio", name: "MPC Live" });
    expect(profile.hardwareQualified).toBe(false);
  });

  it("names what is missing instead of assuming support", () => {
    const partial = { ...syntheticLive };
    delete (partial as Record<string, string>)["/proc/asound/cards"];
    delete (partial as Record<string, string>)["/sys/kernel/realtime"];
    expect(probeHardware(reader(partial)).missing).toEqual([
      "PREEMPT_RT kernel",
      "USB audio interface",
    ]);
  });

  it("stops at identity for the protected Force", () => {
    const seen: string[] = [];
    const profile = probeHardware(
      reader(
        { ...syntheticLive, "/proc/device-tree/compatible": "inmusic,ada2\0inmusic,az01\0" },
        seen,
      ),
    );
    expect(profile.status).toBe("refused-protected");
    expect(profile.power).toBeUndefined();
    expect(seen).toEqual(["/proc/device-tree/compatible", "/proc/device-tree/model"]);
  });

  it("treats a generic QEMU board as a development host", () => {
    const profile = probeHardware(reader({ "/proc/device-tree/compatible": "linux,dummy-virt\0" }));
    expect(profile.status).toBe("development-host");
    expect(profile.missing).toEqual([]);
  });

  it("refuses paths outside /proc and /sys", () => {
    const evil: HardwareReader = {
      read: () => null,
      list: (path) => (path === "/sys/class/power_supply" ? ["../../../dev/sda"] : []),
    };
    expect(() => probeHardware(evil)).toThrow(/Probe path refused/);
    expect(parseSoundCards("garbage")).toEqual([]);
  });
});
