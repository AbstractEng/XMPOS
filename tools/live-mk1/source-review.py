"""Assemble a REVIEW-ONLY source kit from a clean committed checkout and pinned inputs."""
import hashlib
import json
import io
import shlex
from pathlib import Path
import subprocess
import sys
import tarfile
import importlib.util

ROOT = Path(__file__).resolve().parents[2]
ORIGINS = {
    'alsa-lib': 'https://github.com/inmusic-software/az0x-open-source/blob/ea21ffce863f48cfa138f053bfd5788daa752a6b/arm-poky-linux-gnueabi/alsa-lib-1.2.11-r0/alsa-lib-1.2.11-r0-patched.tar.xz',
    'inter': 'https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip',
    'jetbrains-mono': 'https://github.com/JetBrains/JetBrainsMono/releases/download/v2.304/JetBrainsMono-2.304.zip',
    'stb-truetype': 'https://raw.githubusercontent.com/nothings/stb/f58f558c120e9b32c217290b80bad1a0729fbb2c/stb_truetype.h',
}
INPUTS = [
    ('alsa-lib', '1.2.11-inmusic-patched', 'LGPL-2.1-or-later (library; see per-file notices)',
     'akai-mpc-g1-3.10/alsa-lib-1.2.11-r0-patched.tar.xz',
     '549e4467f8ac6ec800285be9bd43f5033726019a7276e338be968b73898b73da'),
    ('inter', '4.1', 'OFL-1.1', 'fonts/Inter-4.1.zip',
     '9883fdd4a49d4fb66bd8177ba6625ef9a64aa45899767dde3d36aa425756b11e'),
    ('jetbrains-mono', '2.304', 'OFL-1.1', 'fonts/JetBrainsMono-2.304.zip',
     '6f6376c6ed2960ea8a963cd7387ec9d76e3f629125bc33d1fdcd7eb7012f7bbf'),
    ('stb-truetype', 'f58f558c120e9b32c217290b80bad1a0729fbb2c', 'MIT', 'fonts/stb_truetype.h',
     'ecd30b05e0dd4fea3a13c26810dd9e1992dc379049482c393d5a19e6b5090aab'),
]


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()



def public_source_metadata(entry):
    """Keep public source payloads/modes without local host account metadata."""
    entry.uid = entry.gid = 0
    entry.uname = entry.gname = ""
    entry.mtime = 0
    entry.pax_headers = {}
    return entry


def normalize_build_text(data, replacements):
    text = data.decode()
    for before, after in sorted(replacements, key=lambda item: len(item[0]), reverse=True):
        text = text.replace(before.replace(" ", "\\ "), after).replace(before, after)
    return text.encode()


def factory_content_review():
    public = ROOT / "apps/studio/public"
    catalog = public / "kits/catalog.json"
    value = json.loads(catalog.read_text())
    files, licences = {}, {}
    for kit in value["kits"]:
        if kit["license"] != "CC0-1.0":
            raise ValueError("Unreviewed factory content licence")
        for name in kit["licensePaths"]:
            path = public / name
            if not name.startswith("kits/licenses/") or ".." in Path(name).parts or path.is_symlink():
                raise ValueError("Invalid factory licence path")
            licences[name] = {"sha256": digest(path)}
        for sample in kit["files"]:
            name = sample["path"]
            path = public / name
            if (not name.startswith("kits/cc0/") or ".." in Path(name).parts or path.is_symlink()
                    or not 0 < sample["bytes"] <= 8 * 1024**2 or path.stat().st_size != sample["bytes"]
                    or digest(path) != sample["sha256"]):
                raise ValueError("Changed or unreviewed factory sample")
            files[name] = {key: sample[key] for key in ("sha256", "sourceUrl", "processing")}
    return {"format": "xmp-factory-content-review", "catalogSha256": digest(catalog),
            "cc0Selections": len(value["kits"]), "selectedFiles": len(files),
            "files": files, "licences": licences,
            "originalGeneratedKit": "XMP Velvet: native/include/xmp/velvet_kit.hpp and tools/kits/velvet.mjs",
            "noAkaiSamples": True,
            "sourceLocation": "sources/xmp.tar.gz / apps/studio/public/kits"}

def pack(destination, template=None):
    if git('status', '--porcelain', '--untracked-files=normal').strip():
        raise ValueError('Source review requires a clean committed checkout; never archive a private working tree')
    output = Path(destination).absolute()
    base = ROOT / 'artifacts'
    if not output.is_relative_to(base) or output == base:
        raise ValueError('New output directory under artifacts/ required')
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.parent.resolve() != output.parent:
        raise ValueError('Symlink output parent refused')
    inputs = []
    for component, version, license, name, expected in INPUTS:
        path = ROOT / 'references/archives' / name
        if not path.is_file() or path.is_symlink() or digest(path) != expected:
            raise ValueError('Missing or changed pinned input: ' + name)
        inputs.append((component, version, license, path, expected))
    output.mkdir(mode=0o700)
    source = output / 'xmp.tar.gz'
    with source.open('xb') as stream:
        subprocess.run(['git', 'archive', '--format=tar.gz', 'HEAD'], cwd=ROOT, stdout=stream, check=True)
    identity = hashlib.sha256()
    for name in sorted(git('ls-files', '-z').decode().split('\0')):
        if name:
            identity.update((name + '\0').encode())
            identity.update((ROOT / name).read_bytes())
    components = [{'id': 'xmp', 'version': git('rev-parse', 'HEAD').decode().strip(),
                   'license': 'Apache-2.0 (XMP code); CC0-1.0 (identified optional factory samples)', 'sourcePath': 'sources/xmp.tar.gz',
                   'sourceSha256': digest(source)}]
    for component, version, license, path, expected in inputs:
        components.append({'id': component, 'version': version, 'license': license,
                           'source': ORIGINS[component], 'sourcePath': 'sources/' + path.name, 'sourceSha256': expected})
    extra, material = [], []
    candidate = None
    if template is not None:
        template = Path(template).resolve()
        candidate = json.loads((template / 'manifest.json').read_text())
        if candidate.get('sourceHash') != identity.hexdigest() or candidate.get('runtimeMode') != 'owner-local-3.10.1' or candidate.get('builder', {}).get('compiler') != 'zig-cc':
            raise ValueError('Matching current-source host dynamic candidate required')
        subprocess.run([sys.executable, '-I', str(ROOT / 'tools/live-mk1/owner-runtime.py'), 'audit-public', str(template / 'system.img'), str(ROOT / 'os/live-mk1/mpc-runtime.lock.json')], check=True, stdout=subprocess.DEVNULL)
        for name, entry in candidate['files'].items():
            if name.startswith(('objects/', 'link-maps/', 'toolchain/')) or name == 'system.img':
                path = template / name
                if '..' in Path(name).parts or Path(name).is_absolute() or path.is_symlink() or not path.is_file() or path.stat().st_size != entry['bytes'] or digest(path) != entry['sha256']:
                    raise ValueError('Changed candidate build material: ' + name)
        extra = json.loads(subprocess.check_output([sys.executable, '-I', str(ROOT / 'tools/live-mk1/licensing-inputs.py')]))
        for component, package, version, license, filename in [
            ('libc-startup', 'glibc', '2.36-8 / cross 2.36-8cross1', 'LGPL-2.1-or-later; ARM assembly linking exception', 'glibc_2.36.orig.tar.xz'),
            ('gcc-runtime', 'gcc-12', '12.2.0-14 / cross 12.2.0-14cross1', 'GPL-3.0-or-later WITH GCC-exception-3.1 (covered CRT/C++ headers)', 'gcc-12_12.2.0.orig.tar.gz')]:
            row = next(row for row in extra if row['name'] == filename)
            components.append({'id': component, 'version': version, 'license': license, 'source': 'https://snapshot.debian.org/package/' + package + '/', 'sourcePath': 'sources/' + filename, 'sourceSha256': row['sha256']})
        # Retain relink objects and normalized command/dependency/map evidence,
        # never the owner's DSOs, runtime tree, token or image.
        relink = output / 'relink-materials.tar.gz'
        commands = json.loads((template / 'toolchain/commands.json').read_text())
        owners = set(str(Path(arg).parent.parent) for command in commands for arg in command if '/lib/libc.so.6' in arg)
        compiler = Path(commands[0][0]).parent
        replacements = [(owner, '$XMP_RUNTIME') for owner in owners] + [
            (str(template), '$XMP_BUILD'), (str(ROOT), '$XMP_SOURCE'),
            (str(compiler), '$XMP_COMPILER'), (str(compiler.resolve()), '$XMP_COMPILER')]
        def normalized(data):
            return normalize_build_text(data, replacements)
        clang, development = set(), set()
        for path in (template / 'objects').glob('*.d'):
            deps = shlex.split(path.read_text().replace('\\\n', '').split(':', 1)[1])
            clang.update(Path(name) for name in deps if ('/lib/include/' in name or '/lib/libc/include/' in name) and name.endswith('.h'))
            development.update(name.split('/.headers/', 1)[1] for name in deps if '/.headers/usr/' in name and '/include/alsa/' not in name)
        if not clang: raise ValueError('Candidate lacks compiler-header dependency records; rebuild with current host recipe')
        with tarfile.open(relink, 'w:gz') as archive:
            for prefix in ['objects', 'link-maps', 'toolchain']:
                for path in sorted((template / prefix).iterdir()):
                    if not path.is_file() or path.is_symlink(): raise ValueError('Regular relink material required')
                    data = path.read_bytes()
                    if path.suffix in ('.d', '.map', '.json', '.txt'): data = normalized(data)
                    info = tarfile.TarInfo(prefix + '/' + path.name); info.size = len(data); info.mode = 0o644
                    archive.addfile(info, io.BytesIO(data))
        material.append(relink)
        clang_archive = output / 'clang-used-headers.tar.gz'
        with tarfile.open(clang_archive, 'w:gz') as archive:
            for path in sorted(clang):
                if not path.is_file() or path.is_symlink() or path.stat().st_size > 8 * 1024**2: raise ValueError('Invalid compiler header')
                archive.add(path, arcname='include/' + str(path).split('/lib/', 1)[1], recursive=False, filter=public_source_metadata)
            archive.add(ROOT / 'docs/licensing/licenses/LLVM-Apache-2.0-exception.txt', arcname='LICENSE.txt', recursive=False, filter=public_source_metadata)
        material.append(clang_archive)
        components.append({'id': 'clang-headers', 'version': 'LLVM 18.1.6 in pinned Zig 0.13.0', 'license': 'LLVM Apache-2.0 WITH LLVM-exception and glibc LGPL; per-file terms retained', 'source': 'https://github.com/llvm/llvm-project/tree/llvmorg-18.1.6/clang/lib/Headers', 'sourcePath': 'sources/clang-used-headers.tar.gz', 'sourceSha256': digest(clang_archive)})
        spec = importlib.util.spec_from_file_location('host_headers', ROOT / 'tools/live-mk1/host-headers.py')
        host_headers = importlib.util.module_from_spec(spec); spec.loader.exec_module(host_headers)
        headers_archive = output / 'development-used-headers.tar.gz'
        with tarfile.open(headers_archive, 'w:gz') as archive:
            for package in json.loads((ROOT / 'os/live-mk1/host-toolchain.lock.json').read_text())['packages']:
                package_path = ROOT / 'references/archives/armhf-development' / (package['package'] + '.deb')
                if digest(package_path) != package['sha256']: raise ValueError('Changed development package')
                with tarfile.open(fileobj=io.BytesIO(host_headers.payload(package_path.read_bytes())), mode='r:*') as contents:
                    for member in contents:
                        name = member.name.removeprefix('./')
                        if name in development and member.isfile():
                            data = contents.extractfile(member).read()
                            member = tarfile.TarInfo(name); member.size = len(data); member.mode = 0o644
                            archive.addfile(member, io.BytesIO(data)); development.remove(name)
        if development: raise ValueError('Missing used development header sources: ' + repr(sorted(development)))
        material.append(headers_archive)
        components.append({'id': 'development-headers', 'version': 'Pinned glibc 2.36 / GCC 12 / Linux UAPI 6.1.4', 'license': 'Per-file LGPL/GCC exception/Linux syscall note; full source inputs included', 'source': 'https://www.debian.org/legal/licenses/', 'sourcePath': 'sources/development-used-headers.tar.gz', 'sourceSha256': digest(headers_archive)})
    review = {'format': 'xmp-component-source-review', 'version': 1, 'status': 'blocked',
              'publicRedistributionApproved': False, 'sourceCommit': components[0]['version'],
              'sourceHash': identity.hexdigest(), 'mpcOsVersion': '3.10.1',
              'selectedRuntimeMode': 'owner-local-3.10.1', 'components': components,
              'missingForExistingStaticImage': ['proven matching XMP source tree',
                  'exact libc/compiler runtime package sources and notices',
                  'original unstripped objects/link maps or verified complete rebuild/relink route'],
              'remainingForSelectedRoute': ['dynamic XMP build and actual ABI execution tests',
                  'compiler startup/header code provenance and exception applicability',
                  'owner-local USB image assembler and template-to-private-image evidence binding',
                  'ARM regression and owner installation/stock recovery rehearsal'],
              'sourceSnapshotNoticePaths': ['brand/abstract-engineering/assets/fonts/OFL.txt',
                  'brand/abstract-engineering/NOTICE.md', 'apps/studio/public/THIRD-PARTY-NOTICES.txt',
                  'apps/studio/public/kits/licenses/'],
              'containsOwnerRuntimeFiles': False, 'hardwareAccess': False}
    if candidate:
        review.update({'status': 'candidate-source-materials-complete-review-required', 'candidateManifestSha256': digest(template / 'manifest.json'), 'publicTemplateSha256': digest(template / 'system.img'), 'remainingForSelectedRoute': ['maintainer component review/clearance bound to these exact materials', 'owner candidate installation/no-stick handover/full-stock-restoration evidence'], 'relinkMaterialsIncluded': True, 'compilerHeaderDependencyCount': len(clang), 'startupPackages': json.loads((ROOT / 'os/live-mk1/host-toolchain.lock.json').read_text()), 'sourceInputs': [{k:v for k,v in row.items() if k != 'path'} for row in extra]})
    (output / 'review.json').write_text(json.dumps(review, indent=2) + '\n')
    texts = ['THIRD-PARTY-NOTICES.txt', 'BUILDING.md', 'STATIC-LINKING.md']
    content = factory_content_review()
    content_path = output / 'FACTORY-CONTENT.json'
    content_path.write_text(json.dumps(content, indent=2) + '\n')
    notices = (ROOT / 'docs/licensing/THIRD-PARTY-NOTICES.txt').read_bytes()
    licenses = sorted((ROOT / 'docs/licensing/licenses').glob('*.txt'))
    for path in licenses:
        notices += b'\n\n===== ' + path.name.encode() + b' =====\n' + path.read_bytes()
    for name in content['licences']:
        notices += b'\n\n===== ' + name.encode() + b' =====\n' + (ROOT / 'apps/studio/public' / name).read_bytes()
    (output / 'THIRD-PARTY-NOTICES.txt').write_bytes(notices)
    bundle = output / 'corresponding-source.tar.gz'
    with tarfile.open(bundle, 'w:gz') as archive:
        archive.add(source, arcname='sources/xmp.tar.gz', recursive=False, filter=public_source_metadata)
        for _, _, _, path, _ in inputs:
            archive.add(path, arcname='sources/' + path.name, recursive=False, filter=public_source_metadata)
        for row in extra:
            archive.add(row['path'], arcname='sources/' + row['name'], recursive=False, filter=public_source_metadata)
        for path in material:
            archive.add(path, arcname='sources/' + path.name, recursive=False, filter=public_source_metadata)
        for name in texts[1:]:
            archive.add(ROOT / 'docs/licensing' / name, arcname=name, recursive=False, filter=public_source_metadata)
        for path in licenses:
            archive.add(path, arcname='licenses/' + path.name, recursive=False, filter=public_source_metadata)
        archive.add(ROOT / 'LICENSE', arcname='LICENSE', recursive=False, filter=public_source_metadata)
        archive.add(output / 'review.json', arcname='review.json', recursive=False, filter=public_source_metadata)
        archive.add(output / texts[0], arcname=texts[0], recursive=False, filter=public_source_metadata)
        archive.add(content_path, arcname='FACTORY-CONTENT.json', recursive=False, filter=public_source_metadata)
    source.unlink()  # nested once; do not retain a duplicate intermediate
    for path in material: path.unlink()
    source_audit = json.loads(subprocess.check_output([sys.executable, '-I',
                    str(ROOT / 'tools/live-mk1/audit-source-bundle.py'), str(bundle), json.dumps(components)]))
    ledger = {p.name: {'sha256': digest(p), 'bytes': p.stat().st_size}
              for p in (bundle, output / texts[0], output / 'review.json')}
    (output / 'SHA256SUMS').write_text(''.join(v['sha256'] + '  ' + k + '\n' for k, v in ledger.items()))
    print(json.dumps({'directory': str(output), 'files': ledger, 'status': review['status'],
                      'publicRedistributionApproved': False, 'sourceAudit': source_audit}, indent=2))


if __name__ == '__main__':
    if len(sys.argv) == 4 and sys.argv[2] == '--template':
        pack(sys.argv[1], sys.argv[3])
    elif len(sys.argv) == 2:
        pack(sys.argv[1])
    else:
        raise SystemExit('Usage: python3 tools/live-mk1/source-review.py artifacts/<new-review-directory> [--template artifacts/<dynamic-candidate>]')
