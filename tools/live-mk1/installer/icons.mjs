import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const dir = import.meta.dirname;
const temp = resolve(dir, "../../../build/installer-icons");
await mkdir(temp, { recursive: true });
const set = join(temp, "XMPInstaller.iconset");
await mkdir(set, { recursive: true });
for (const size of [16, 32, 128, 256, 512])
  for (const scale of [1, 2])
    execFileSync(
      "/usr/bin/sips",
      [
        "-z",
        String(size * scale),
        String(size * scale),
        join(dir, "icon-master.png"),
        "--out",
        join(set, `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`),
      ],
      { stdio: "ignore" },
    );
execFileSync("/usr/bin/iconutil", ["-c", "icns", set, "-o", join(dir, "icon.icns")]);
const entries = [];
for (const size of [16, 24, 32, 48, 64, 128, 256]) {
  const p = join(temp, `${size}.png`);
  execFileSync(
    "/usr/bin/sips",
    ["-z", String(size), String(size), join(dir, "icon-master.png"), "--out", p],
    { stdio: "ignore" },
  );
  entries.push({ size, data: await readFile(p) });
}
const header = Buffer.alloc(6 + 16 * entries.length);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(entries.length, 4);
let offset = header.length;
entries.forEach(({ size, data }, i) => {
  const at = 6 + i * 16;
  header[at] = size === 256 ? 0 : size;
  header[at + 1] = size === 256 ? 0 : size;
  header.writeUInt16LE(1, at + 4);
  header.writeUInt16LE(32, at + 6);
  header.writeUInt32LE(data.length, at + 8);
  header.writeUInt32LE(offset, at + 12);
  offset += data.length;
});
await writeFile(join(dir, "icon.ico"), Buffer.concat([header, ...entries.map((e) => e.data)]));
console.log("Created macOS ICNS and Windows multi-resolution ICO from the logo icon master.");
