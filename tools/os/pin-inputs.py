"""Explicit maintainer input-freeze tool; never used to float versions in a build."""
import concurrent.futures, hashlib, json, pathlib, re, subprocess
root = pathlib.Path(__file__).resolve().parents[2]
cache = root / 'build/os-inputs'
cache.mkdir(parents=True, exist_ok=True)
index = (cache / 'APKINDEX.txt').read_text()
packages = {}
providers = {}
for block in index.split('\n\n'):
    d = dict((line.split(':', 1) for line in block.splitlines() if ':' in line))
    if 'P' not in d:
        continue
    packages[d['P']] = d
    for p in d.get('p', '').split():
        providers.setdefault(p.split('=')[0], []).append(d['P'])
selected = {}
supplied = {'/bin/sh': 'busybox', 'initramfs-generator': 'xmp deterministic initramfs recipe'}

def add(name):
    if name in selected:
        return
    d = packages[name]
    selected[name] = d
    for dep in d.get('D', '').split():
        if dep.startswith('!'):
            continue
        dep = re.split('[<>=~]', dep)[0]
        if dep in supplied:
            continue
        if dep in packages:
            add(dep)
        else:
            if dep == 'icu-data':
                add('icu-data-en')
                continue
            candidates = providers.get(dep, [])
            candidates = [c for c in candidates if not c.endswith(('-dev', '-static', '-doc'))]
            if len(candidates) != 1:
                raise ValueError((dep, candidates))
            add(candidates[0])
for name in ['busybox', 'nodejs', 'linux-virt', 'alsa-utils', 'e2fsprogs', 'kmod']:
    add(name)

def freeze(d):
    name = f"{d['P']}-{d['V']}.apk"
    url = 'https://dl-cdn.alpinelinux.org/alpine/v3.23/main/x86_64/' + name
    path = cache / name
    if not path.exists():
        subprocess.run(['curl', '-fsSL', '--retry', '2', url, '-o', str(path)], check=True)
    data = path.read_bytes()
    return {'id': d['P'], 'version': d['V'], 'url': url, 'file': name, 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data), 'license': d.get('L', 'UNKNOWN'), 'origin': d.get('o', d['P']), 'aportsCommit': d.get('c'), 'upstream': d.get('U'), 'dependencies': d.get('D', '').split(), 'redistribution': 'source-and-notice-bundle-review-pending'}
with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
    locked = list(pool.map(freeze, [selected[k] for k in sorted(selected)]))
mini = 'alpine-minirootfs-3.23.8-x86_64.tar.gz'
url = 'https://dl-cdn.alpinelinux.org/alpine/v3.23/releases/x86_64/' + mini
if not (cache / mini).exists():
    subprocess.run(['curl', '-fsSL', '--retry', '2', url, '-o', str(cache / mini)], check=True)
hash = hashlib.sha256((cache / mini).read_bytes()).hexdigest()
assert hash == '56e2810205c17a5dff78cdd7b2c2af4ccdef16f18d765d5bb0f527438b136676'
lock = {'version': 1, 'distribution': 'Alpine Linux 3.23.8', 'architecture': 'x86_64', 'sourceDateEpoch': 1704067200, 'base': {'id': 'alpine-minirootfs', 'version': '3.23.8', 'url': url, 'file': mini, 'sha256': hash, 'bytes': (cache / mini).stat().st_size, 'license': 'aggregate; APK package database and SBOM', 'redistribution': 'source-and-notice-bundle-review-pending'}, 'packages': locked, 'suppliedCapabilities': supplied, 'trust': 'SHA-256 pinned from upstream HTTPS; initial signatures not independently verified', 'publicRedistributionApproved': False}
(root / 'os/inputs.lock.json').write_text(json.dumps(lock, indent=2) + '\n')
print(json.dumps({'packages': len(locked), 'bytes': sum((x['bytes'] for x in locked)), 'kernel': next((x['version'] for x in locked if x['id'] == 'linux-virt'))}))
