import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Fraction of full CPU speed the host currently allows (1 = unthrottled).
// macOS reports CPU_Speed_Limit via pmset; Linux exposes cpufreq limits.
// Returns null when the platform does not report it.
export function hostCpuSpeedFraction() {
  if (process.platform === "darwin") {
    const out =
      spawnSync("pmset", ["-g", "therm"], { encoding: "utf8", timeout: 5000 }).stdout ?? "";
    const match = /CPU_Speed_Limit\s*=\s*(\d+)/.exec(out);
    return match ? Number(match[1]) / 100 : null;
  }
  try {
    const cap = Number(
      readFileSync("/sys/devices/system/cpu/cpu0/cpufreq/scaling_max_freq", "utf8"),
    );
    const max = Number(
      readFileSync("/sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq", "utf8"),
    );
    return cap > 0 && max > 0 ? cap / max : null;
  } catch {
    return null;
  }
}

// Emulated real-time timing is only meaningful on an unthrottled host.
export function assertHostNotThrottled(minimum = 0.9) {
  const fraction = hostCpuSpeedFraction();
  if (fraction !== null && fraction < minimum)
    throw new Error(
      `Host CPU is thermally throttled to ${Math.round(fraction * 100)}% of full speed; emulated real-time timing is not meaningful. Let the machine cool and rerun.`,
    );
  return fraction;
}
