# Relink instructions and unresolved evidence

The selected release architecture uses the owner's **replaceable shared libraries on USB**. Rebuild XMP from the supplied source and link against the desired ABI-compatible library version; retain the same public interfaces, interpreter and permitted hardware boundaries. Do not add signatures or checks that prevent the owner from replacing LGPL libraries in their own local USB image. Integrity checks for the distributed candidate must not be presented as a restriction on modification.

The [dynamic build and local image assembler](../live-mk1-owner-runtime.md) are implemented, with retained objects/maps/commands and an ARM runtime test. The latest private candidate’s archived objects and command arrays reproduced its unstripped session, shipped session-image and runtime probe byte for byte. Final public hardware clearance remains separate; the historical static image is not qualified by that result.

## Legacy static build reconstruction

`tools/live-mk1/session-image.mjs` documents the current recipe. Build ALSA 1.2.11 from the included patched source, using its exact configure line, in the recorded Linux cross-build container. Preserve `/stage/opt/g1/include`, `lib/libasound.a` and `share/alsa`, plus configure/build logs. Generate the font atlas with `tools/fonts.mjs`. Compile these translation units **separately to unstripped objects**:

```sh
arm-linux-gnueabihf-g++ -std=c++17 -O2 -mcpu=cortex-a17 -mfpu=neon-vfpv4 -mfloat-abi=hard \
  -Wall -Wextra -Werror -Inative/include -Ibuild/fonts -I/stage/opt/g1/include \
  -c native/src/live_session.cpp -o live_session.o
# Repeat identical flags for native/src/engine.cpp and native/src/rt_thread.cpp.
arm-linux-gnueabihf-g++ -static -mcpu=cortex-a17 -mfpu=neon-vfpv4 -mfloat-abi=hard \
  live_session.o engine.o rt_thread.o -L/stage/opt/g1/lib \
  -Wl,-Map=session.map -lasound -lpthread -lm -ldl -lrt -o session.unstripped
```

For `os/live-mk1/session-init.c` and `os/live-mk1/xmp-bridge.c`, use the recipe's GNU C11 flags and `-Ios/live-mk1`; compile with `-c`, then link each object with the same cross GCC, `-static` and a linker map. Keep a separate emulator-init object compiled with `-DXMP_SESSION_EMULATOR`; the twin is emulator-only and must not be placed in the public image.

Replace the relevant library archive with a modified compatible build and repeat the link. Rebuild/repopulate an image with the resulting binaries and font notices using the image recipe. Keep unstripped objects, source inputs, commands, compiler/package inventories, linker scripts, maps, configure logs and the archive of every linked library version in the release kit. Record a successful changed-library relink and VM run before claiming this route works.

The existing image was stripped and its original objects/maps were not retained. Its libc and GCC runtime origins are not proven by records from other Docker image IDs. **These reconstruction commands do not repair that provenance gap.** Do not substitute inMusic's GCC 13/glibc 2.39 sources for an unproven Debian compiler/libc used in the static image.

## Licence review references

The LGPL static-linking rule depends on the actual licence/version and supplied relink or rebuild materials; shipping source alone does not establish that those materials are sufficient. See [FSF static/dynamic linking FAQ](https://www.gnu.org/licenses/gpl-faq.html#LGPLStaticVsDynamic) and [LGPL 2.1 section 6](https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html). The GCC exception applies to files carrying that exception and eligible compilation, not automatically to every dependency: [text](https://www.gnu.org/licenses/gcc-exception-3.1.html), [FSF FAQ](https://www.gnu.org/licenses/gcc-exception-3.1-faq.html). Font notices and modified-font conditions remain under [OFL 1.1](https://openfontlicense.org/open-font-license-official-text/).

## Supplied host dynamic relink materials

For the candidate-aware source kit, extract sources/relink-materials.tar.gz into a new local directory. objects/ contains both XMP and the exact copied CRT objects; link-maps/ and toolchain/commands.json record the real link. The glibc/GCC/Clang and interface sources/notices are separate entries in the outer kit. Paths are normalized as $XMP_SOURCE, $XMP_BUILD, $XMP_RUNTIME and $XMP_COMPILER to exclude private host paths. Set XMP_COMPILER to the directory containing the pinned Zig 0.13.0 executable (with its lib/ directory beside it), XMP_SOURCE to the extracted matching XMP source, XMP_BUILD to your new relink directory, and XMP_RUNTIME to your owner-local ABI-compatible runtime. These are literal placeholders in command arrays: substitute their values before executing each argument; do not pass them through an arbitrary shell.

To relink without recompiling XMP, copy objects/ into a new build directory and create link-maps/. Use the pinned Zig executable with the commands whose mode is ld.lld; substitute your source, new build directory and local ABI-compatible runtime paths. Replace each .headers/.../crt1.o, crti.o, crtn.o, crtbegin.o or crtend.o operand with the supplied objects/<same basename>. All XMP objects are already in that objects directory. Preserve the recorded interpreter and inherited /lib RPATH. The session-image command includes --strip-debug and is the shipped executable; session is its unstripped debugging twin.

The recipient may rebuild/replace LGPL libraries or startup objects and relink using these materials. Release tools intentionally pin the official runtime for baseline qualification: personal modified builds require updating the local source/runtime lock and receipts to describe the changed inputs, then rebuilding/relinking and testing the private image. These checks are editable source and are not a signature restriction on personal modification. Do not label such a modified image as the reviewed public release, redistribute owner-local vendor files, or copy it into internal storage. The bridge's normal hash checks can transport an owner-built image with a matching build manifest; there is no required publisher key blocking the owner's modifications.

For a byte comparison rehearsal, relink first against the unchanged pinned owner runtime and compare the new session-image/runtime-probe hashes with the original template manifest. Then run the ARM runtime test. Changed-library builds need their own execution tests; an unchanged-library relink does not establish that every ABI change works. The engineering assessment and remaining final clearance conditions are in owner-local-review.md.

The used compiler-header archive preserves directories below Zig lib/ under its include/ prefix: for example include/include/stdint.h and include/libc/include/generic-glibc/. Per-file LLVM/glibc notices remain intact; the full glibc source and licence texts accompany the outer kit. FACTORY-CONTENT.json separately records the optional CC0 sample selections and their source-side licence/provenance files.
