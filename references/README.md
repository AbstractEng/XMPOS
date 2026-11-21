# Upstream reference catalog

These checkouts are research material. No upstream build, installation, flash, boot or deployment script has been executed. They live under `references/repos`, which is ignored by the parent repository and excluded from the XMP application build.

`sources.json` records URLs and purposes. `lock.json` records actual clone commits and licence-file locations. These are shallow source checkouts; historical Git objects, submodules, GitHub wikis and binary releases have not been mirrored. General checkouts omit firmware images, shared libraries and compressed archives by extension. Treat any remaining executable-looking file as untrusted reference content.

- **Official inMusic sources:** `akai-az0x-open-source` holds the default-branch overview, and `akai-mpc-g1-3.10` holds the actual `mpc-g1/3.10` source-archive pointers. These are two checkouts of the same official repository. G1 covers the Live Mk1 and Force among other devices.
- **openAZ0x BSP:** `openaz0x-meta-az0x` contains Yocto board support, kernel/device-tree work and hardware notes. Its MPC target is marked not yet verified in this snapshot.
- **Independent application:** `granola-openmpc` provides an MPC One application/runtime reference. Do not assume a Live Mk1 port is complete.
- **MPC-LiveXplore:** `mpc-livexplore`, `mpc-livexplore-libs` and `mpc-livexplore-bootstrap` cover technical research, controller interfaces and boot environments.
- **Historical Hakai:** `hakai-mpc` is the accessible `henning/Hakai-MPC` fork. The original `RedHate/Hakai-MPC` URL is unavailable. This snapshot documents an old Hakai 2.9-era approach, not the current Hakai firmware distribution.
- **Community plugin reference:** `open-mpc-plugins` is the Open MPC plugin development/catalog repository. It is not an official Akai repository.
- **Unavailable:** the BSP links `openAZ0x/meta-openaz0x` as its separate distro layer, but GitHub currently returns repository not found. That dependency is recorded as failed rather than represented by a substitute.

## Official G1 archive payloads

`official-g1-sources.json` catalogs all 72 LFS source archives at the pinned G1 commit, including their expected size and SHA256. Eight selected hardware/audio archives have been downloaded and verified under `references/archives/akai-mpc-g1-3.10`: the AZ01 Linux kernel, ALSA library/utilities/state, device-tree compiler, libusb, libgpiod and libubootenv. These are source archives, not flashable firmware. They have not been built or installed.

The remaining archive payloads are cataloged, not downloaded. LFS pointer text in a checkout must never be mistaken for an extracted source tree. The downloader handles LFS URLs and checks hashes without requiring a global Git LFS installation. Archives remain ignored; the catalog preserves provenance.

## Repeat the reference setup

```sh
npm run refs:pull
npm run refs:sources
```

`refs:pull` initializes missing checkouts and records their current checked-out commit. It intentionally does not pull/merge upstream updates into existing checkouts. The unavailable distro layer makes that command return a nonzero exit status while retaining all successful results. `refs:sources` downloads the selected official archives and verifies their LFS hashes. It never extracts or executes them.

## Update monitoring

The recurring chat monitor checks daily at 9 a.m. America/Toronto and reports meaningful commits, tags, releases and hardware/licence changes. It has no authority to install updates or touch the instruments.

For a manual remote-ref comparison:

```sh
npm run refs:watch
```

This reads remote heads and tags and stores its last successful baseline in ignored `reports/reference-monitor.json`. It never fetches into or modifies the clones. Network failures preserve the previous successful refs. Human-readable release notes still need upstream review; a ref change alone is not a compatibility guarantee.
