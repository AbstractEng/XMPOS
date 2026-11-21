"""Assemble a deterministic initramfs in memory; never mount or extract to a host device."""
import argparse, gzip, hashlib, io, json, pathlib, stat, tarfile, os, sys, zlib
ROOT = pathlib.Path(__file__).resolve().parents[2]

def digest(data):
    return hashlib.sha256(data).hexdigest()

def owned(path, top=('build', 'artifacts')):
    resolved = pathlib.Path(path).resolve()
    if pathlib.Path(path).is_symlink() or ROOT not in resolved.parents or resolved.relative_to(ROOT).parts[0] not in top:
        raise ValueError('Owned workspace input required: ' + str(path))
    return resolved

def application_files(app_path):
    """Include Vite's runtime chunks, refusing unbounded or linked build output."""
    entry = owned(app_path, ('build',))
    assets = entry.parent / 'assets'
    if assets.is_symlink() or (assets.exists() and not assets.is_dir()):
        raise ValueError('Regular application assets directory required')
    files = {}
    total = 0
    for path in [entry, *sorted(assets.rglob('*'))]:
        if path.is_symlink():
            raise ValueError('Symlink application asset rejected')
        if path.is_dir():
            continue
        if not path.is_file() or path.stat().st_size > 32000000:
            raise ValueError('Bounded regular application asset required')
        data = path.read_bytes()
        total += len(data)
        if len(files) >= 256 or total > 64000000:
            raise ValueError('Bounded application bundle required')
        files[path.relative_to(entry.parent).as_posix()] = data
    return files

def assemble(lock_path, app_path, output, source_hash, variant, parity_binary=None, device_overlay=None, profile_path=None, kernel_path=None, init_path=None, g1_overlay=None):
    lock = json.loads(pathlib.Path(lock_path).read_text())
    profile = json.loads((ROOT / (profile_path or ('os/device-profile.json' if device_overlay else 'os/profile.json'))).read_text())
    architecture = profile.get('architecture', 'x86_64')
    out = pathlib.Path(output).resolve()
    if ROOT not in out.parents or out.relative_to(ROOT).parts[0] not in ('build', 'artifacts', 'reports'):
        raise ValueError('Owned workspace image output required')
    out.mkdir(parents=True, exist_ok=True)
    entries = {}
    hardlinks = {}
    sbom = []

    def put(name, mode, data=b'', major=0, minor=0):
        entries[name] = (mode, data, major, minor)
    for component in [lock['base']] + lock['packages']:
        cache = lock.get('cacheDirectory', 'build/os-inputs')
        if cache not in ('build/os-inputs', 'build/os-inputs-armv7'):
            raise ValueError('Unapproved input cache')
        path = ROOT / cache / component['file']
        data = path.read_bytes()
        if len(data) != component['bytes'] or digest(data) != component['sha256']:
            raise ValueError('Pinned input mismatch: ' + component['id'])
        sbom.append({k: component[k] for k in ['id', 'version', 'sha256', 'license', 'redistribution', 'url']})
        with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz', ignore_zeros=True) as archive:
            for entry in archive:
                name = entry.name.removeprefix('./').rstrip('/')
                if not name or name.startswith('.') or name.startswith('dev/') or (name == 'dev'):
                    continue
                if name.startswith('/') or '..' in pathlib.PurePosixPath(name).parts:
                    raise ValueError('Unsafe upstream archive path')
                if entry.isdir():
                    put(name, stat.S_IFDIR | entry.mode & 0o777)
                elif entry.issym():
                    put(name, stat.S_IFLNK | 0o777, entry.linkname.encode())
                elif entry.islnk():
                    hardlinks[name] = entry.linkname.removeprefix('./')
                elif entry.isfile():
                    put(name, stat.S_IFREG | entry.mode & 0o777, archive.extractfile(entry).read())
    for name, target in hardlinks.items():
        if target not in entries:
            raise ValueError('Unresolved archive hardlink ' + target)
        put(name, *entries[target][:2])
    replaced = {p['id'] for p in sbom}
    for block in entries['lib/apk/db/installed'][1].decode().split('\n\n'):
        package = dict((line.split(':', 1) for line in block.splitlines() if ':' in line))
        if package.get('P') and package['P'] not in replaced:
            sbom.append({'id': package['P'], 'version': package['V'], 'license': package.get('L', 'UNKNOWN'), 'containerSha256': lock['base']['sha256'], 'redistribution': 'source-and-notice-bundle-review-pending', 'source': 'base image APK database'})
    sbom.extend([{'id': 'xmp-os', 'version': '0.1.0-dev', 'license': 'Apache-2.0', 'sourceSha256': source_hash, 'redistribution': 'source-and-notice-bundle-review-pending'}, {'id': 'zod', 'version': '4.6.7', 'license': 'MIT', 'source': 'package-lock.json integrity + bundled application hash', 'redistribution': 'source-and-notice-bundle-review-pending'}])
    app_files = application_files(app_path)
    app_hashes = {name: digest(data) for name, data in app_files.items()}
    app = app_files[pathlib.Path(app_path).name]
    native = b''
    if parity_binary:
        native_path = pathlib.Path(parity_binary).resolve()
        if ROOT not in native_path.parents or native_path.relative_to(ROOT).parts[0] != 'build' or pathlib.Path(parity_binary).is_symlink():
            raise ValueError('Owned build parity binary required')
        native = native_path.read_bytes()
        if len(native) > 8000000 or native[:4] != b'\x7fELF' or native[4:6] != b'\x02\x01' or native[18:20] != b'\x3e\x00':
            raise ValueError('Generic x86_64 ELF parity binary required')
        put('opt/xmp/xmp_parity_render', stat.S_IFREG | 0o755, native)
    overlay_hashes = {}
    if device_overlay:
        overlay = pathlib.Path(device_overlay)
        if overlay.is_symlink() or not overlay.resolve().is_relative_to(ROOT / 'build'):
            raise ValueError('Owned Device overlay required')
        for path in sorted(overlay.rglob('*')):
            if path.is_symlink():
                raise ValueError('Symlink overlay rejected')
            if path.is_file():
                name = str(path.relative_to(overlay))
                data = path.read_bytes()
                if len(data) > 32000000:
                    raise ValueError('Oversized Device asset')
                overlay_hashes[name] = digest(data)
                put('opt/xmp/' + name, stat.S_IFREG | (0o755 if name.startswith('arm/bin/') else 0o644), data)
        if not overlay_hashes or len(overlay_hashes) > 256:
            raise ValueError('Bounded Device overlay required')
    g1_hashes = {}
    if g1_overlay:
        # Static ARMv7 tools built from the official G1 sources.
        overlay = owned(g1_overlay, ('artifacts',))
        for path in sorted(overlay.rglob('*')):
            if path.is_symlink():
                target = path.readlink()
                if target.is_absolute() or '..' in target.parts:
                    raise ValueError('Unsafe G1 overlay link')
                put('opt/g1/' + str(path.relative_to(overlay)), stat.S_IFLNK | 0o777, str(target).encode())
            elif path.is_file() and path.name != 'manifest.json' and not path.name.endswith('.log') and path.name != 'packages.txt':
                name = str(path.relative_to(overlay))
                data = path.read_bytes()
                g1_hashes[name] = digest(data)
                put('opt/g1/' + name, stat.S_IFREG | (0o755 if name.startswith('bin/') else 0o644), data)
        if not any(n.startswith('bin/') for n in g1_hashes):
            raise ValueError('G1 overlay has no tools')
    init = (ROOT / (init_path or 'os/guest/init')).read_bytes()
    if device_overlay and not init_path:
        init = init.replace(b'/usr/bin/node /opt/xmp/guest.mjs', b'ifconfig lo up\nmkdir -p /dev/shm\nmount -t tmpfs -o size=256m tmpfs /dev/shm\n/usr/bin/node /opt/xmp/guest.mjs')
    external_kernel = owned(kernel_path, ('artifacts',)).read_bytes() if kernel_path else None
    identity = {'lock': lock, 'profile': profile, 'app': digest(app), 'appFiles': app_hashes, 'init': digest(init), 'sourceHash': source_hash, 'variant': variant, 'nativeParitySha256': digest(native) if native else None, 'overlay': overlay_hashes}
    if external_kernel is not None:
        identity.update(kernel=digest(external_kernel), g1=g1_hashes)
    build_id = digest(json.dumps(identity, sort_keys=True, separators=(',', ':')).encode())
    meta = {'variant': variant, 'sourceHash': source_hash, 'buildId': build_id, 'profile': profile['id'], 'architecture': architecture, 'distribution': lock['distribution'], 'runtime': 'self-contained bundled core engine; no Vite or host service', 'physicalAudioQualified': False, 'mpcDriversQualified': False, 'nativeParitySha256': digest(native) if native else None}
    if device_overlay:
        meta.update(runtime='Offline guest Chromium Device view; serial-only viewer', overlay=overlay_hashes, armTarget='arm-linux-musleabihf', mpcBootable=False)
    if g1_hashes:
        meta.update(g1Overlay=g1_hashes, kernelSource='official inMusic az01 (G1 3.10)')
    put('init', stat.S_IFREG | 0o755, init)
    for name, data in app_files.items():
        put('opt/xmp/' + ('guest.mjs' if name == pathlib.Path(app_path).name else name), stat.S_IFREG | 0o644, data)
    put('etc/xmp-build.json', stat.S_IFREG | 0o644, json.dumps(meta, sort_keys=True).encode())
    put('etc/apk/repositories', stat.S_IFREG | 0o644, b'')
    put('etc/resolv.conf', stat.S_IFREG | 0o644, b'')
    notices = 'XMP OS generic VM development image\nNo Akai proprietary assets or firmware.\nPublic redistribution remains blocked pending corresponding-source/notices review.\n\n' + '\n'.join((f"{p['id']} {p['version']}: {p['license']}" for p in sbom)) + '\n'
    put('usr/share/xmp/THIRD-PARTY-NOTICES.txt', stat.S_IFREG | 0o644, notices.encode())
    put('usr/share/xmp/sbom.json', stat.S_IFREG | 0o644, json.dumps(sbom, sort_keys=True).encode())
    for name in list(entries):
        for parent in pathlib.PurePosixPath(name).parents:
            if str(parent) != '.':
                entries.setdefault(str(parent), (stat.S_IFDIR | 0o755, b'', 0, 0))
    put('dev', stat.S_IFDIR | 0o755)
    put('dev/console', stat.S_IFCHR | 0o600, b'', 5, 1)
    put('dev/null', stat.S_IFCHR | 0o666, b'', 1, 3)
    payload = io.BytesIO()

    def record(name, mode, data, index, major=0, minor=0):
        encoded = name.encode() + b'\x00'
        fields = [index, mode, 0, 0, 1, lock['sourceDateEpoch'], len(data), 0, 0, major, minor, len(encoded), 0]
        payload.write(b'070701' + b''.join((f'{value:08x}'.encode() for value in fields)))
        payload.write(encoded)
        payload.write(b'\x00' * (-payload.tell() % 4))
        payload.write(data)
        payload.write(b'\x00' * (-payload.tell() % 4))
    for index, name in enumerate(sorted(entries), 1):
        record(name, *entries[name][:2], index, *entries[name][2:])
    record('TRAILER!!!', 0, b'', len(entries) + 1)
    compressed = gzip.compress(payload.getvalue(), compresslevel=6, mtime=0)
    kernel = external_kernel if external_kernel is not None else entries['boot/vmlinuz-virt'][1]
    (out / 'kernel').write_bytes(kernel)
    (out / 'rootfs.cpio.gz').write_bytes(compressed)
    manifest = {'format': 'xmp-os-image', 'version': 1, **meta, 'recipeVersion': 1, 'builder': {'python': sys.version.split()[0], 'zlib': zlib.ZLIB_RUNTIME_VERSION, 'node': os.environ.get('XMP_BUILDER_NODE', 'not-recorded'), 'bundle': 'Vite 8.3.6, package-lock.json'}, 'sourceDateEpoch': lock['sourceDateEpoch'], 'inputsLockSha256': digest(pathlib.Path(lock_path).read_bytes()), 'kernelSha256': digest(kernel), 'initramfsSha256': digest(compressed), 'uncompressedInitramfsSha256': digest(payload.getvalue()), 'appSha256': digest(app), 'appFiles': app_hashes, 'sbom': sbom, 'scope': 'byte reproducible assembly of pinned upstream binaries and a fixed bundled application; not compiler/toolchain reproducibility', 'publicRedistributionApproved': False}
    for name, data in [('manifest.json', manifest), ('sbom.json', sbom), ('sources.json', lock)]:
        (out / name).write_text(json.dumps(data, indent=2, sort_keys=True) + '\n')
    (out / 'THIRD-PARTY-NOTICES.txt').write_text(notices)
    print(json.dumps({'buildId': build_id, 'initramfsSha256': digest(compressed), 'bytes': len(compressed), 'files': len(entries)}))
if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--lock', default=str(ROOT / 'os/inputs.lock.json'))
    p.add_argument('--app', default=str(ROOT / 'build/os-app/guest.mjs'))
    p.add_argument('--output', default=str(ROOT / 'artifacts/os/p10'))
    p.add_argument('--source-hash', required=True)
    p.add_argument('--variant', choices=['development', 'update-candidate'], default='development')
    p.add_argument('--parity-binary')
    p.add_argument('--device-overlay')
    p.add_argument('--profile', choices=['os/live-mk1/device-profile.json'])
    p.add_argument('--kernel')
    p.add_argument('--init', choices=['os/live-mk1/init'])
    p.add_argument('--g1-overlay')
    a = p.parse_args()
    if len(a.source_hash) != 64 or any((c not in '0123456789abcdef' for c in a.source_hash)):
        raise ValueError('Source hash required')
    assemble(a.lock, a.app, a.output, a.source_hash, a.variant, a.parity_binary, a.device_overlay, a.profile, a.kernel, a.init, a.g1_overlay)
