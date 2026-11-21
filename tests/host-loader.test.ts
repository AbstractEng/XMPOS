import { describe, expect, it } from "vitest";
import { loaderScript } from "../tools/live-mk1/host-loader.mjs";
import { buildProbeImage } from "../tools/live-mk1/probe-image.mjs";

describe("owner-local host loader", () => {
  it("resolves both known ramdisk addresses without adding new boot commands", () => {
    const source = "xmp.probe=6 @XMP_INITRD_END_0x04000000@ @XMP_INITRD_END_0x49000000@";
    expect(loaderScript(source, 4096)).toBe("xmp.loader=1 0x04001000 0x49001000");
  });
  it("refuses unknown placeholders and unbounded payload sizes", () => {
    expect(() => loaderScript("@XMP_UNKNOWN@", 1)).toThrow(/Unresolved/);
    for (const size of [0, -1, 0.5, Number.NaN, 8 * 1024 ** 2 + 1])
      expect(() => loaderScript("", size)).toThrow(/Bounded/);
  });
  it("does not broaden the private host route into probe construction", async () => {
    await expect(buildProbeImage("not-an-updater", { kind: "probe", host: true })).rejects.toThrow(
      /only the private stick loader/,
    );
  });
});
