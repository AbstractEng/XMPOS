import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkDrive,
  checkIdentity,
  checkInstalledName,
  checkPluginSource,
  parseArgs,
  parseProbe,
  serialHash,
  sshArgs,
} from "../tools/live-mk1/mpc-remote.mjs";
import { rewrite } from "../tools/live-mk1/mpc-ssh-shim.mjs";

// AGENTS.md authorization 6: SSH and Akai's mpc_remote.py on the Live Mk1 only.
const probe = (compatible: string, app = "3.10.1.12", serial = "TEST123") =>
  [
    `compatible=${compatible},`,
    "model=MPC Live",
    `serial=${serial}`,
    `app=${app}`,
    "@@MOUNTS",
    "/dev/mmcblk0p7 /media/az01-internal ext4 rw,relatime 0 0",
    "/dev/mmcblk1p1 /media/SDCARD vfat rw,relatime 0 0",
    "/dev/sda1 /media/XMPPROBE vfat rw,relatime 0 0",
    "/dev/sdb1 /media/OTHER\\040STICK vfat ro,relatime 0 0",
  ].join("\n");

describe("the MPC OS remote wrapper only reaches the owner's Live", () => {
  it("accepts the Live Mk1 on 3.10.1 and records it by serial hash", () => {
    const id = checkIdentity(parseProbe(probe("inmusic,acv8,rockchip,rk3288")), null);
    expect(id.version).toBe("3.10.1");
    expect(id.hash).toBe(serialHash("TEST123"));
    expect(id.hash).not.toContain("TEST123");
  });
  it("refuses the Force, other boards, old firmware and a different Live", () => {
    expect(() => checkIdentity(parseProbe(probe("inmusic,ada2,rockchip,rk3288")), null)).toThrow(
      /Force/,
    );
    const force = parseProbe(probe("inmusic,acv8"));
    force.model = "Akai Force";
    expect(() => checkIdentity(force, null)).toThrow(/Force/);
    expect(() => checkIdentity(parseProbe(probe("inmusic,acva")), null)).toThrow(
      /Not an MPC Live Mk1/,
    );
    expect(() => checkIdentity(parseProbe(probe("inmusic,acv8", "3.10.0.5")), null)).toThrow(
      /older/,
    );
    expect(() => checkIdentity(parseProbe(probe("inmusic,acv8", "")), null)).toThrow(/version/);
    expect(() => checkIdentity(parseProbe(probe("inmusic,acv8", "3.10.1", "")), null)).toThrow(
      /serial/,
    );
    expect(() => checkIdentity(parseProbe(probe("inmusic,acv8")), serialHash("ANOTHER"))).toThrow(
      /recorded/,
    );
  });
  it("writes only to a USB stick, never internal storage or the SD card", () => {
    const { mounts } = parseProbe(probe("inmusic,acv8"));
    expect(checkDrive(mounts, "XMPPROBE")).toBe("/media/XMPPROBE");
    expect(checkDrive(mounts, "/media/XMPPROBE")).toBe("/media/XMPPROBE");
    expect(() => checkDrive(mounts, "az01-internal")).toThrow(/internal/);
    expect(() => checkDrive(mounts, "SDCARD")).toThrow(/internal/);
    expect(() => checkDrive(mounts, "OTHER STICK")).toThrow(/read-only/);
    expect(() => checkDrive(mounts, "MISSING")).toThrow(/No single drive/);
    expect(() => checkDrive(mounts, null)).toThrow(/--drive/);
  });
  it("installs and removes XMP plugins only", () => {
    const dir = mkdtempSync(join(tmpdir(), "xmp-plugin-"));
    mkdirSync(join(dir, "ours"));
    writeFileSync(
      join(dir, "ours/plugin.json"),
      JSON.stringify({ name: "Kits", manufacturer: "XMP" }),
    );
    mkdirSync(join(dir, "theirs"));
    writeFileSync(
      join(dir, "theirs/plugin.json"),
      JSON.stringify({ name: "Synth", manufacturer: "Someone" }),
    );
    expect(checkPluginSource(join(dir, "ours"))).toBe("XMP - VST - Kits");
    expect(() => checkPluginSource(join(dir, "theirs"))).toThrow(/not an XMP plugin/);
    expect(() => checkPluginSource(dir)).toThrow(/plugin.json/);
    expect(checkInstalledName("XMP - VST - Kits")).toBe("XMP - VST - Kits");
    expect(() => checkInstalledName("Kits")).toThrow();
    expect(() => checkInstalledName("XMP - VST - ")).toThrow();
    expect(() => checkInstalledName("XMP - VST - ../x/y")).toThrow();
  });
  it("accepts only the fixed commands and never a password or user", () => {
    expect(parseArgs(["192.168.1.20", "list"]).command).toBe("list");
    expect(parseArgs(["setup"]).command).toBe("setup");
    const add = parseArgs(["mpc.local", "add", "build/Kits", "--drive", "XMPPROBE", "--yes"]);
    expect(add).toMatchObject({ items: ["build/Kits"], drive: "XMPPROBE", yes: true });
    expect(() => parseArgs(["10.0.0.2", "import", "x.zip"])).toThrow(/not allowed/);
    expect(() => parseArgs(["10.0.0.2", "shell"])).toThrow(/not allowed/);
    expect(() => parseArgs(["10.0.0.2", "list", "--password", "x"])).toThrow(/not accepted/);
    expect(() => parseArgs(["10.0.0.2", "list", "--user", "admin"])).toThrow(/not accepted/);
    expect(() => parseArgs(["10.0.0.2", "remove"])).toThrow(/at least one/);
    expect(() => parseArgs(["host;rm", "list"])).toThrow(/address/);
  });
  it("pins the host key for its own probe", () => {
    const args = sshArgs("10.0.0.2", 22, "yes", false);
    expect(args).toContain("StrictHostKeyChecking=yes");
    expect(args.some((a) => a.startsWith("UserKnownHostsFile=") && !a.endsWith("/dev/null"))).toBe(
      true,
    );
    expect(args.at(-1)).toBe("root@10.0.0.2");
  });
});

describe("the ssh shim under mpc_remote.py", () => {
  const env = { XMP_MPC_HOST: "10.0.0.2", XMP_MPC_PORT: "22", XMP_MPC_KNOWN_HOSTS: "/k/hosts" };
  const theirs = (host = "10.0.0.2", extra: string[] = []) => [
    "-p",
    "22",
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "UserKnownHostsFile=/dev/null",
    "-o",
    "LogLevel=ERROR",
    "-o",
    "ConnectTimeout=8",
    ...extra,
    `root@${host}`,
    "sh -c 'echo mpc-remote-ok'",
  ];
  it("turns host-key checking back on against the pinned key", () => {
    const { args } = rewrite(theirs(), env);
    expect(args).toContain("StrictHostKeyChecking=yes");
    expect(args).toContain('UserKnownHostsFile="/k/hosts"');
    expect(args).not.toContain("StrictHostKeyChecking=no");
    const keyed = rewrite(theirs(), { ...env, XMP_MPC_IDENTITY: "/k/key" }).args;
    expect(keyed.slice(-6, -4)).toEqual(["-i", "/k/key"]);
  });
  it("refuses other hosts, options, flags and interactive shells", () => {
    expect(() => rewrite(theirs("10.0.0.9"), env)).toThrow(/refused/);
    expect(() => rewrite(theirs("10.0.0.2", ["-o", "ProxyCommand=nc x 22"]), env)).toThrow(
      /refused/,
    );
    expect(() => rewrite(theirs("10.0.0.2", ["-L", "80:x:80"]), env)).toThrow(/refused/);
    expect(() => rewrite(["-p", "22", "root@10.0.0.2"], env)).toThrow(/interactive/);
    expect(() => rewrite(theirs(), {})).toThrow(/only under/);
  });
});

describe("the wrapper agrees with the recorded hardware", () => {
  it("accepts exactly the board and storage layout seen on the owner's Live", async () => {
    const { readFileSync } = await import("node:fs");
    const hw = JSON.parse(
      readFileSync(join(import.meta.dirname, "../os/live-mk1/hardware.json"), "utf8"),
    );
    const info = parseProbe(probe(hw.board.compatible.join(",")));
    info.model = hw.board.model;
    expect(checkIdentity(info, null).version).toBe("3.10.1");
    // The Live's real mounts under /media (MPC OS 3.10.1): all internal, all refused.
    const mounts = ["acvs-content", "az01-internal", "az01-internal-sd"].map((name) => ({
      device:
        name === "az01-internal-sd"
          ? "/dev/mmcblk1p1"
          : name === "acvs-content"
            ? "/dev/root"
            : "/dev/mmcblk0p7",
      mount: `/media/${name}`,
      fstype: "ext4",
      options: ["rw"],
    }));
    for (const m of mounts)
      expect(() => checkDrive(mounts, m.mount.slice(7)), m.mount).toThrow(/internal/);
    expect(Object.keys(hw.mpcOs.mounts)).toContain("/sdcard");
  });
});
