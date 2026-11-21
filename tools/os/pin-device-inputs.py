"""Explicit development-lock refresh; builds never resolve rolling package indexes."""
import concurrent.futures, hashlib, io, json, pathlib, re, subprocess, tarfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
CACHE = ROOT / 'build/os-inputs'
packages, providers = {}, {}
for repo in ('main', 'community'):
    with tarfile.open(CACHE / f'{repo}-index.tar.gz') as archive:
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
for name in ('busybox', 'nodejs', 'linux-virt', 'alsa-utils', 'e2fsprogs', 'kmod', 'chromium', 'font-dejavu', 'qemu-arm'):
    add(name)
def freeze(name):
    d = selected[name]
    file = f"{name}-{d['V']}.apk"
    url = f"https://dl-cdn.alpinelinux.org/alpine/v3.23/{d['repo']}/x86_64/{file}"
    path = CACHE / file
    if not path.exists():
        subprocess.run(['curl', '-fsSL', '--retry', '2', url, '-o', str(path)], check=True)
    data = path.read_bytes()
    return {'id': name, 'version': d['V'], 'url': url, 'file': file, 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data), 'license': d.get('L', 'UNKNOWN'), 'origin': d.get('o', name), 'aportsCommit': d.get('c'), 'upstream': d.get('U'), 'dependencies': d.get('D', '').split(), 'redistribution': 'source-and-notice-bundle-review-pending'}
with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
    locked = list(pool.map(freeze, sorted(selected)))
lock = json.loads((ROOT / 'os/inputs.lock.json').read_text())
lock['packages'] = locked
lock['purpose'] = 'Offline guest Device renderer and ARM Linux user-mode execution; development only'
(ROOT / 'os/device-inputs.lock.json').write_text(json.dumps(lock, indent=2) + '\n')
print(json.dumps({'packages': len(locked), 'archiveBytes': sum(p['bytes'] for p in locked)}))
