# Installer source, rebuild and relink

The installer contains original XMP code, the reviewed host tools/runtime and
an XMP-only template. An owner supplies the official 3.10.1 updater locally.
Never distribute an extracted updater, loader/rootfs or runtime-bearing USB
image. The installer source identity is separate from the frozen session's
source identity; both are recorded in manifests.

The installer also carries the original Acid Circuit demo and its source
provenance under demo/. USB preparation creates xmp/project.xmpsong only if no
startup project, legacy pattern, edit journal or recovery file exists. The demo
is size/hash verified before any USB writes and read back after exclusive
creation. Packaged tests check first-start seeding; USB tests check preservation.

## Native macOS: Intel and Apple Silicon

Build with native Node **24.14.0**, Xcode command-line tools and a POSIX shell on
macOS **13.4.1 or later for Intel**, **13.5 or later for Apple Silicon**. Use an Intel host for x64 and an Apple Silicon host for
arm64. The Intel 13.4.1 route uses the exact Node binary exercised by the
owner-host packaged tests; its higher declared build minimum is recorded in
the architecture audit rather than hidden. The builder audits every bundled host executable/Python extension for the
selected architecture and minimum OS; Apple Silicon needs no Rosetta:

```sh
npm ci
npm ci --prefix tools/live-mk1/installer
node tools/live-mk1/installer/build.mjs
```

The default build creates a minimal CPython from the exact source in
inputs.lock.json using build-macos-python.sh, builds the ARM loader with
pinned Zig 0.13.0, and builds pinned e2fsprogs. It needs no Docker or hardware.
The Python build uses macOS system zlib/liblzma and disables OpenSSL/hashlib,
SQLite, readline, curses, ctypes and other unused optional native modules.
CPython's own hash implementations remain available. The runtime's complete
source archive, configuration, disabled-module list and build receipt are
provided; it is an installer runtime, not a general-purpose Python SDK.

Verified existing inputs can avoid a large rebuild:

```sh
node tools/live-mk1/installer/build.mjs \
  --python-from <reviewed-mac-python-runtime-directory> \
  --compiler-rt-from <Zig-0.13.0-compiler-runtime.tar.gz> \
  --payload-from <retained-XMP-loader-payload-directory> \
  --tools-from <verified-host-loader-directory> \
  --release-from <frozen-release-input-directory>
```

The builder verifies all supplied runtime/source files, source/compiler pins,
loader hash, and the complete 272-file compiler-runtime source inventory.
The release template and session source archive must match release.lock.json.
Retained inputs are caches, not permission to substitute unreviewed binaries.
The output is artifacts/installer/XMP OS Installer.app; --output selects a
different host-only output directory. End users double-click it and need
no terminal, Python, Node or Docker installation.

## Windows x64

Build on Windows x64 with Node 24.14.0 and the .NET Framework C# compiler:

```powershell
npm ci --prefix tools/live-mk1/installer
node tools/live-mk1/installer/build-windows.mjs build/windows-inputs artifacts/windows-installer
node --test tools/live-mk1/installer/flow.test.mjs tools/live-mk1/installer/usb.test.mjs tools/live-mk1/installer/stock-install.test.mjs
```

The input directory contains host-tools/, the exact 7zr.exe and 7zip source
pinned in windows.lock.json, the retained loader-payload/, the verified
zig-runtime-source.tar.gz, and release/ with the pinned template and session
source archive. The builder refuses missing source attribution, changed
runtime files, changed source packages and changed licence notices. It copies
only the reviewed bin/lib closure; build-only DLLs and site packages are absent.

Host-tool preparation is documented by build-windows-host-tools.sh,
trim-windows-runtime.py, pe-imports.py and collect-windows-sources.py. Source
collection uses build-host Python 3.14 for upstream zstd package archives;
this build prerequisite is not the Python runtime bundled for owners. Source
packages are SHA-512 checked against upstream metadata and matched to actual
native filenames and the recorded installed package versions. The source
lock is the authoritative component inventory. Windows source notices are
written in UTF-8 without automatic newline conversion.

Owners extract the ZIP and double-click XMP OS Installer.exe, keeping its
resources folder beside it. The fresh-stock check uses the Windows system
OpenSSH Client (Optional Features). Device USB driver/flash qualification on
Windows remains unverified; that limitation is independent of source clearance.

## Rebuilding and replacing components

**e2fsprogs:** unpack the complete e2fsprogs-1.47.2.tar.xz. On macOS configure
with --disable-nls --disable-uuidd --disable-fsck --disable-e2initrd-helper
--disable-fuse2fs, then make -j2. On Cygwin x64 additionally use
--disable-elf-shlibs and apply the supplied cygwin-io.patch with patch -p1.
The XMP portability change, dated 18 November 2026, adds <io.h> to declare
_get_osfhandle; it changes no filesystem algorithm. Original configuration,
source archive and patch accompany the four tools. Replace debugfs/debugfs,
e2fsck/e2fsck, misc/dumpe2fs and misc/mke2fs (with .exe on Windows).

**Cygwin/Python/runtime DLLs:** the complete source packages include original
archives, distribution patches and .cygport recipes. Build the recorded
versions with Cygwin's cygport build tools and each recipe's declared build
dependencies; install the needed gcc/make/autoconf/automake/libtool and source
compression tools, including lzip/zstd. Build the exact w32api headers and
Cygwin source versions recorded alongside them when reproducing the original
configuration. Replace the resulting matching-ABI DLLs or Python files in the
host-tool input tree. Regenerate runtime-closure.json from the new files and
update the source inventory for the modified version before rebuilding the
installer. Cygwin rebasing may be needed for a modified DLL set. No proprietary
object is linked into these host tools; application source and library source
are supplied, so recipients can rebuild and relink with modified libraries.

**ARM loader:** loader-payload.mjs and the toolchain lock describe the static
ARM/musl build. compiler-rt-source.py verifies/creates the exact Zig runtime
source archive. The original C source, musl notice, Zig MIT notice and compiler
runtime sources accompany it. Changing the loader requires rebuilding its
payload/hash and preparing a fresh owner-local loader from the signed updater.

**CPython on macOS:** unpack the complete included source and apply the supplied
Modules/Setup.local; the included build-macos-python.sh records all configure
and copy steps. Build with the normal macOS SDK; no third-party dylib is allowed.
A modified compatible runtime can be substituted by rebuilding the source and
updating its binary/source receipt.

**7zr.exe:** unpack 7zip-src.tar.xz, follow DOC/'s Windows build instructions
using CPP/7zip/Bundles/Alone7z, update its local reviewed input hash and rebuild.
Upstream licence texts remain in the complete supplied archive. Node source
is available at https://nodejs.org/dist/v24.14.0/node-v24.14.0.tar.xz; follow
BUILDING.md. Full Node component notices accompany the binary. Zod and esbuild
versions/licences and the complete installer closure are included in source.

Modified builds must regenerate image-tool receipt hashes and
bundle-manifest.json. Rebuilding the whole installer does that. Re-sign a
modified macOS app with your own ad-hoc identity:

```sh
codesign --force --deep --sign - 'XMP OS Installer.app'
```

No XMP publisher key or approval is required to modify/relink these components.
Integrity checks detect local changes; they do not remove recipients' licence
rights, including debugging modifications to the libraries. All real MPC writes
still require the owner's typed XMPOS confirmation and the verified rootfs-only
flash path.

## First installation and verification

For a fresh unit, use Verify stock Live before USB preparation: stock 3.10.1,
owner-enabled Developer Mode, owner-selected local IPv4 address, and the native
secure SSH password prompt or an existing owner-installed key. Only the fixed
read-only script in mpc-remote.mjs runs. Each unit's rootfs sector count and root
mount are measured; no common partition size or another owner's report is used.
The later fastboot serial and bootloader 0.4 must match that unit/profile.
Unknown/mismatched boards, revisions, roots, versions and sizes stop the process.
Agents need the repository owner's explicit hardware authorization before a
real check; simulations never contact a device or physical USB key.

Run live:installer:test and the packaged host tests after rebuilding. The native
source capture and fastboot dry-run evidence are distinct from fake-transport
or emulated tests. A successful test does not publish files or clear a different
candidate. Force remains excluded from every route.
