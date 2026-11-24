# Changelog

## Installer 1.0.1 — 2026-11-24

- Repair the verified Live Mk1’s existing Windows WinUSB interface registration
  when Device Manager sees it but fastboot cannot. Back up the registration,
  preserve existing GUIDs and the driver, and require owner confirmation and elevation.
- Explain missing and incompatible Windows drivers in read-only inspection.
- Rebuild Intel Mac, Apple Silicon Mac and Windows x64 installer packages with
  installer version 1.0.1 in the UI and native executable metadata.
- Add regression tests for USB diagnostics, scoped registry repair and bundle
  checksums when rebuilding a previous package.
- Keep the MPC system image, host runtimes and app/session version at 1.0.0.

Windows read-only detection passed with a physical Live through a Windows 11 VM.
Physical Windows PC flashing and Apple Silicon laptop testing remain pending.

## 1.0.0 — 2026-11-23

- Establish Semantic Versioning for XMP OS and coordinate app/workspace versions.
- Publish the community source, web client and graphical Intel Mac, Apple Silicon
  Mac and Windows x64 installer downloads under the 1.0.0 release identity.
- Retain the verified installer payloads and exact sources/notices unchanged.
- Include the released Night Shift first-web-visit demo and saved-project restore.
- Include anonymous, opt-out web usage analytics and the owner-only aggregate dashboard.
- Keep Acid Circuit on fresh hardware keys, preserving existing projects.
- Keep the setup videos visible, detailed instructions collapsed and the public
  source/download links available on the website and in the manual.

The Intel Mac install/play/save/reopen/stock-restoration rehearsal passed. Apple
Silicon laptop testing and Windows physical driver/flash qualification remain
pending. This version number does not expand the supported hardware scope.

See [release status](RELEASE.md), [known issues](docs/known-issues.md) and
[versioning policy](VERSIONING.md).
