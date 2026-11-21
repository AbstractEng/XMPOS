import { describe, expect, it } from "vitest";
import { prunable } from "../tools/live-mk1/prune-artifacts.mjs";

describe("pruning old Live build output", () => {
  const names = [
    ...["aaaaa1", "aaaaa2", "aaaaa3", "aaaaa4", "aaaaa5"].map((n) => `session-vm-${n}`),
    ...["bbbbb1", "bbbbb2", "bbbbb3", "bbbbb4", "bbbbb5", "bbbbb6"].map(
      (n) => `session-image-${n}`,
    ),
    "kernel-LpCJNU",
    "stock-rootfs-SNAPSHOT-20261014152523.ext4",
    "mpc-ssh-key",
    "session-vm-notes",
    "updater-3.10.1",
  ];
  // A higher last digit is newer.
  const age = (n: string) => Number(n.at(-1));
  it("keeps the newest runs and images, and never anything else", () => {
    expect(prunable(names, { age }).sort()).toEqual([
      "session-image-bbbbb1",
      "session-image-bbbbb2",
      "session-vm-aaaaa1",
      "session-vm-aaaaa2",
    ]);
  });
  it("keeps what a pointer names or the docs cite", () => {
    expect(
      prunable(names, {
        age,
        pointed: new Set(["session-image-bbbbb1"]),
        cited: new Set(["session-vm-aaaaa2"]),
      }).sort(),
    ).toEqual(["session-image-bbbbb2", "session-vm-aaaaa1"]);
  });
});
