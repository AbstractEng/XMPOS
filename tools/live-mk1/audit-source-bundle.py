"""Bounded structural/source-hash audit only; this does not approve licences."""
import hashlib
import json
from pathlib import PurePosixPath
import sys
import tarfile

components = json.loads(sys.argv[2])
wanted = {c['sourcePath']: c['sourceSha256'] for c in components}
seen = set()
count = 0
total = 0
instructions = set()
with tarfile.open(sys.argv[1], 'r|gz') as archive:
    for entry in archive:
        count += 1
        total += entry.size
        name = entry.name.removeprefix('./').rstrip('/')
        path = PurePosixPath(name)
        if (count > 100000 or total > 4 * 1024**3 or len(name) > 512 or
                not name or any(ord(c) < 32 or c in '\\:' for c in name) or path.is_absolute() or '..' in path.parts or
                not (entry.isfile() or entry.isdir())):
            raise SystemExit('Unsafe or unbounded corresponding-source archive')
        if name in seen:
            raise SystemExit('Duplicate source archive path')
        seen.add(name)
        if any(p.lower().endswith('.app') for p in path.parts) or path.name.lower() in ('update.img', 'system.img', 'system-emulator.img') or name.lower().endswith('.cpio.gz') or path.suffix.lower() == '.ext4':
            raise SystemExit('Owner-local firmware/updater in source archive')
        if name in ('BUILDING.md', 'STATIC-LINKING.md') and entry.isfile() and entry.size:
            instructions.add(name)
        if name in wanted:
            if not entry.isfile() or entry.size > 1024**3:
                raise SystemExit('Bounded component source file required')
            digest = hashlib.sha256()
            source = archive.extractfile(entry)
            for block in iter(lambda: source.read(65536), b''):
                digest.update(block)
            if digest.hexdigest() != wanted[name]:
                raise SystemExit('Component source hash mismatch: ' + name)
            del wanted[name]
if wanted or instructions != {'BUILDING.md', 'STATIC-LINKING.md'}:
    raise SystemExit('Missing component source or rebuild/relink instructions')
print(json.dumps({'members': count, 'componentSources': len(components), 'licenceApproval': False}))
