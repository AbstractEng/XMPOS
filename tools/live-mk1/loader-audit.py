"""Streaming filesystem ledger and legacy U-Boot image checks; local files only."""
import hashlib
import importlib.util
import json
from pathlib import Path
import struct
import sys
import zlib

spec = importlib.util.spec_from_file_location('owner_runtime', Path(__file__).with_name('owner-runtime.py'))
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


def script_image(script, ramdisk):
    if not 0 < len(script) <= 32768 or not 0 < len(ramdisk) <= 8 * 1024**2:
        raise ValueError('Bounded script and ramdisk required')
    data = struct.pack('>3I', len(script), len(ramdisk), 0) + script + b'\0' * (-len(script) % 4) + ramdisk
    header = bytearray(struct.pack('>7I4B32s', 0x27051956, 0, 0, len(data), 0, 0, zlib.crc32(data), 5, 2, 6, 0, b'xmp-loader'))
    struct.pack_into('>I', header, 4, zlib.crc32(header))
    return bytes(header) + data


def ledger(path):
    fs = runtime.Ext4(path)
    rows, visited = {}, set()
    try:
        def walk(number, name):
            inode = fs.inode(number)
            mode = struct.unpack_from('<H', inode)[0]
            kind = mode & 0xf000
            if kind == 0x4000:
                if number in visited or len(visited) > 100000:
                    raise ValueError('Directory cycle or excessive filesystem')
                visited.add(number)
                for child, identity, _ in fs.entries(inode):
                    if child not in ('.', '..'):
                        walk(identity, (name + '/' + child).lstrip('/'))
            elif kind == 0xa000:
                rows[name] = 'link\t' + fs.content(inode).decode('utf8')
            elif kind == 0x8000:
                size = struct.unpack_from('<I', inode, 4)[0]
                if struct.unpack_from('<I', inode, 108)[0] or size > fs.length:
                    raise ValueError('Oversized filesystem member')
                digest, at = hashlib.sha256(), 0
                for logical, length, physical in (fs.extents(inode[40:100]) if size else []):
                    start = logical * fs.block
                    if start < at or start >= size:
                        raise ValueError('Invalid file extent')
                    while at < start:
                        count = min(start - at, 65536)
                        digest.update(bytes(count)); at += count
                    count = min(length * fs.block, size - start)
                    offset = physical * fs.block
                    for done in range(0, count, 65536):
                        digest.update(fs.read(offset + done, min(65536, count - done)))
                    at = start + count
                while at < size:
                    count = min(size - at, 65536)
                    digest.update(bytes(count)); at += count
                rows[name] = f'{mode & 0o7777:o}\t{digest.hexdigest()}'
        walk(2, '')
        boot = dict((name, number) for name, number, _ in fs.entries(fs.lookup('/boot')))
        inodes = [boot['boot.scr.uimg'], boot['zImage']]
        target = fs.content(fs.inode(boot['zImage'])).decode('utf8') if fs.kind(fs.inode(boot['zImage'])) == 0xa000 else 'zImage'
        inodes.append(boot[Path(target).name])
        return {'rows': rows, 'inodes': inodes, 'perGroup': fs.per_group, 'kernelTarget': target}
    finally:
        fs.close()


if __name__ == '__main__':
    if sys.argv[1] == 'script':
        Path(sys.argv[4]).write_bytes(script_image(Path(sys.argv[2]).read_bytes(), Path(sys.argv[3]).read_bytes()))
    elif sys.argv[1] == 'ledger':
        result = ledger(sys.argv[2])
        Path(sys.argv[3]).write_text(''.join(f'{key}\t{value}\n' for key, value in sorted(result.pop('rows').items())))
        print(json.dumps(result))
    else:
        raise SystemExit('Unknown local loader audit operation')
