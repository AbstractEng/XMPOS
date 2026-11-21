"""Synthetic ext4/ELF policy fixture. Contains no executable instructions/vendor data."""
import struct
import sys


def fake_elf(static=False):
    names = b'\0.shstrtab\0.dynstr\0.dynamic\0'
    strings = b'\0libc.so.6\0libasound.so.2\0libstdc++.so.6\0libgcc_s.so.1\0/lib\0'
    interp = b'/lib/ld-linux-armhf.so.3\0'
    result = bytearray(512)
    result[:7] = b'\x7fELF\x01\x01\x01'
    struct.pack_into('<HHI', result, 16, 2, 40, 1)
    struct.pack_into('<III', result, 28, 52, 128, 0x5000400)
    struct.pack_into('<6H', result, 40, 52, 32, 0 if static else 1, 40, 4, 1)
    struct.pack_into('<8I', result, 52, 3, 288, 0, 0, len(interp), len(interp), 4, 1)
    for index, name, kind, offset, size in [(1, 1, 3, 320, len(names)),
                                          (2, 11, 3, 352, len(strings)),
                                          (3, 19, 6, 432, 8 if static else 48)]:
        struct.pack_into('<10I', result, 128 + index * 40, name, kind, 0, 0, offset, size, 0, 0, 1, 0)
    result[288:288 + len(interp)] = interp
    result[320:320 + len(names)] = names
    result[352:352 + len(strings)] = strings
    if not static:
        struct.pack_into('<12I', result, 432, 1, strings.index(b'libc'), 1, strings.index(b'libasound'),
                         1, strings.index(b'libstdc++'), 1, strings.index(b'libgcc_s'), 15, strings.index(b'/lib'), 0, 0)
    return bytes(result)


def filesystem(extra=None, static=False):
    files = {'/sbin/init': fake_elf(static), '/usr/lib/xmp/xmp-live-session': fake_elf(),
             '/usr/lib/xmp/xmp-bridge': fake_elf(),
             '/usr/share/xmp/fonts/Inter-LICENSE.txt': b'Synthetic font notice',
             '/usr/share/xmp/fonts/JetBrainsMono-OFL.txt': b'Synthetic font notice'}
    if extra:
        files[extra] = b'Synthetic owner-local file'
    directories = {'/'}
    for name in files:
        parts = name.strip('/').split('/')
        directories.update('/' + '/'.join(parts[:i]) for i in range(1, len(parts)))
    paths = sorted(directories) + sorted(files)
    numbers = {path: n + 2 for n, path in enumerate(paths)}
    data = bytearray(65536)
    struct.pack_into('<I', data, 1024, 32)
    struct.pack_into('<I', data, 1064, 32)
    struct.pack_into('<H', data, 1080, 0xef53)
    struct.pack_into('<H', data, 1112, 256)
    struct.pack_into('<H', data, 1278, 64)
    struct.pack_into('<I', data, 2056, 4)
    block = 13
    for path in paths:
        directory = path in directories
        if directory:
            children = [(numbers[path], '.', 2), (numbers.get(path.rsplit('/', 1)[0] or '/', 2), '..', 2)]
            children += [(numbers[p], p.rsplit('/', 1)[1], 2 if p in directories else 1)
                         for p in paths if p != '/' and p.rsplit('/', 1)[0] == path.rstrip('/')]
            content = bytearray(1024)
            at = 0
            for index, (number, name, kind) in enumerate(children):
                length = (8 + len(name) + 3) // 4 * 4 if index < len(children) - 1 else 1024 - at
                struct.pack_into('<IHBB', content, at, number, length, len(name), kind)
                content[at + 8:at + 8 + len(name)] = name.encode()
                at += length
        else:
            content = files[path]
        inode = 4096 + (numbers[path] - 1) * 256
        struct.pack_into('<H', data, inode, 0x4000 | 0o755 if directory else 0x8000 | (0o755 if content[:4] == b'\x7fELF' else 0o644))
        struct.pack_into('<I', data, inode + 4, len(content))
        struct.pack_into('<I', data, inode + 32, 0x80000)
        struct.pack_into('<HHHHI', data, inode + 40, 0xf30a, 1, 4, 0, 0)
        struct.pack_into('<IHHI', data, inode + 52, 0, 1, 0, block)
        data[block * 1024:block * 1024 + len(content)] = content
        block += 1
    return data


if __name__ == '__main__':
    sys.stdout.buffer.write(filesystem(sys.argv[1] if len(sys.argv) > 1 else None))
