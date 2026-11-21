# XMP SDK developer manual

The installed SDK includes this manual, the instrument/effect templates, a small custom UI/workflow example, compiled ESM exports and TypeScript declarations, and the fixed native conformance processor. It works offline after installing the tarball and declared host prerequisites.

Start with the [installation and conformance guide](../supported-sdk.md), then choose an example:

- [Build an instrument, effect and custom UI](examples.md).
- [API, lifecycle, limits and compatibility](reference.md).
- [Graph, capability, package, project and migration reference](../community-sdk.md).
- [Full OS source and Docker setup](repository-setup.md).

The current SDK profile is Node 24 on macOS/Linux, module API 2, DSP ABI 1, the project version declared in the matching `compatibility.json`, and the bounded declarative offline processor. Imported packages contain data, not executable modules. A custom source-built app and a package dynamically loaded into the Live are different extension paths; native/UI plugin loading is not supplied by this SDK.

## What to install

Obtain the maintainer's verified `xmp-sdk-0.1.0.tgz`, record its SHA-256 and matching source identity, and install it in a new, empty directory outside the XMP checkout. Initialize that Node project first so npm cannot select a parent workspace:

```sh
npm init -y
npm install --offline --ignore-scripts /absolute/path/to/xmp-sdk-0.1.0.tgz
./node_modules/.bin/xmp doctor
./node_modules/.bin/xmp version
```

No registry publication is implied. Node 24 and a C99 compiler are needed for native comparisons; Docker is only needed for the separate full OS source build. Do not install an unknown archive solely because its filename matches.

## Report a problem

Retain the SDK version, source hash from `compatibility.json`, command/exit status, expected versus actual behavior and a small original fixture. Parity reports include numerical/event comparisons and compiler receipts. Exclude personal projects, firmware payloads, passwords, tokens and device serials. Use [project issues](https://github.com/AbstractEng/XMPOS/issues) with the matching release/source identity; do not attach private device logs or owner runtime material.

Code licence: original SDK source is Apache-2.0; the included templates carry their own MIT notices. Third-party dependency licences remain with those dependencies. Native conformance does not qualify real-time deadlines, physical audio latency or hardware drivers.
