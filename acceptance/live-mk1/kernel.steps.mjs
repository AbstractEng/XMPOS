import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { After, AfterAll, Before, Given, setDefaultTimeout, Then, When } from "@cucumber/cucumber";
import { probeHardware } from "../../os/guest/hardware.ts";
import {
  assertLiveTarget,
  auditFragment,
  classifyCompatible,
  describeBoard,
  explicitlyDisabled,
  kernelLock,
  parseKernelConfig,
} from "../../tools/live-mk1/board.mjs";
import { hubStrings } from "../../tools/live-mk1/fdt.mjs";
import {
  bootKernel,
  buildKernel,
  dockerCreateArgs,
  kernelInputsHash,
  verifySource,
} from "../../tools/live-mk1/kernel.mjs";
import { root, writeJson } from "../lib/workspace.mjs";

setDefaultTimeout(600000);
const report = process.env.XMP_LIVE_MK1_EVIDENCE;
if (!report?.startsWith(join(root, "reports/"))) throw new Error("Use npm run bdd:live-mk1");
const lock = kernelLock();
const DTS = "kernel-source/arch/arm/boot/dts/rockchip";
let published;

// Reads selected official device-tree sources from the pinned archive into a
// throwaway directory. Nothing is built or executed from them.
async function officialDeviceTrees() {
  if (published) return published;
  await verifySource();
  const directory = await mkdtemp(join(tmpdir(), "xmp-live-dts-"));
  const names = [
    "rk3288-az01-mpc-acv8.dts",
    "rk3288-az01-mpc-acv8.dtsi",
    "rk3288-az01-mpc-acv5.dts",
    "rk3288-az01-mpc-acv5.dtsi",
    "rk3288-az01-ada2.dts",
    "rk3288-az01-7in-display.dtsi",
    "rk3288-az01-acv8.usbcfg",
    "rk3288-az01-acv5.usbcfg",
    "rk3288-az01-ada2.usbcfg",
  ];
  execFileSync(
    "tar",
    [
      "-xJf",
      resolve(root, lock.source.archive),
      "-C",
      directory,
      ...names.map((n) => `${DTS}/${n}`),
    ],
    { timeout: 300000 },
  );
  const read = (name) => readFile(join(directory, DTS, name));
  published = { directory, read };
  return published;
}
const compatibleOf = (dts) =>
  [...(/compatible\s*=\s*([^;]+);/.exec(dts)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
const modelOf = (dts) => /model\s*=\s*"([^"]+)"/.exec(dts)?.[1] ?? null;

async function latestKernel() {
  const pointer = join(root, "artifacts/live-mk1/latest-kernel.json");
  if (!existsSync(pointer)) return null;
  const directory = resolve(root, JSON.parse(await readFile(pointer, "utf8")).directory);
  try {
    const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
    return manifest.inputsHash === (await kernelInputsHash()) ? { directory, manifest } : null;
  } catch {
    return null;
  }
}

Before(async function ({ pickle }) {
  this.directory = await mkdtemp(join(report, "case-"));
  this.name = pickle.name;
  this.evidence = {};
});
After(async function ({ result }) {
  await writeJson(join(this.directory, "evidence.json"), {
    scenario: this.name,
    status: result?.status,
    physicalAccess: false,
    hardwareQualified: false,
    ...this.evidence,
  });
});
AfterAll(async () => {
  if (published) await rm(published.directory, { recursive: true, force: true });
});

// LK01
Given("the official G1 kernel archive matches its pinned hash", async function () {
  this.evidence.source = await verifySource();
  assert.equal(this.evidence.source.sha256, lock.source.sha256);
});
When("I read the published MPC device trees from the archive", async function () {
  const trees = await officialDeviceTrees();
  this.trees = {};
  for (const code of ["mpc-acv8", "mpc-acv5", "ada2"])
    this.trees[code] = (await trees.read(`rk3288-az01-${code}.dts`)).toString("utf8");
  this.include = {
    acv8: (await trees.read("rk3288-az01-mpc-acv8.dtsi")).toString("utf8"),
    acv5: (await trees.read("rk3288-az01-mpc-acv5.dtsi")).toString("utf8"),
  };
  this.hubs = {};
  for (const code of ["acv8", "acv5", "ada2"])
    this.hubs[code] = hubStrings(await trees.read(`rk3288-az01-${code}.usbcfg`));
});
Then("ACV8 is the MPC Live with a 7-inch panel, an SBS battery and the {string}", function (hub) {
  assert.deepEqual(compatibleOf(this.trees["mpc-acv8"]).slice(0, 2), [
    "inmusic,acv8",
    "inmusic,az01",
  ]);
  assert.match(this.include.acv8, /#include "rk3288-az01-7in-display\.dtsi"/);
  assert.match(this.include.acv8, /"sbs,sbs-battery"/);
  assert.match(this.include.acv8, /inmusic,product-code = "ACV8"/);
  assert.ok(this.hubs.acv8.includes(hub), JSON.stringify(this.hubs.acv8));
  this.evidence.acv8 = { model: modelOf(this.trees["mpc-acv8"]), hub: this.hubs.acv8 };
});
Then("ACV5 is the MPC X and ADA2 is the protected Force", function () {
  assert.match(this.include.acv5, /10in-display/);
  assert.ok(this.hubs.acv5.includes("MPC X Hub"));
  assert.equal(modelOf(this.trees.ada2), "Akai Professional Force");
  assert.ok(this.hubs.ada2.includes("Force Hub"));
  assert.equal(classifyCompatible(compatibleOf(this.trees.ada2)).role, "protected");
  assert.equal(classifyCompatible(compatibleOf(this.trees["mpc-acv5"])).role, "not-target");
  this.evidence.others = { acv5: this.hubs.acv5, ada2: this.hubs.ada2 };
});

// LK02
Given("a substituted kernel archive of the pinned size", async function () {
  this.fake = join(this.directory, "linux-az01-substitute.tar.xz");
  await writeFile(this.fake, Buffer.alloc(lock.source.bytes, 0x5a));
  this.before = existsSync(join(root, "artifacts/live-mk1"))
    ? await readdir(join(root, "artifacts/live-mk1"))
    : [];
});
When("the kernel build verifies its source", async function () {
  const substituted = structuredClone(lock);
  substituted.source.archive = this.fake;
  try {
    await verifySource(substituted);
    this.error = null;
  } catch (error) {
    this.error = error;
  }
  this.realStillVerifies = (await verifySource()).sha256 === lock.source.sha256;
  await rm(this.fake);
});
Then("the build stops before extraction with a pin mismatch", function () {
  assert.match(this.error?.message ?? "", /does not match the pinned hash/);
  assert.equal(this.realStillVerifies, true);
});
Then("no kernel artifact is produced", async function () {
  const after = existsSync(join(root, "artifacts/live-mk1"))
    ? await readdir(join(root, "artifacts/live-mk1"))
    : [];
  assert.deepEqual(after, this.before);
});

// LK03
Given("Docker is running with the pinned builder image", () => {
  const info = spawnSync("docker", ["info", "--format", "{{.OSType}}"], { encoding: "utf8" });
  assert.equal(info.stdout.trim(), "linux", "Start Docker Desktop to run container scenarios");
});
When(
  "I build the official az01 kernel with the XMP virt fragment",
  { timeout: 7200000 },
  async function () {
    this.kernel = (await latestKernel()) ?? (await buildKernel());
    this.evidence.kernel = { directory: this.kernel.directory, manifest: this.kernel.manifest };
  },
);
Then("the zImage is an ARM kernel reporting release 6.18.44-az01", async function () {
  const zImage = await readFile(join(this.kernel.directory, "zImage"));
  assert.equal(zImage.readUInt32LE(0x24), 0x016f2818);
  assert.match(this.kernel.manifest.kernelRelease, /^6\.18\.44-az01/);
  assert.equal(this.kernel.manifest.officialSource.sha256, lock.source.sha256);
});
Then("both ACV8 device trees describe the MPC Live Mk1 target", async function () {
  for (const board of lock.target.boards) {
    const described = assertLiveTarget(
      describeBoard(await readFile(join(this.kernel.directory, board.dtb))),
    );
    assert.equal(described.model, "InMusic MPC ACV8");
    assert.ok(described.compatible.includes(board.soc));
    assert.deepEqual(described.power.battery, ["ti,bq40z50", "sbs,sbs-battery"]);
    assert.equal(described.display.rotation, 270);
    assert.ok(described.usbHub.includes("MPC Live Hub"));
  }
});
Then(
  "the merged configuration keeps every official option and enables real-time, battery, power and USB audio support",
  async function () {
    const official = parseKernelConfig(
      await readFile(join(this.kernel.directory, "official.config"), "utf8"),
    );
    const merged = parseKernelConfig(
      await readFile(join(this.kernel.directory, "merged.config"), "utf8"),
    );
    const disabled = explicitlyDisabled(
      await readFile(join(this.kernel.directory, lock.config.defconfig), "utf8"),
    );
    assert.deepEqual(auditFragment(official, merged, lock.config.required, disabled), []);
    for (const [option, value] of official)
      if (value !== "n") assert.equal(merged.get(option), value, option);
    for (const option of disabled) assert.equal(merged.get(option) ?? "n", "n", option);
    for (const option of [
      "CONFIG_PREEMPT_RT",
      "CONFIG_BATTERY_SBS",
      "CONFIG_AZ01_POWER",
      "CONFIG_SND_USB_AUDIO",
    ])
      assert.equal(merged.get(option), "y", option);
    this.evidence.added = [...merged]
      .filter(([k, v]) => (official.get(k) ?? "n") !== v)
      .map(([k]) => k);
  },
);
Then("the outputs contain no bootloader, flash, update or recovery image", async function () {
  const files = (await readdir(this.kernel.directory)).sort();
  for (const name of files)
    assert.doesNotMatch(name, /u-?boot|idbloader|\.img$|\.bin$|update|recovery|\.itb$|env/i, name);
  assert.equal(this.kernel.manifest.deployable, false);
  this.evidence.files = files;
});

// LK04
When(
  "the board check reads the compatible strings published for the Force and the MPC X",
  async function () {
    const trees = await officialDeviceTrees();
    this.force = compatibleOf((await trees.read("rk3288-az01-ada2.dts")).toString("utf8"));
    this.mpcX = compatibleOf((await trees.read("rk3288-az01-mpc-acv5.dts")).toString("utf8"));
  },
);
Then("both are refused as Live Mk1 targets", function () {
  const board = (compatible) => ({
    model: null,
    compatible,
    ...classifyCompatible(compatible),
    usbHub: [],
    power: { battery: [] },
    display: {},
  });
  assert.throws(() => assertLiveTarget(board(this.force)), /Force is protected/);
  assert.throws(() => assertLiveTarget(board(this.mpcX)), /not the MPC Live Mk1/);
});
Then("the kernel tool rejects flash, deploy and device options", () => {
  for (const args of [
    ["flash"],
    ["deploy"],
    ["build", "--device", "/dev/disk4"],
    ["boot", "--usb"],
  ]) {
    const run = spawnSync(process.execPath, ["tools/live-mk1/kernel.mjs", ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 60000,
    });
    assert.notEqual(run.status, 0, args.join(" "));
    assert.match(run.stderr, /no device, flash or deploy options exist/);
  }
});
Then("the container policy has no network, device or privileged access", () => {
  const args = dockerCreateArgs({
    image: lock.builder.tag,
    volumes: [{ source: "xmp-live-mk1-work", target: "/work" }],
    command: "true",
  });
  assert.ok(args.includes("--cap-drop") && args.includes("none"));
  assert.doesNotMatch(args.join(" "), /--privileged|--device|type=bind|host/);
  for (const source of ["/dev/disk4", "/Users"])
    assert.throws(() =>
      dockerCreateArgs({ image: "x", volumes: [{ source, target: "/work" }], command: "" }),
    );
});

// LK05
Given(
  "the official az01 kernel has been built from the pinned source",
  { timeout: 7200000 },
  async function () {
    this.kernel = (await latestKernel()) ?? (await buildKernel());
  },
);
When(
  "I boot it on the QEMU ARM virt board with XMP's ARMv7 test payload",
  { timeout: 1800000 },
  async function () {
    const { directory, report: boot } = await bootKernel();
    this.boot = boot;
    this.bootLog = await readFile(join(directory, "serial.log"), "utf8");
    this.evidence.boot = { directory, report: boot };
    assert.equal(
      boot.boot.began && boot.boot.ended,
      true,
      `${this.bootLog.slice(-3000)}\n${boot.qemuErrors}`,
    );
  },
);
Then("Linux reports release 6.18.44-az01 with PREEMPT_RT active", function () {
  assert.match(this.boot.boot.version, /Linux version 6\.18\.44-az01/);
  assert.match(this.boot.boot.version, /PREEMPT_RT/);
  assert.equal(this.boot.boot.realtime, "1");
});
Then("XMP's sampler and engine tests pass on the booted ARM kernel", function () {
  const tests = this.boot.tests;
  for (const name of ["sampler", "render-short", "exhaustion", "tempo", "commands", "critical"])
    assert.equal(tests[name]?.exit, 0, `${name}: ${tests[name]?.output}`);
  const canary = JSON.parse(tests.canary.output.trim().split("\n").at(-1));
  for (const key of ["allocations", "locks", "files", "network"]) assert.ok(canary[key] > 0, key);
});
Then("the kernel's USB Audio Class driver binds an emulated USB audio interface", function () {
  assert.ok(
    this.boot.boot.usbDrivers.includes("snd-usb-audio"),
    this.boot.boot.usbDrivers.join(","),
  );
  assert.match(this.boot.boot.soundCards ?? "", /USB-Audio/);
});
Then("the hardware probe classifies the VM as a development host, not a Live Mk1", function () {
  const files = {
    "/proc/device-tree/compatible": this.boot.boot.compatible.join("\0"),
    "/proc/sys/kernel/osrelease": this.boot.boot.version?.split(" ")[2] ?? "",
    "/sys/kernel/realtime": this.boot.boot.realtime ?? "",
    "/proc/asound/cards": this.boot.boot.soundCards ?? "",
  };
  const profile = probeHardware({ read: (p) => files[p] ?? null, list: () => [] });
  assert.equal(profile.status, "development-host");
  assert.equal(profile.kernel.officialAz01, true);
  assert.equal(profile.kernel.realtime, true);
  assert.equal(profile.audio.usbAudio, "present");
  this.evidence.probe = profile;
});

// LK06 / LK07
const acv8Snapshot = {
  "/proc/device-tree/compatible": "inmusic,acv8\0inmusic,az01\0rockchip,rk3288\0",
  "/proc/device-tree/model": "InMusic MPC ACV8\0",
  "/proc/sys/kernel/osrelease": "6.18.44-az01-2026-08-10\n",
  "/sys/kernel/realtime": "1\n",
  "/sys/class/power_supply/az01-ac-power/type": "Mains\n",
  "/sys/class/power_supply/az01-ac-power/online": "1\n",
  "/sys/class/power_supply/sbs-3-000b/type": "Battery\n",
  "/sys/class/power_supply/sbs-3-000b/capacity": "64\n",
  "/proc/asound/cards": " 0 [Live           ]: USB-Audio - MPC Live\n",
  "/sys/class/drm/card0-DSI-1/status": "connected\n",
  "/sys/class/input/input0/name": "ili2117\n",
};
function snapshotReader(files, seen) {
  return {
    read: (path) => {
      seen.push(path);
      return files[path] ?? null;
    },
    list: (path) => {
      seen.push(path);
      return [
        ...new Set(
          Object.keys(files)
            .filter((p) => p.startsWith(`${path}/`))
            .map((p) => p.slice(path.length + 1).split("/")[0]),
        ),
      ].sort();
    },
  };
}
Given("a system snapshot derived from the official ACV8 device tree", function () {
  this.snapshot = acv8Snapshot;
});
Given("a system snapshot whose device tree identifies the Force", function () {
  this.snapshot = {
    ...acv8Snapshot,
    "/proc/device-tree/compatible": "inmusic,ada2\0inmusic,az01\0rockchip,rk3288\0",
    "/proc/device-tree/model": "Akai Professional Force\0",
  };
});
When("XMP probes the hardware read-only", function () {
  this.seen = [];
  this.profile = probeHardware(snapshotReader(this.snapshot, this.seen));
  this.evidence.profile = this.profile;
  this.evidence.pathsRead = this.seen;
});
Then("it reports battery, mains power, USB audio, the DSI panel and touch input", function () {
  assert.equal(this.profile.power.battery.capacity, 64);
  assert.equal(this.profile.power.mains.online, true);
  assert.equal(this.profile.audio.usbAudio, "present");
  assert.equal(this.profile.display.dsi, "present");
  assert.equal(this.profile.input.touch, "present");
  assert.deepEqual(this.profile.missing, []);
});
Then("it marks the Live Mk1 unverified until exact-unit evidence exists", function () {
  assert.equal(this.profile.status, "live-mk1-unverified");
  assert.equal(this.profile.hardwareQualified, false);
  assert.ok(this.seen.every((p) => /^\/(proc|sys)\//.test(p)));
});
Then("discovery stops after reading the identity files", function () {
  assert.deepEqual(this.seen, ["/proc/device-tree/compatible", "/proc/device-tree/model"]);
});
Then("XMP refuses to run on the protected instrument", function () {
  assert.equal(this.profile.status, "refused-protected");
  assert.equal(this.profile.identity.product, "Akai Professional Force");
  assert.equal(this.profile.power, undefined);
});
