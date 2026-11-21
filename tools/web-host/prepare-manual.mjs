// Publish a manual-only update while retaining the app currently served publicly.
// Run the hosted Vite build first. All remote requests are read-only, same-origin.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants, cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { checkKits } from "./check-kits.mjs";
import { prepareMediaSizes } from "./media-sizes.mjs";

const root = resolve(import.meta.dirname, "../.."),
  source = resolve(root, "dist-hosted"),
  dest = resolve(root, "build/web-assets/xmpos"),
  work = resolve(root, "artifacts/tutorials/colour-sketches");
const site = new URL("https://abstracteng.com/xmpos/");
const sha = (b) => createHash("sha256").update(b).digest("hex");
await mkdir(work, { recursive: true });
assert.ok((await readFile(resolve(source, "manual/index.html"), "utf8")).includes("/xmpos/"));
await readFile(resolve(dest, "index.html")); // An existing browser-only asset baseline is required.
const filenames = (await readdir(resolve(dest, "manual-media"))).filter((n) =>
  /\.(mp4|webm|wav|xmpsong|vtt)$/.test(n),
);
const preserved = await Promise.all(
  filenames.map(async (n) => ({
    file: n,
    sha256: sha(await readFile(resolve(dest, "manual-media", n))),
  })),
);
const dependencies = (code, parent) => {
  const values = [
    ...code.matchAll(/["'`]([^"'`\s]+?\.(?:js|css|woff2?|svg|png|jpg))(?:[?#][^"'`\s]*)?["'`]/g),
  ].map((m) => m[1]);
  values.push(...[...code.matchAll(/url\(\s*['"]?([^\s)'" ]+)/g)].map((m) => m[1]));
  return values.flatMap((value) => {
    try {
      const url = new URL(value, value.startsWith("assets/") ? site : parent);
      return url.origin === site.origin &&
        url.pathname.startsWith("/xmpos/assets/") &&
        /\.(?:js|css|woff2?|svg|png|jpg)$/.test(url.pathname)
        ? [url.pathname]
        : [];
    } catch {
      return [];
    }
  });
};
const remote = async (path) => {
  const url = new URL(path, site);
  assert.equal(url.origin, site.origin);
  assert.ok(url.pathname.startsWith("/xmpos/"));
  const response = await fetch(url, { signal: AbortSignal.timeout(20000), cache: "no-store" });
  assert.equal(response.status, 200, url.href);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.ok(bytes.length < 4 * 1024 * 1024, "Unexpectedly large browser asset");
  return bytes;
};
const write = async (path, bytes) => {
  assert.ok(path.startsWith("/xmpos/"));
  const relative = path.slice("/xmpos/".length);
  const target = resolve(dest, relative);
  assert.ok(target.startsWith(`${dest}/`));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
};
const index = await remote("/xmpos/");
const queue = dependencies(index.toString(), site),
  seen = new Set(),
  appAssets = [];
for (let i = 0; i < queue.length; i++) {
  const path = queue[i];
  if (seen.has(path)) continue;
  seen.add(path);
  assert.ok(seen.size <= 100, "Unexpected browser dependency graph");
  const bytes = await remote(path);
  await write(path, bytes);
  appAssets.push({ path, sha256: sha(bytes) });
  if (/\.(?:js|css)$/.test(path))
    queue.push(...dependencies(bytes.toString(), new URL(path, site)));
}
await write("/xmpos/index.html", index);
const manual = await readFile(resolve(source, "manual/index.html"));
const guideQueue = dependencies(manual.toString(), new URL("manual/", site)),
  guideSeen = new Set();
for (let i = 0; i < guideQueue.length; i++) {
  const path = guideQueue[i];
  if (guideSeen.has(path)) continue;
  guideSeen.add(path);
  assert.ok(guideSeen.size <= 20);
  const relative = path.slice("/xmpos/".length),
    file = resolve(source, relative);
  assert.ok(file.startsWith(`${source}/assets/`));
  const bytes = await readFile(file);
  await write(path, bytes);
  if (/\.(?:js|css)$/.test(path))
    guideQueue.push(...dependencies(bytes.toString(), new URL(path, site)));
}
await write("/xmpos/manual/index.html", manual);
// The current local course is part of this manual. A separate app deployment
// may have served an older course again; restore these already-reviewed assets.
const course = JSON.parse(
  await readFile(resolve(source, "manual-media/course-videos.json"), "utf8"),
);
for (const lesson of course.lessons)
  assert.equal(
    sha(await readFile(resolve(source, `manual-media/${lesson.id}.mp4`))),
    lesson.sha256,
  );
await cp(resolve(source, "manual-media"), resolve(dest, "manual-media"), {
  recursive: true,
  mode: constants.COPYFILE_FICLONE,
});

for (const p of preserved)
  assert.equal(
    sha(await readFile(resolve(dest, "manual-media", p.file))),
    p.sha256,
    "Existing course media changed",
  );
assert.equal(
  sha(await remote("/xmpos/")),
  sha(index),
  "The live app changed during preparation; prepare again",
);
const report = {
  publicAppIndex: sha(index),
  appAssets,
  preservedMedia: preserved,
  guideAssets: [...guideSeen],
  manualSha256: sha(manual),
  scope: "manual only; existing public app and course media retained",
};
// The app fetches its drum kits at runtime, outside the dependency graph above.
await cp(resolve(source, "kits"), resolve(dest, "kits"), { recursive: true });
checkKits(dest);
prepareMediaSizes(dest);
await writeFile(resolve(work, "prepared.json"), JSON.stringify(report, null, 2));
console.log(
  JSON.stringify({
    appAssetsRetained: appAssets.length,
    guideAssets: guideSeen.size,
    unchangedCourseMedia: preserved.length,
  }),
);
