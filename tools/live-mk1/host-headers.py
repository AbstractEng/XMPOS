"""Extract pinned headers/startup objects only. No package scripts or code run."""
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import sys
import tarfile


def require(test, message):
    if not test:
        raise ValueError(message)


def payload(data):
    require(data[:8] == b'!<arch>\n', 'Expected deb/ar archive')
    offset = 8
    while offset + 60 <= len(data):
        header = data[offset:offset + 60]
        require(header[58:60] == b'`\n', 'Invalid ar member')
        size = int(header[48:58])
        name = header[:16].decode().strip().rstrip('/')
        offset += 60
        require(0 <= size <= len(data) - offset, 'Truncated ar member')
        if name in ('data.tar.xz', 'data.tar.gz'):
            return data[offset:offset + size]
        offset += size + size % 2
    raise ValueError('Missing package data')


def extract(cache, lock, alsa, output):
    root = Path(output)
    root.mkdir(mode=0o700)
    total = 0
    startup = {'crt1.o', 'crti.o', 'crtn.o', 'crtbegin.o', 'crtend.o'}
    for package in lock['packages']:
        data = Path(cache, package['package'] + '.deb').read_bytes()
        require(len(data) == package['bytes'] and hashlib.sha256(data).hexdigest() == package['sha256'],
                'Development package hash mismatch')
        with tarfile.open(fileobj=io.BytesIO(payload(data)), mode='r:*') as archive:
            for entry in archive:
                name = entry.name.removeprefix('./')
                path = PurePosixPath(name)
                require(not path.is_absolute() and '..' not in path.parts, 'Unsafe package path')
                # Netfilter's case-colliding header names cannot coexist on default macOS
                # filesystems and are unrelated to XMP's API surface. Keep them in the pinned deb only.
                header = name.startswith('usr/arm-linux-gnueabihf/include/') and '/include/linux/netfilter' not in name
                crt = path.name in startup and (name.startswith('usr/arm-linux-gnueabihf/lib/') or
                                               name.startswith('usr/lib/gcc-cross/arm-linux-gnueabihf/12/'))
                notice = name.startswith('usr/share/doc/') and path.name == 'copyright'
                if not (header or crt or notice) or not entry.isfile():
                    continue
                total += entry.size
                require(entry.size <= 8 * 1024**2 and total <= 96 * 1024**2, 'Development headers exceed bound')
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                if target.exists():
                    require(target.read_bytes() == archive.extractfile(entry).read(), 'Conflicting development file: ' + name)
                else:
                    with target.open('xb') as stream:
                        stream.write(archive.extractfile(entry).read())
    # ALSA headers are already present in the reviewed patched archive. No configure script runs on the Mac.
    with tarfile.open(alsa, 'r:xz') as archive:
        for entry in archive:
            prefix = 'alsa-lib-1.2.11/include/'
            if not entry.name.startswith(prefix) or not entry.isfile() or not entry.name.endswith('.h'):
                continue
            relative = PurePosixPath(entry.name[len(prefix):])
            require('..' not in relative.parts and not relative.is_absolute() and entry.size <= 2 * 1024**2,
                    'Invalid ALSA header')
            target = root / 'usr/arm-linux-gnueabihf/include/alsa' / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open('xb') as stream:
                stream.write(archive.extractfile(entry).read())
    require((root / 'usr/arm-linux-gnueabihf/include/alsa/version.h').is_file(), 'Missing ALSA version header')
    return {'packages': lock['packages'], 'headerBytes': total, 'packageScriptsExecuted': False}


if __name__ == '__main__':
    try:
        print(json.dumps(extract(sys.argv[1], json.loads(Path(sys.argv[2]).read_text()), sys.argv[3], sys.argv[4])))
    except Exception as error:
        raise SystemExit(str(error)) from error
