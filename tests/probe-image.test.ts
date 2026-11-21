import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkUpdater, diffLedgers, EXPECTED_CHANGES } from "../tools/live-mk1/probe-image.mjs";

const ledger = (entries: Record<string, string>) =>
  Object.entries(entries)
    .map(([path, value]) => `./${path}\t644\t${value}`)
    .join("\n");

describe("probe image change audit", () => {
  const original = ledger({ "boot/boot.scr.uimg": "a", "usr/bin/MPC": "b", "etc/hostname": "c" });

  it("reports exactly the expected /boot edits", () => {
    const result = ledger({
      "boot/boot.scr.uimg": "x",
      "usr/lib/xmp/xmp-probe-report": "r",
      "usr/lib/systemd/system/xmp-probe-report.service": "s",
      "usr/lib/systemd/system/multi-user.target.wants/xmp-probe-report.service": "s",
      "usr/bin/MPC": "b",
      "etc/hostname": "c",
    });
    expect(diffLedgers(original, result)).toEqual(EXPECTED_CHANGES);
  });

  it("exposes any change outside /boot, including mode-only changes", () => {
    const tampered = ledger({ "boot/boot.scr.uimg": "x", "usr/bin/MPC": "b", "etc/hostname": "c" })
      .replace("./usr/bin/MPC\t644", "./usr/bin/MPC\t755")
      .concat("\n./etc/extra\t644\tz");
    expect(diffLedgers(original, tampered)).toEqual({
      changed: ["boot/boot.scr.uimg", "usr/bin/MPC"],
      added: ["etc/extra"],
      removed: [],
    });
  });
});

describe("updater check", () => {
  it("accepts only an app bundle that contains an update image", () => {
    const folder = mkdtempSync(join(tmpdir(), "xmp-updater-"));
    try {
      expect(() => checkUpdater(join(folder, "not-an-app"))).toThrow(/updater app/);
      expect(() => checkUpdater(join(folder, "Fake.app"))).toThrow(/updater app/);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});

describe("probe boot script v2", () => {
  const script = readFileSync("os/live-mk1/xmp-probe.boot.cmd", "utf8")
    .split("\n")
    .filter((line) => line.trim() && !line.trim().startsWith("#"));
  it("uses only Akai's multi-line if style, never if/then on one line", () => {
    for (const line of script) expect(line).not.toMatch(/;\s*(then|fi|else)\b/);
    expect(script.filter((l) => /^\s*if\b/.test(l)).length).toBe(
      script.filter((l) => /^\s*fi\s*$/.test(l)).length,
    );
  });
  it("extracts the probe from its own image before loading anything over it", () => {
    const text = script.join("\n");
    expect(text.indexOf("imxtract ${scriptaddr} 1 ${ramdisk_addr_r}")).toBeGreaterThan(-1);
    expect(text.indexOf("imxtract")).toBeLessThan(text.indexOf("load "));
    expect(text).not.toMatch(/\$\{prefix\}xmp\//);
  });
  it("passes the initramfs through /chosen, never through bootz's ramdisk argument", () => {
    const text = script.join("\n");
    expect(text).toContain("fdt chosen ${ramdisk_addr_r} ${xmp_initrd_end}");
    expect(text).toContain("@XMP_INITRD_END_0x04000000@");
    for (const line of script.filter((l) => /^\s*bootz\b/.test(l)))
      expect(line.trim()).toBe("bootz ${kernel_addr_r} - ${fdt_addr_r}");
  });
  it("uses only U-Boot commands proven on the Live or used by Akai's own script", () => {
    // U-Boot 2016.05-inmusic: imxtract, fdt chosen and bootz with "-" ran on the unit
    // (v4-v6); load, test, setenv, fdt addr/resize/apply, bootz and exit are in Akai's
    // boot.scr. setexpr is missing (v5). Anything new must be proven before it is used.
    const proven = new Set([
      "echo",
      "setenv",
      "if",
      "then",
      "fi",
      "test",
      "imxtract",
      "load",
      "fdt",
      "bootz",
    ]);
    const fdt = new Set(["addr", "resize", "apply", "chosen", "print"]);
    for (const line of script) {
      const words = line.trim().split(/\s+/);
      expect(proven, line).toContain(words[0]);
      if (words[0] === "fdt") expect(fdt, line).toContain(words[1]);
    }
  });
  it("uses only commands the Live's U-Boot 2016.05 has shown it supports", () => {
    // v5 on the Live: setexpr is missing. Keep arithmetic out of the script.
    expect(script.join("\n")).not.toMatch(/\bsetexpr\b|\$\(\(/);
  });
  it("boots Akai's kernel and never sources another script", () => {
    expect(script.join("\n")).toContain("${prefix}zImage ||");
    expect(script.join("\n")).not.toMatch(/xmp\/zImage|\bsource\b|\breset\b|\bsaveenv\b/);
  });
});

describe("probe report service", () => {
  const unit = readFileSync("os/live-mk1/xmp-probe-report.service", "utf8");
  it("runs only the XMP probe binary, unprivileged in scheduling, without blocking boot", () => {
    expect(unit).toMatch(/^ExecStart=\/usr\/lib\/xmp\/xmp-probe-report$/m);
    expect(unit).toMatch(/^Type=simple$/m);
    expect(unit.match(/^Exec\w*=/gm)).toHaveLength(1);
  });
});
