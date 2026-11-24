# XMP OS versioning

XMP OS uses [Semantic Versioning 2.0.0](https://semver.org/) starting with **1.0.0**.
The root package.json is the app version source of truth. Public releases use
Git tags and GitHub releases named `vMAJOR.MINOR.PATCH`.

- **PATCH**: backward-compatible fixes to existing behavior.
- **MINOR**: backward-compatible features or additions to documented public interfaces.
- **MAJOR**: incompatible changes to documented public interfaces or supported project import/export contracts.

Use prerelease identifiers such as `1.1.0-beta.1` for previews. Build metadata,
source commits and checksums identify exact binaries separately from app versions.
Published versions and their artifacts are immutable; a changed artifact needs a
new version. Record user-visible changes in CHANGELOG.md.

Project format/schema integers, module versions, SDK compatibility/ABI versions
and required MPC firmware are independent. An app version bump does not silently
change those contracts or expand hardware qualification. Platform support and
known limitations are documented per release.

For the next app release, update workspace versions and lockfile together:

```sh
npm version patch --no-git-tag-version --workspaces --include-workspace-root
# Or select minor, major or an explicit prerelease version.
```

Refresh the manual edition, release notes and installer download manifest; build
and run the affected checks. Tag the final reviewed source commit only after
its release files and validation records are ready. Never move a published tag.

The 1.0.0 installers promote the previously verified binary archives without a
rebuild. Their original embedded build labels remain valid provenance. Installer-only patch releases are versioned independently in
`tools/live-mk1/installer/version.json`. The installer version is stamped into
its UI, resource manifest, macOS bundle and Windows assemblies. A new installer
release does not change the embedded MPC system image or its qualification.
