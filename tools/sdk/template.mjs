import { libraryCatalog } from "../../packages/sdk/src/community/package.ts";
export const templateLicense = `MIT License\nCopyright (c) 2026 XMP contributors\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.\n`;
export async function template(kind = "instrument", id = "example-tone") {
  if (!["instrument", "effect"].includes(kind) || !/^[a-z][a-z0-9-]{0,39}$/.test(id))
    throw new Error("Select instrument/effect and a lowercase package id");
  const [math] = await libraryCatalog();
  return {
    manifest: {
      format: "xmp-module",
      apiVersion: 2,
      dspAbi: 1,
      id,
      name: kind === "instrument" ? "Original community tone" : "Original community filter",
      version: "1.0.0",
      stateVersion: 1,
      kind,
      architecture: "portable",
      adapter: "declarative-v1",
      license: "MIT",
      capabilities:
        kind === "instrument"
          ? [
              "notes",
              "velocity",
              "audio-output",
              "simulated-controls",
              "pressure",
              "pitch",
              "timbre",
            ]
          : ["virtual-audio-input", "audio-output", "simulated-controls"],
      parameters: [
        { id: "level", name: "Level", unit: "linear", min: 0, max: 1, default: 0.25 },
        { id: "cutoff", name: "Cutoff", unit: "Hz", min: 20, max: 20000, default: 8000 },
      ],
      dependencies: [{ id: math.id, version: math.version, sha256: math.sha256 }],
    },
    program: {
      format: "xmp-dsp-graph",
      version: 1,
      source: kind === "instrument" ? "sine" : "virtual-input",
      gain: { parameter: "level" },
      cutoff: { parameter: "cutoff" },
      requires: [{ id: math.id, version: math.version }],
      migrations: [],
    },
    license: templateLicense,
  };
}
