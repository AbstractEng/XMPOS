# Native Live session component and licence review

**Status: candidate-aware source/relink kit implemented; final exact-artifact and owner installation evidence still required.** Launch support is MPC Live Mk1 / ACV8 running exactly MPC OS **3.10.1**. The selected design ships XMP code/font data and has each owner extract runtime libraries locally from their signed updater onto USB. This reduces the files XMP distributes. It does not retroactively remove statically linked code from the existing development image.

| Component                                     | Existing static session        | Selected public route             | Review result                                                                                                                        |
| --------------------------------------------- | ------------------------------ | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| XMP init/session/bridge                       | Included                       | Included                          | Apache-2.0 source and recipes bundled; new image must match source snapshot                                                          |
| ALSA 1.2.11                                   | Static library and config      | Shared library/config owner-local | Exact patched archive and LGPL/per-file notices available; no public shared binary planned                                           |
| libc, libm, pthread/dl/rt, loader             | Static C runtime included      | Shared files owner-local          | Nine-library runtime pinned; host-route startup origins pinned; full source/notices and relink objects supplied by the candidate kit |
| libstdc++ / libgcc                            | Static code included           | Shared files owner-local          | legacy provenance unresolved; host-route GCC sources, exception notices and used headers included                                    |
| Inter 4.1 / JetBrains Mono 2.304              | Embedded glyph atlas           | Embedded glyph atlas              | Exact TTF release inputs and full OFL notices included; keep generated font data under OFL                                           |
| stb_truetype                                  | Host atlas generator           | Source/build tool                 | Pinned header and MIT notice included; not linked into Live runtime                                                                  |
| Akai kernel/DTB, loader, apps                 | Owner-local boot files         | Owner-local only                  | Never in public image/source/press archives                                                                                          |
| Other G1 tools, emulator twin, radio firmware | Separate development artifacts | Excluded                          | No clearance claimed for later additions or other XMP image families                                                                 |

The real signed updater's extracted runtime passes offline file hashes and declared dependency/version-table consistency checks: **87 files / 5,325,196 bytes**, including **nine libraries**. These checks do not execute XMP or establish complete ABI compatibility. Do not infer firmware version from `/etc/os-release` (that describes the Yocto distribution); the exact reviewed updater payload hash identifies this baseline.

## Materials and reproducible review command

- [Draft notices](THIRD-PARTY-NOTICES.txt) and [full licence texts](licenses/).
- [Build instructions and migration gaps](BUILDING.md).
- [Relink instructions and evidence limits](STATIC-LINKING.md).
- Runtime and updater metadata: `os/live-mk1/mpc-runtime.lock.json`.

From a **clean committed checkout**, with the pinned font/ALSA inputs fetched into the ignored reference cache:

```sh
python3 tools/live-mk1/licensing-inputs.py --fetch
python3 tools/live-mk1/source-review.py artifacts/r01-source-review --template artifacts/live-mk1/<dynamic-template>
```

The template must be built from the same clean committed source with the current Mac host recipe. This creates `THIRD-PARTY-NOTICES.txt` with appended licence texts, `corresponding-source.tar.gz`, `review.json` and `SHA256SUMS`. The source tar contains that committed XMP tree, font inputs, stb, patched ALSA, exact glibc/GCC upstream sources and Debian changes/cross wrappers, actual used development/Clang header sources, original objects/maps/normalized commands, licences and rebuild/relink instructions. It excludes owner runtime/updater images and private workspace files. The complete XMP source snapshot also contains existing browser/brand assets; their Manrope OFL and optional sample CC0/Unlicense notices are preserved inside the snapshot and referenced in the review metadata. They are not native-image components. `review.json` identifies complete candidate source materials while leaving `publicRedistributionApproved: false`; final clearance still needs the exact component and owner installation receipts. The legacy invocation without `--template` remains a blocked historical review kit. The filename is a review container, not a claim that corresponding source for an approved binary is complete.

## Historical 18 November Gate 1 result

The older frozen community candidate's component/source audit, owner installation/
recovery evidence and eight-file package gate passed on 18 November. The
[clearance record](../launch/gate-1-clearance.md) identifies exact hashes,
installer source/runtime materials, first-install verification and limitations.
The original source-kit `review.json` remains an immutable preparation receipt;
its pending label is superseded only by the matching final clearance record.
Publication remains on hold. Rebuilds or new dependencies require affected
reviews and matching receipts; legacy static/private runtime images remain
ineligible. No change here grants permission to redistribute Akai artifacts.

**Current candidate:** 0.1.0-dev.20261121 has audited source/notices and exact relink materials staged with both installers, but final exact-file redistribution clearance and physical observations remain pending. Neither the older clearance nor the private kit upload changes `publicRedistributionApproved: false`. See [current release status](../../RELEASE.md).

The ELF audit checks actual files/dependencies; linker commands, retained objects and source inputs identify the startup/header contributions. The host-only assessment is documented in [owner-local-review.md](owner-local-review.md). Adding components or using a different compiler recipe requires a new matching review. Owner-local shared libraries remain outside the public download.
