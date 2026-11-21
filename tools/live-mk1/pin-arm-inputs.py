"""Explicit refresh of the ARMv7 Device image lock; builds never resolve rolling indexes."""
import concurrent.futures, hashlib, io, json, pathlib, re, subprocess, tarfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
CACHE = ROOT / 'build/os-inputs-armv7'
CACHE.mkdir(parents=True, exist_ok=True)
MIRROR = 'https://dl-cdn.alpinelinux.org/alpine/v3.23'
def fetch(url, path):
    if not path.exists():
        subprocess.run(['curl', '-fsSL', '--retry', '2', url, '-o', str(path)], check=True)
    return path.read_bytes()
packages, providers = {}, {}
for repo in ('main', 'community'):
    data = fetch(f'{MIRROR}/{repo}/armv7/APKINDEX.tar.gz', CACHE / f'{repo}-index.tar.gz')
    with tarfile.open(fileobj=io.BytesIO(data)) as archive:
        index = archive.extractfile('APKINDEX').read().decode()
    for block in index.split('\n\n'):
        d = dict(line.split(':', 1) for line in block.splitlines() if ':' in line)
        if 'P' not in d:
            continue
        d['repo'] = repo
        packages[d['P']] = d
        for capability in d.get('p', '').split():
            providers.setdefault(capability.split('=')[0], []).append(d['P'])
selected = {}
def add(name):
    if name in selected:
        return
    d = packages[name]
    selected[name] = d
    for dep in d.get('D', '').split():
        if dep.startswith('!'):
            continue
        dep = re.split('[<>=~]', dep)[0]
        if dep in ('/bin/sh', 'initramfs-generator'):
            continue
        if dep in packages:
            add(dep)
        elif dep == 'so:libudev.so.1':
            add('eudev-libs')
        elif dep == 'icu-data':
            add('icu-data-en')
        else:
            candidates = [p for p in providers.get(dep, []) if not p.endswith(('-dev', '-doc', '-static'))]
            if len(candidates) != 1:
                raise ValueError((dep, candidates))
            add(candidates[0])
# No Alpine kernel: the official inMusic az01 kernel is used instead. No
# qemu-arm: ARM binaries run natively. G1 tools are layered under /opt/g1.
# Phase 3 adds the kiosk display stack for the Live's own panel: cage (a
# wlroots kiosk compositor), seatd and wlr-randr (screen rotation).
for name in ('busybox', 'nodejs', 'alsa-utils', 'e2fsprogs', 'chromium', 'font-dejavu', 'cage', 'seatd', 'wlr-randr'):
    add(name)
def freeze(name):
    d = selected[name]
    file = f"{name}-{d['V']}.apk"
    url = f"{MIRROR}/{d['repo']}/armv7/{file}"
    data = fetch(url, CACHE / file)
    return {'id': name, 'version': d['V'], 'url': url, 'file': file, 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data), 'license': d.get('L', 'UNKNOWN'), 'origin': d.get('o', name), 'aportsCommit': d.get('c'), 'upstream': d.get('U'), 'dependencies': d.get('D', '').split(), 'redistribution': 'source-and-notice-bundle-review-pending'}
with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
    locked = list(pool.map(freeze, sorted(selected)))
base_file = 'alpine-minirootfs-3.23.8-armv7.tar.gz'
base = fetch(f'{MIRROR}/releases/armv7/{base_file}', CACHE / base_file)
lock = json.loads((ROOT / 'os/inputs.lock.json').read_text())
lock.update(
    architecture='armv7',
    cacheDirectory='build/os-inputs-armv7',
    base={'id': 'alpine-minirootfs', 'version': '3.23.8', 'url': f'{MIRROR}/releases/armv7/{base_file}', 'file': base_file, 'sha256': hashlib.sha256(base).hexdigest(), 'bytes': len(base), 'license': 'aggregate; APK package database and SBOM', 'redistribution': 'source-and-notice-bundle-review-pending'},
    packages=locked,
    purpose='ARMv7 Device renderer on the official az01 kernel with G1-built hardware tools; development only',
)
(ROOT / 'os/live-mk1/arm-device-inputs.lock.json').write_text(json.dumps(lock, indent=2) + '\n')
# Match the repository formatter so npm run check stays clean after a refresh.
subprocess.run(['npx', 'biome', 'format', '--write', 'os/live-mk1/arm-device-inputs.lock.json'], cwd=ROOT, check=True, capture_output=True)
print(json.dumps({'packages': len(locked), 'archiveBytes': sum(p['bytes'] for p in locked)}))
