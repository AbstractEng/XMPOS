import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bridgeCommand, frame, openBridge } from "../tools/live-mk1/bridge.mjs";
import { prepareStickToken } from "../tools/live-mk1/stick-token.mjs";
import { verifyOwnerImage } from "../tools/live-mk1/verify-owner-image.mjs";

describe("bridge update boundaries", () => {
  it.each([
    [{ ok: true, protocol: 1, board: "inmusic,acv8 rockchip,rk3288" }, true],
    [{ ok: true, protocol: 1, board: "inmusic,acv8\0rockchip,rk3288" }, true],
    [{ ok: false, protocol: 1, board: "inmusic,acv8", error: "wrong token" }, false],
    [{ ok: true, protocol: 9, board: "inmusic,acv8" }, false],
    [{ ok: true, protocol: "1", board: "inmusic,acv8" }, false],
    [{ ok: true, protocol: 1, board: "inmusic,acv8-unapproved" }, false],
    [{ ok: true, protocol: 1, board: "inmusic,acva" }, false],
    [{ ok: true, protocol: 1, board: "inmusic,acv8 inmusic,ada2" }, false],
    [{ ok: true, protocol: 1, board: "inmusic,force" }, false],
  ])("validates the exact hello: %j", async (hello, accepted) => {
    const directory = await mkdtemp(join(tmpdir(), "xmp-hello-"));
    const socket = join(directory, "bridge.sock");
    const requests: unknown[] = [];
    const connections = new Set<import("node:net").Socket>();
    const server = createServer((connection) => {
      connections.add(connection);
      let bytes = Buffer.alloc(0);
      connection.on("data", (data) => {
        bytes = Buffer.concat([bytes, data]);
        if (bytes.length < 4 || bytes.length < 4 + bytes.readUInt32BE(0)) return;
        requests.push(JSON.parse(bytes.subarray(4).toString()));
        connection.write(frame(JSON.stringify(hello)));
      });
    });
    await new Promise<void>((ok) => server.listen(socket, ok));
    try {
      if (accepted) (await openBridge({ socket, token: "fixture" })).close();
      else await expect(openBridge({ socket, token: "fixture" })).rejects.toThrow();
      expect(requests).toEqual([{ cmd: "hello", token: "fixture" }]);
    } finally {
      for (const connection of connections) connection.destroy();
      await new Promise<void>((ok) => server.close(() => ok()));
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("creates distinct stick tokens and reconnects using the selected stick", async () => {
    const directory = await mkdtemp(join(tmpdir(), "xmp-token-"));
    const mac = join(directory, "mac-token");
    try {
      await writeFile(mac, `${"a".repeat(48)}\n`);
      await prepareStickToken(join(directory, "one"), mac);
      const one = await readFile(mac, "utf8");
      await prepareStickToken(join(directory, "two"), mac);
      const two = await readFile(mac, "utf8");
      expect(one).toMatch(/^[a-f0-9]{48}\n$/);
      expect(two).not.toBe(one);
      expect(one.trim()).not.toBe("a".repeat(48));
      await prepareStickToken(join(directory, "one"), mac);
      expect(await readFile(mac, "utf8")).toBe(one);
      await rm(join(directory, "one/xmp/bridge.token"));
      await symlink(mac, join(directory, "one/xmp/bridge.token"));
      await expect(prepareStickToken(join(directory, "one"), mac)).rejects.toThrow();
      expect(await readFile(mac, "utf8")).toBe(one);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses a blob without a manifest before sending any bridge request", async () => {
    const directory = await mkdtemp(join(tmpdir(), "xmp-push-"));
    let requests = 0;
    const bridge = {
      request: async () => {
        requests++;
        return { ok: false };
      },
    };
    try {
      const image = join(directory, "system.img");
      await writeFile(image, "not an image");
      await expect(bridgeCommand(bridge, "push", [image], directory)).rejects.toThrow();
      expect(requests).toBe(0);
      await writeFile(
        join(directory, "manifest.json"),
        JSON.stringify({
          format: "xmp-live-mk1-owner-session-image",
          version: 1,
          target: "inmusic,ada2",
        }),
      );
      await expect(verifyOwnerImage(image)).rejects.toThrow(/3.10.1 manifest/);
      await rm(join(directory, "manifest.json"));
      await symlink(image, join(directory, "manifest.json"));
      await expect(verifyOwnerImage(image)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
