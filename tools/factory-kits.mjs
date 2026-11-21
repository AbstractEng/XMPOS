// Materialize the repository's checked-in WAV selections as portable kit files
// for both the Live image and web device. No downloads are required.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { root } from "../acceptance/lib/workspace.mjs";
import { drumKitFromWavs } from "../packages/core/src/drum-kits.ts";

const publicDir = join(root, "apps/studio/public");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const config = () => readFile(join(publicDir, "kits/catalog.json"), "utf8").then(JSON.parse);
export const kitImagePath = "/usr/share/xmp/factory-kits";

async function verified(path, descriptor) {
  const bytes = await readFile(join(publicDir, path));
  if (bytes.length !== descriptor.bytes || hash(bytes) !== descriptor.sha256)
    throw new Error(`Factory asset failed verification: ${path}`);
  return bytes;
}

function packKit(kit) {
  const samples = kit.samples.map(({ pcm, ...sample }) => {
    const data = Buffer.alloc(pcm.length * 4);
    for (const [i, value] of pcm.entries()) data.writeFloatLE(value, i * 4);
    const chunks = [];
    for (let i = 0; i < data.length; i += 720)
      chunks.push(data.subarray(i, i + 720).toString("base64"));
    return { ...sample, encoding: "pcm-f32le", frames: pcm.length, chunks };
  });
  return Buffer.from(JSON.stringify({ name: kit.name, samples }));
}

let cache;
export function factoryKits() {
  cache ??= (async () => {
    const { kits } = await config();
    const paths = new Set([
      "kits/licenses/octal/LICENSES.md",
      "kits/licenses/virtuosity/README.md",
    ]);
    const assets = new Map();
    const entries = [];
    const add = (id, name, bytes) => {
      const file = `${id}.xmpkit`;
      entries.push({ id, name, file, bytes: bytes.length, sha256: hash(bytes) });
      assets.set(file, bytes);
    };
    add(
      "xmp-velvet",
      "XMP Velvet · multi-sampled",
      await verified("kits/xmp/xmp-velvet.xmpkit", {
        bytes: 5545162,
        sha256: "ea70e98491a1b6593ea2588b1e7e4deeed4530b7705cef84ffde96956af80e0f",
      }),
    );
    for (const entry of kits) {
      if (entry.license !== "CC0-1.0")
        throw new Error(`Unsupported factory kit license: ${entry.id}`);
      const files = [];
      for (const file of entry.files) {
        files.push({ name: `${file.name}.wav`, bytes: await verified(file.path, file) });
      }
      add(entry.id, entry.name, packKit(drumKitFromWavs(entry.name, files)));
      for (const path of entry.licensePaths) paths.add(path);
    }
    for (const path of paths)
      assets.set(
        path.replace("kits/licenses/", "").replaceAll("/", "-"),
        await readFile(join(publicDir, path)),
      );
    assets.set("index.json", Buffer.from(`${JSON.stringify(entries)}\n`));
    return { entries, assets };
  })();
  return cache;
}

export function factoryKitsPlugin() {
  return {
    name: "xmp-factory-kits",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const prefix = `${server.config.base}factory-kits/`;
        if (!request.url?.startsWith(prefix)) return next();
        try {
          const asset = (await factoryKits()).assets.get(request.url.slice(prefix.length));
          if (!asset) return next();
          response.setHeader("Content-Type", "application/json; charset=utf-8");
          response.end(asset);
        } catch (error) {
          next(error);
        }
      });
    },
    async generateBundle() {
      const { assets } = await factoryKits();
      for (const [name, bytes] of assets)
        this.emitFile({ type: "asset", fileName: `factory-kits/${name}`, source: bytes });
    },
  };
}
