# Owner-local dynamic candidate: component review

This engineering review applies to the **Mac host dynamic recipe**, its pinned inputs and the three executables actually placed in the public template. It does not clear legacy static images, Docker builds with other packages or owner-assembled runtime images. The generated candidate/source receipts must bind the exact source, binaries, notices and source kit before publication; installation/stock-recovery evidence is separate and still required.

## Shipped code and source evidence

| Input                                              | Origin and terms                                                                                             | Treatment                                                                                                 |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| XMP init, session, bridge and original sounds      | Committed XMP source; Apache-2.0                                                                             | Whole matching source snapshot, build commands and original unstripped objects supplied                   |
| `crt1.o`, `crti.o`, `crtn.o`                       | `libc6-dev-armhf-cross` 2.36-8cross1; glibc 2.36-8, cross-toolchain-base 66                                  | Full upstream source, Debian patches/build wrappers, notices and relink objects supplied                  |
| `crtbegin.o`, `crtend.o`, instantiated C++ headers | `libgcc-12-dev-armhf-cross` / `libstdc++-12-dev-armhf-cross` 12.2.0-14cross1; GCC 12.2.0-14, gcc-12-cross 15 | Full upstream source, Debian patches/build wrappers, GPLv3 and GCC Runtime Library Exception 3.1 supplied |
| Used glibc/GCC/Linux UAPI headers                  | Exact four packages in `host-toolchain.lock.json`                                                            | Actual used header source files accompany the kit; original per-file notices retained                     |
| Used Clang builtin headers                         | Clang 18.1.6 within hash-pinned Zig 0.13.0                                                                   | Actual used header files and Apache-2.0/LLVM-exception text supplied                                      |
| ALSA interfaces                                    | Pinned inMusic-patched ALSA 1.2.11                                                                           | Complete patched source and LGPL text supplied; no public libasound binary/configuration                  |
| Inter 4.1 and JetBrains Mono 2.304 glyph data      | Pinned release TTF ZIPs; OFL-1.1                                                                             | Fonts, original notices and OFL texts supplied; generated atlas treated as OFL-covered                    |
| stb_truetype                                       | Pinned header; MIT option                                                                                    | Host-only atlas generator; source and notice supplied                                                     |

The source lock records exact package versions, original source archives, patches and descriptor hashes. The development packages remain pinned independently by size and SHA-256. They are read as archives; no package scripts execute. The source kit includes the complete source versions and cross-build wrappers, plus the actual used generated/header forms and compiled startup objects needed for the recorded link.

## Startup and header terms

The reviewed glibc 2.36 `sysdeps/arm/start.S`, `crti.S` and `crtn.S` grant a compiled-linking exception in their headers. That exception is file-specific. Other libc startup/header fragments retain their own terms: provide the full glibc source, notices and rebuild/relink materials rather than assuming every glibc file has the exception. `csu/init.c`, for example, retains LGPL terms. This route supplies both application source and original objects/maps so the recipient can rebuild or relink. The deprecated static development image is not covered by this review.

GCC `libgcc/crtstuff.c` and the reviewed standard C++ headers carry GPLv3 with GCC Runtime Library Exception 3.1. The recorded recipe compiles original high-level C/C++ with the pinned free-software Clang/Zig compiler and links using LLD; it does not use a proprietary intermediate-representation optimizer. On those facts, the exception permits combining these covered fragments with XMP under XMP's licence. This is not a blanket claim that all GCC files or every compilation process qualify. Full GCC notices, exception text, source and Debian changes remain in the kit.

The Clang header licence/LLVM exception and Linux UAPI syscall note are preserved. Their interface/code-generation permissions are not a reason to drop notices. Compiler dependency files record which headers the actual candidate used; the kit extracts those exact files. Font and other third-party terms remain separate from Apache-2.0.

Primary references: the source files inside the pinned archives; [GCC exception](https://www.gnu.org/licenses/gcc-exception-3.1.html) and [FSF FAQ](https://www.gnu.org/licenses/gcc-exception-3.1-faq.html); [LGPL 2.1](https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html); [LLVM 18.1.6 licence](https://github.com/llvm/llvm-project/blob/llvmorg-18.1.6/clang/LICENSE.TXT); [Linux syscall note](https://github.com/torvalds/linux/blob/v6.1/LICENSES/exceptions/Linux-syscall-note). This is an engineering compliance assessment of identified inputs, not independent legal advice or approval of unreviewed additions.

## Explicitly excluded

The public image contains no Akai updater/kernel/DTB/loader/apps, owner runtime DSOs, ALSA configuration, device identity, bridge secret or private logs. All 87 owner-local files are extracted from the signed, pinned 3.10.1 updater on the owner's Mac and added only to a private USB image. The ELF/filesystem audit enforces the public-template boundary. Source and object/map archives are assembled from explicit lists and exclude those private inputs.

The signed-updater provenance belongs to the owner-local preparation receipt. Do not describe Debian glibc 2.36 source as the corresponding source of Akai's glibc 2.39 DSOs; those DSOs are not distributed by XMP. Likewise the included GCC 12 sources describe the shipped startup/header inputs, not the owner's independently supplied libstdc++/libgcc_s build.

## What a final clearance record still needs

Run the actual candidate audits and source-kit audit, check notices against that file inventory and retain current build/runtime tests. Record the reviewer, exact hashes and this review reference in the candidate clearance; do not set approval by copying the pending template. Complete the owner-operated install/no-stick-handover/full-stock-restoration observations. The eight-file public package gate stays closed until those records match. Publish the review reference with the source/release; a private draft URL is not public publication evidence.
