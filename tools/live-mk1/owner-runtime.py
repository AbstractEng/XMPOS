"""Read pinned files from a local ext4 image. Never mount it or execute its contents."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import posixpath
import struct
import sys


def require(condition, message):
    if not condition:
        raise ValueError(message)


BOOT_SCREEN = '/usr/share/xmp/boot-screen.rgb'


FACTORY_PREFIX = '/usr/share/xmp/factory-kits/'
FACTORY_FILES = {
    'xmp-velvet.xmpkit': 'ea70e98491a1b6593ea2588b1e7e4deeed4530b7705cef84ffde96956af80e0f',
    'cc0-octal-deep.xmpkit': 'fbf68308fe48e9e7df07d61854997821e690658bdc5ffca16fd502b3d08fde52',
    'cc0-octal-punch.xmpkit': '7f3daacfd4cbd56ebb84e086c056d1451790cf32eac66f8634d4226ea2b5ceae',
    'cc0-virtuosity.xmpkit': 'ed4f4e830e7b91310242c44ffb535af4b2cc74b877459158f138c9d3ad3652ab',
    'octal-LICENSE': 'a2010f343487d3f7618affe54f789f5487602331c0a8d03f49e9a7c547cf0499',
    'virtuosity-LICENSE': 'a2010f343487d3f7618affe54f789f5487602331c0a8d03f49e9a7c547cf0499',
    'octal-LICENSES.md': '2e3b1f544630a4ad604ea30d83eb6279faac1ae23503bd8e1e96ba77861b76a2',
    'virtuosity-README.md': '53e3b1fecbbc9b71db173543b6204251b9f2363dac036aaaa7db3da7091b781a',
    'index.json': '0cda2ce644812d4a0c9d4965e62c4b8ac634bcba668f567804794d1d14d9659f',
}
FACTORY_HASHES = {FACTORY_PREFIX + name: digest for name, digest in FACTORY_FILES.items()}


def check_factory_catalog(seen):
    present = seen & FACTORY_HASHES.keys()
    if present:
        require(present == FACTORY_HASHES.keys(), 'Incomplete factory kit catalog')


def check_boot_screen(data):
    metadata = json.loads((Path(__file__).resolve().parents[2] /
                           'os/live-mk1/assets/boot-screen.json').read_text())
    require(len(data) == 3072016 and data[:16] == b'XMPBOOT1' + struct.pack('<II', 1280, 800)
            and hashlib.sha256(data).hexdigest() == metadata['sha256'],
            'Boot screen differs from approved Emerald Current artwork')


class Ext4:
    """Small read-only extent reader for the hash-pinned updater, not a general ext4 driver."""
    def __init__(self, path):
        image = Path(path)
        require(image.is_file() and not image.is_symlink() and image.stat().st_size <= 512 * 1024**2,
                'Bounded regular filesystem image required')
        self.file = open(path, 'rb')
        self.length = os.fstat(self.file.fileno()).st_size
        s = self.read(1024, 1024)
        require(s[56:58] == b'\x53\xef', 'Expected ext4')
        block_log = struct.unpack_from('<I', s, 24)[0]
        require(block_log <= 2, 'Unsupported filesystem block size')
        self.block = 1024 << block_log
        self.per_group = struct.unpack_from('<I', s, 40)[0]
        self.inode_size = struct.unpack_from('<H', s, 88)[0]
        self.desc_size = struct.unpack_from('<H', s, 254)[0] or 32
        self.inodes = struct.unpack_from('<I', s, 0)[0]
        require(self.block in (1024, 2048, 4096) and self.per_group > 0 and
                128 <= self.inode_size <= self.block and self.desc_size in (32, 64),
                'Unsupported filesystem geometry')

    def close(self):
        self.file.close()

    def read(self, offset, count):
        require(0 <= count <= 32 * 1024**2 and 0 <= offset <= self.length - count,
                'Out-of-bounds filesystem read')
        self.file.seek(offset)
        data = self.file.read(count)
        require(len(data) == count, 'Truncated filesystem')
        return data

    def inode(self, number):
        require(1 <= number <= self.inodes, 'Invalid inode')
        group, index = divmod(number - 1, self.per_group)
        table_at = (2 if self.block == 1024 else 1) * self.block
        desc = self.read(table_at + group * self.desc_size, self.desc_size)
        table = struct.unpack_from('<I', desc, 8)[0]
        if self.desc_size == 64:
            table += struct.unpack_from('<I', desc, 40)[0] << 32
        return self.read(table * self.block + index * self.inode_size, self.inode_size)

    def extents(self, data, expected=None):
        magic, count, capacity, depth = struct.unpack_from('<4H', data)
        require(magic == 0xf30a and count <= capacity <= (len(data) - 12) // 12 and
                depth <= 5 and (expected is None or depth == expected), 'Invalid extent tree')
        for n in range(count):
            offset = 12 + n * 12
            if depth:
                _, low, high = struct.unpack_from('<IIH', data, offset)
                yield from self.extents(self.read((low + (high << 32)) * self.block,
                                                 self.block), depth - 1)
            else:
                logical, length, high, low = struct.unpack_from('<IHHI', data, offset)
                require(0 < length <= 32768, 'Unwritten/invalid extent refused')
                yield logical, length, low + (high << 32)

    @staticmethod
    def kind(inode):
        return struct.unpack_from('<H', inode)[0] & 0xf000

    def content(self, inode):
        size = struct.unpack_from('<I', inode, 4)[0]
        require(struct.unpack_from('<I', inode, 108)[0] == 0 and size <= 32 * 1024**2,
                'Oversized file refused')
        # A short symlink can still use an extent (for example when rewritten
        # by debugfs). Length alone does not imply an inline i_block target.
        if self.kind(inode) == 0xa000 and size <= 60 and not struct.unpack_from('<I', inode, 32)[0] & 0x80000:
            return inode[40:40 + size]
        require(struct.unpack_from('<I', inode, 32)[0] & 0x80000, 'Extent inode required')
        output = bytearray(size)
        end = 0
        for logical, length, physical in self.extents(inode[40:100]):
            start = logical * self.block
            require(start >= end and start < size, 'Overlapping/out-of-bounds extent')
            count = min(length * self.block, size - start)
            output[start:start + count] = self.read(physical * self.block, count)
            end = start + count
        return bytes(output)

    def entries(self, inode):
        require(self.kind(inode) == 0x4000, 'Directory required')
        data = self.content(inode)
        offset = 0
        while offset < len(data):
            require(offset + 8 <= len(data), 'Truncated directory')
            number, length, size, kind = struct.unpack_from('<IHBB', data, offset)
            require(length >= 8 and length % 4 == 0 and offset + length <= len(data) and
                    size <= length - 8, 'Invalid directory record')
            if number:
                name = data[offset + 8:offset + 8 + size].decode('utf8')
                require('/' not in name and '\x00' not in name, 'Invalid directory name')
                yield name, number, kind
            offset += length

    def lookup(self, path, depth=0):
        require(path.startswith('/') and depth < 24, 'Invalid path or symlink cycle')
        path = posixpath.normpath(path)
        parts = PurePosixPath(path).parts[1:]
        inode, current = self.inode(2), '/'
        for index, part in enumerate(parts):
            found = [number for name, number, _ in self.entries(inode) if name == part]
            require(len(found) == 1, 'Missing/duplicate runtime path: ' + path)
            inode = self.inode(found[0])
            if self.kind(inode) == 0xa000:
                target = self.content(inode).decode('utf8')
                return self.lookup(posixpath.join(current, target, *parts[index + 1:]), depth + 1)
            current = posixpath.join(current, part)
        return inode


def elf(data):
    """Inspect ELF32 ARM dynamic dependencies/version tables without loading code."""
    require(len(data) >= 52 and data[:7] == b'\x7fELF\x01\x01\x01' and
            struct.unpack_from('<H', data, 18)[0] == 40 and
            struct.unpack_from('<I', data, 36)[0] & 0x400, 'ARM hard-float ELF required')
    phoff, shoff = struct.unpack_from('<II', data, 28)
    phsize, phnum, shsize, shnum, names_index = struct.unpack_from('<5H', data, 42)
    require(phsize == 32 and shsize == 40 and phnum < 256 and
            0 < shnum < 4096 and names_index < shnum, 'Invalid ELF tables')
    def chunk(offset, count):
        require(0 <= offset <= len(data) - count, 'Out-of-bounds ELF table')
        return data[offset:offset + count]
    def string(table, offset):
        require(0 <= offset < len(table), 'Invalid ELF string')
        end = table.find(b'\0', offset)
        require(end >= offset, 'Unterminated ELF string')
        return table[offset:end].decode('ascii')
    sections = [struct.unpack('<10I', chunk(shoff + n * shsize, 40)) for n in range(shnum)]
    names = chunk(sections[names_index][4], sections[names_index][5])
    table = {string(names, s[0]): chunk(s[4], s[5]) for s in sections if s[1] != 8}
    strings = table.get('.dynstr', b'')
    dynamic = table.get('.dynamic', b'')
    needed = [string(strings, value) for tag, value in struct.iter_unpack('<II', dynamic) if tag == 1]
    interpreter = None
    for n in range(phnum):
        p = struct.unpack('<8I', chunk(phoff + n * phsize, 32))
        if p[0] == 3:
            interpreter = chunk(p[1], p[4]).rstrip(b'\0').decode('ascii')
    requires, provides = {}, []
    versions = table.get('.gnu.version_r', b'')
    at = 0
    while versions:
        require(at + 16 <= len(versions), 'Invalid version requirement')
        _, count, file, aux, next_at = struct.unpack_from('<HHIII', versions, at)
        require(count < 4096, 'Unbounded version requirements')
        offset, found = at + aux, []
        for _ in range(count):
            require(offset + 16 <= len(versions), 'Invalid version auxiliary table')
            _, _, _, name, following = struct.unpack_from('<IHHII', versions, offset)
            found.append(string(strings, name))
            offset += following
        requires[string(strings, file)] = found
        if not next_at:
            break
        require(next_at >= 16, 'Invalid version chain')
        at += next_at
    versions = table.get('.gnu.version_d', b'')
    at = 0
    while versions:
        require(at + 20 <= len(versions), 'Invalid provided versions')
        _, _, _, _, _, aux, next_at = struct.unpack_from('<HHHHIII', versions, at)
        require(at + aux + 8 <= len(versions), 'Invalid provided version auxiliary')
        name, _ = struct.unpack_from('<II', versions, at + aux)
        provides.append(string(strings, name))
        if not next_at:
            break
        require(next_at >= 20, 'Invalid provided version chain')
        at += next_at
    rpaths = [string(strings, value) for tag, value in struct.iter_unpack('<II', dynamic) if tag == 15]
    runpaths = [string(strings, value) for tag, value in struct.iter_unpack('<II', dynamic) if tag == 29]
    require(len(rpaths) <= 1 and len(runpaths) <= 1, 'Duplicate ELF search paths')
    return {'needed': needed, 'interpreter': interpreter, 'requires': requires, 'provides': provides,
            'rpath': rpaths[0] if rpaths else None, 'runpath': runpaths[0] if runpaths else None}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def extract(image, lock, output):
    require(Path(image).is_file() and not Path(image).is_symlink(), 'Regular image required')
    with open(image, 'rb') as source:
        require(hashlib.file_digest(source, 'sha256').hexdigest() == lock['rootfsSha256'],
                'Runtime rootfs differs from pinned 3.10.1 updater')
    require(len(lock['files']) <= 1024, 'Unbounded runtime inventory')
    filesystem = Ext4(image)
    try:
        files, libraries, total = [], {}, 0
        # Verify everything before creating the output directory.
        for entry in lock['files']:
            inode = filesystem.lookup(entry['source'])
            require(filesystem.kind(inode) == 0x8000, 'Regular runtime file required')
            data = filesystem.content(inode)
            total += len(data)
            require(total <= 32 * 1024**2 and sha(data) == entry['sha256'] and
                    len(data) == entry['bytes'], 'Runtime file hash/size bound failed')
            path = PurePosixPath(entry['destination'])
            require(not path.is_absolute() and '..' not in path.parts and
                    path.parts[0] in ('lib', 'usr') and '\\' not in str(path), 'Unsafe runtime output')
            if path.parts[0] == 'lib':
                libraries[path.name] = elf(data)
            files.append((entry, data))
        require(len({e['destination'] for e, _ in files}) == len(files), 'Duplicate runtime output')
        for name, info in libraries.items():
            for dependency in info['needed']:
                require(dependency in libraries, 'Missing runtime dependency: ' + dependency)
            for dependency, versions in info['requires'].items():
                require(dependency in libraries and set(versions) <= set(libraries[dependency]['provides']),
                        'Missing runtime symbol versions for ' + name)
        Path(output).mkdir(mode=0o700)  # exclusive, never touch an existing tree
        for entry, data in files:
            path = Path(output) / entry['destination']
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open('xb') as destination:
                destination.write(data)
            path.chmod(0o755 if entry['destination'].startswith('lib/') else 0o644)
        return {'format': 'xmp-owner-local-runtime', 'version': 1, 'mpcOsVersion': '3.10.1',
                'updaterImageSha256': lock['updaterImageSha256'], 'rootfsSha256': lock['rootfsSha256'],
                'files': lock['files'], 'libraries': libraries, 'bytes': total,
                'redistribution': 'forbidden: owner-local extraction', 'hardwareAccess': False,
                'abiExecutionTested': False}
    finally:
        filesystem.close()


def image_files(image):
    filesystem = Ext4(image)
    files, visited, total = {}, set(), 0
    def walk(inode, path, depth=0):
        nonlocal total
        require(depth <= 16, 'Unbounded image depth')
        for name, number, _ in filesystem.entries(inode):
            if name in ('.', '..'):
                continue
            require(len(visited) < 4096 and number not in visited, 'Image links/cycles/size refused')
            visited.add(number)
            child = filesystem.inode(number)
            target = posixpath.join(path, name)
            if filesystem.kind(child) == 0x4000:
                walk(child, target, depth + 1)
            else:
                require(filesystem.kind(child) == 0x8000, 'Only regular image files are allowed')
                data = filesystem.content(child)
                total += len(data)
                require(total <= 64 * 1024**2, 'Image file contents exceed bound')
                mode = struct.unpack_from('<H', child)[0] & 0xfff
                require(mode == (0o755 if data.startswith(b'\x7fELF') else 0o644), 'Unsafe image file mode')
                files[target] = data
    try:
        walk(filesystem.inode(2), '/')
        return files
    finally:
        filesystem.close()


def check_dynamic(data, lock):
    info = elf(data)
    require(info['interpreter'] == '/lib/ld-linux-armhf.so.3' and info['needed'],
            'XMP executable must use owner-local dynamic runtime')
    require(info['rpath'] == '/lib' and info['runpath'] is None, 'XMP ELF must pin inherited runtime search path to /lib')
    for dependency in info['needed']:
        require(dependency in lock['libraries'], 'Unapproved runtime dependency: ' + dependency)
    for dependency, versions in info['requires'].items():
        require(dependency in lock['libraries'] and
                set(versions) <= set(lock['libraries'][dependency]['provides']),
                'Unsupported XMP runtime symbol versions')
    return info


def runtime_files(directory, lock):
    directory = Path(directory)
    require(directory.is_dir() and not directory.is_symlink(), 'Regular runtime directory required')
    receipt = directory / 'owner-preparation.json'
    require(receipt.is_file() and not receipt.is_symlink() and receipt.stat().st_size <= 256 * 1024,
            'Owner preparation receipt required')
    preparation = json.loads(receipt.read_text())
    require(preparation.get('format') == 'xmp-owner-local-runtime' and preparation.get('version') == 1 and
            preparation.get('mpcOsVersion') == '3.10.1' and preparation.get('updaterSignatureVerified') is True and
            preparation.get('updaterImageSha256') == lock['updaterImageSha256'] and
            preparation.get('rootfsSha256') == lock['rootfsSha256'] and preparation.get('files') == lock['files'],
            'Owner runtime receipt differs from pinned 3.10.1 input')
    allowed = {e['destination'] for e in lock['files']} | {'owner-preparation.json', 'runtime-receipt.json'}
    seen = set()
    allowed_directories = {str(parent) for name in allowed for parent in PurePosixPath(name).parents if str(parent) != '.'}
    for parent, directories, filenames in os.walk(directory, followlinks=False):
        require(len(seen) <= 1024, 'Unbounded runtime tree')
        for name in directories:
            child = Path(parent, name)
            require(not child.is_symlink() and child.relative_to(directory).as_posix() in allowed_directories,
                    'Unexpected runtime directory or symlink refused')
        for name in filenames:
            path = Path(parent, name)
            relative = path.relative_to(directory).as_posix()
            require(relative in allowed and path.is_file() and not path.is_symlink(),
                    'Unexpected runtime file or symlink: ' + relative)
            seen.add(relative)
    require(seen == allowed, 'Incomplete runtime tree')
    files = {}
    for entry in lock['files']:
        path = directory / entry['destination']
        require(path.stat().st_size == entry['bytes'] and entry['bytes'] <= 16 * 1024**2,
                'Runtime file size mismatch')
        data = path.read_bytes()
        require(sha(data) == entry['sha256'], 'Runtime file hash mismatch: ' + entry['destination'])
        files['/' + entry['destination']] = data
    return files, {'files': len(files), 'preparationSha256': sha(receipt.read_bytes()),
                   'updaterImageSha256': lock['updaterImageSha256']}


def write_tree(files, destination):
    destination = Path(destination)
    destination.mkdir(mode=0o755)
    for directory in ('proc', 'sys', 'dev', 'tmp', 'media/xmp', 'etc', 'lib'):
        (destination / directory).mkdir(parents=True, exist_ok=True, mode=0o755)
    for name, data in files.items():
        relative = PurePosixPath(name).relative_to('/')
        require('..' not in relative.parts, 'Unsafe stage path')
        target = destination.joinpath(*relative.parts)
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
        with target.open('xb') as stream:
            stream.write(data)
        target.chmod(0o755 if data.startswith(b'\x7fELF') else 0o644)


def stage_owner(template, runtime, lock, destination):
    audit_public(template, lock)
    files = image_files(template)
    own, receipt = runtime_files(runtime, lock)
    require(not set(files) & set(own), 'Runtime would replace public files')
    write_tree({**files, **own}, destination)
    return receipt


def stage_emulator(destination, init, twin, lock):
    init_data, twin_data = Path(init).read_bytes(), Path(twin).read_bytes()
    check_dynamic(init_data, lock)
    check_dynamic(twin_data, lock)
    for name, data in [('sbin/init', init_data), ('usr/lib/xmp/xmp-live-twin', twin_data)]:
        target = Path(destination) / name
        require(not target.is_symlink(), 'Stage symlink refused')
        if name == 'sbin/init':
            target.write_bytes(data)
        else:
            with target.open('xb') as stream:
                stream.write(data)
        target.chmod(0o755)
    return {'emulatorOnly': True}


def audit_owner(image, template, runtime, lock, emulator=None):
    audit_public(template, lock)
    expected = image_files(template)
    own, receipt = runtime_files(runtime, lock)
    expected.update(own)
    if emulator:
        init, twin = (Path(p).read_bytes() for p in emulator)
        check_dynamic(init, lock)
        check_dynamic(twin, lock)
        expected['/sbin/init'] = init
        expected['/usr/lib/xmp/xmp-live-twin'] = twin
    actual = image_files(image)
    require(actual.keys() == expected.keys() and all(actual[n] == b for n, b in expected.items()),
            'Assembled image differs from exact template/runtime inputs')
    return {'fileHashes': {n: sha(b) for n, b in actual.items()}, 'files': len(actual),
            'runtimeLibrariesIncluded': True, 'abiExecutionTested': False, **receipt}


def audit_owner_push(image, lock, source_hash, session_hash):
    """Self-contained owner-image audit; no extracted vendor directory required."""
    require(Path(image).stat().st_size == 32 * 1024**2, 'Owner image must be 32 MiB')
    actual = image_files(image)
    binaries = {'/sbin/init', '/usr/lib/xmp/xmp-live-session', '/usr/lib/xmp/xmp-bridge'}
    public = binaries | {'/usr/share/xmp/fonts/Inter-LICENSE.txt',
                         '/usr/share/xmp/fonts/JetBrainsMono-OFL.txt', '/etc/xmp-release'}
    # Older verified images remain auditable; new builders always include artwork.
    if BOOT_SCREEN in actual:
        check_boot_screen(actual[BOOT_SCREEN])
        public.add(BOOT_SCREEN)
    check_factory_catalog(actual.keys())
    for name, digest in FACTORY_HASHES.items():
        if name in actual:
            require(sha(actual[name]) == digest, 'Changed factory asset: ' + name)
            public.add(name)
    require(actual.keys() == public | {'/' + e['destination'] for e in lock['files']},
            'Unexpected or missing owner image file')
    require(actual['/etc/xmp-release'] ==
            ('XMP MPC Live Mk1; MPC OS 3.10.1; source ' + source_hash + '\n').encode(),
            'Owner image source marker mismatch')
    require(sha(actual['/usr/lib/xmp/xmp-live-session']) == session_hash,
            'Owner image session binary mismatch')
    for name in binaries:
        info = check_dynamic(actual[name], lock)
        if name == '/usr/lib/xmp/xmp-live-session':
            require({'libasound.so.2', 'libstdc++.so.6', 'libgcc_s.so.1'} <= set(info['needed']),
                    'Session runtime dependencies missing')
    for entry in lock['files']:
        data = actual['/' + entry['destination']]
        require(len(data) == entry['bytes'] and sha(data) == entry['sha256'],
                'Owner image runtime mismatch: ' + entry['destination'])
    return {'files': len(actual), 'runtimeFilesVerified': len(lock['files']), 'hardwareAccess': False}


def runtime_cpio(image, template, probe, lock, output):
    import gzip
    audit_public(template, lock)
    original = image_files(template)
    files = image_files(image)
    expected = set(original) | {'/' + e['destination'] for e in lock['files']}
    require(files.keys() == expected and all(files[n] == b for n, b in original.items()),
            'Runtime VM image differs from public template')
    for entry in lock['files']:
        data = files['/' + entry['destination']]
        require(len(data) == entry['bytes'] and sha(data) == entry['sha256'], 'Runtime VM library hash mismatch')
    data = Path(probe).read_bytes()
    check_dynamic(data, lock)
    files['/init'] = data
    directories = {'.', 'dev'}
    for name in files:
        relative = PurePosixPath(name).relative_to('/')
        directories.update(p.as_posix() for p in relative.parents if str(p) != '.')
    inode = 1
    with open(output, 'xb') as raw, gzip.GzipFile(fileobj=raw, mode='wb', mtime=0) as archive:
        def entry(name, mode, content=b'', major=0, minor=0):
            nonlocal inode
            encoded = name.encode() + b'\0'
            fields = [inode, mode, 0, 0, 1, 0, len(content), 0, 0, major, minor, len(encoded), 0]
            header = b'070701' + ''.join(f'{value:08x}' for value in fields).encode()
            archive.write(header + encoded)
            archive.write(b'\0' * (-(110 + len(encoded)) % 4))
            archive.write(content)
            archive.write(b'\0' * (-len(content) % 4))
            inode += 1
        for name in sorted(directories, key=lambda n: (n.count('/'), n)):
            entry(name, 0o40755)
        # These are archive metadata for the isolated guest, never host device nodes.
        entry('dev/console', 0o20600, major=5, minor=1)
        entry('dev/null', 0o20666, major=1, minor=3)
        for name, data in sorted(files.items()):
            entry(name.lstrip('/'), 0o100755 if data.startswith(b'\x7fELF') else 0o100644, data)
        entry('TRAILER!!!', 0)
    return {'files': len(files), 'runtimeFilesVerified': len(lock['files']),
            'physicalDevices': False, 'network': False, 'probeSha256': sha(files['/init'])}


def audit_public(image, lock):
    """Inspect actual public filesystem contents; never trust a manifest flag alone."""
    filesystem = Ext4(image)
    allowed = {'/sbin/init', '/usr/lib/xmp/xmp-live-session', '/usr/lib/xmp/xmp-bridge',
               '/usr/share/xmp/fonts/Inter-LICENSE.txt', '/usr/share/xmp/fonts/JetBrainsMono-OFL.txt',
               '/etc/xmp-release'}
    allowed.add(BOOT_SCREEN)
    allowed.update(FACTORY_HASHES)
    required = {'/sbin/init', '/usr/lib/xmp/xmp-live-session', '/usr/lib/xmp/xmp-bridge',
                '/usr/share/xmp/fonts/Inter-LICENSE.txt', '/usr/share/xmp/fonts/JetBrainsMono-OFL.txt'}
    binaries, seen, visited = {}, set(), set()
    def walk(inode, path, depth=0):
        require(depth <= 16 and len(visited) < 4096, 'Unbounded public filesystem')
        for name, number, _ in filesystem.entries(inode):
            if name in ('.', '..'):
                continue
            target = posixpath.join(path, name)
            require(len(visited) < 4096 and number not in visited,
                    'Public hardlinks/directory cycles/unbounded tree refused')
            visited.add(number)
            child = filesystem.inode(number)
            if filesystem.kind(child) == 0x4000:
                walk(child, target, depth + 1)
            else:
                require(filesystem.kind(child) == 0x8000 and target in allowed,
                        'Unapproved public filesystem file: ' + target)
                seen.add(target)
                data = filesystem.content(child)
                if target == BOOT_SCREEN:
                    check_boot_screen(data)
                if target in FACTORY_HASHES:
                    require(sha(data) == FACTORY_HASHES[target], 'Changed factory asset: ' + target)
                if target in ('/sbin/init', '/usr/lib/xmp/xmp-live-session', '/usr/lib/xmp/xmp-bridge'):
                    info = check_dynamic(data, lock)
                    if target == '/usr/lib/xmp/xmp-live-session':
                        require({'libasound.so.2', 'libstdc++.so.6', 'libgcc_s.so.1'} <= set(info['needed']),
                                'Session must dynamically link ALSA and C++ runtime')
                    require(info['interpreter'] == '/lib/ld-linux-armhf.so.3' and info['needed'],
                            'Public XMP executable must use owner-local dynamic runtime: ' + target)
                    for dependency in info['needed']:
                        require(dependency in lock['libraries'], 'Unapproved runtime dependency')
                    for dependency, versions in info['requires'].items():
                        require(dependency in lock['libraries'] and
                                set(versions) <= set(lock['libraries'][dependency]['provides']),
                                'Unsupported XMP runtime symbol versions')
                    binaries[target] = info
    try:
        walk(filesystem.inode(2), '/')
        require(required <= seen, 'Missing XMP executables or font notices')
        check_factory_catalog(seen)
        return {'publicFiles': sorted(seen), 'binaries': binaries,
                'fileHashes': {n: sha(b) for n, b in image_files(image).items()},
                'runtimeLibrariesIncluded': False, 'abiExecutionTested': False,
                'auditScope': 'filesystem allowlist and ELF dependency/version tables'}
    finally:
        filesystem.close()


if __name__ == '__main__':
    try:
        command = sys.argv[1]
        if command == 'runtime-cpio':
            lock = json.loads(Path(sys.argv[5]).read_text())
            result = runtime_cpio(sys.argv[2], sys.argv[3], sys.argv[4], lock, sys.argv[6])
        elif command in ('audit-public', 'verify-runtime', 'check-elf'):
            lock = json.loads(Path(sys.argv[3]).read_text())
            if command == 'audit-public':
                result = audit_public(sys.argv[2], lock)
            elif command == 'verify-runtime':
                result = runtime_files(sys.argv[2], lock)[1]
            else:
                result = {p: check_dynamic(Path(p).read_bytes(), lock) for p in [sys.argv[2]] + sys.argv[4:]}
        elif command == 'audit-owner-push':
            lock = json.loads(Path(sys.argv[3]).read_text())
            result = audit_owner_push(sys.argv[2], lock, sys.argv[4], sys.argv[5])
        elif command == 'stage-owner':
            lock = json.loads(Path(sys.argv[4]).read_text())
            result = stage_owner(sys.argv[2], sys.argv[3], lock, sys.argv[5])
        elif command == 'stage-emulator':
            lock = json.loads(Path(sys.argv[5]).read_text())
            result = stage_emulator(*sys.argv[2:5], lock)
        elif command == 'audit-owner':
            lock = json.loads(Path(sys.argv[5]).read_text())
            result = audit_owner(*sys.argv[2:5], lock, sys.argv[6:8] or None)
        else:
            lock = json.loads(Path(sys.argv[2]).read_text())
            result = extract(sys.argv[1], lock, sys.argv[3])
            Path(sys.argv[3], 'runtime-receipt.json').write_text(json.dumps(result, indent=2) + '\n')
            result = {'files': len(result['files']), 'bytes': result['bytes'],
                      'abiExecutionTested': False, 'hardwareAccess': False}
        print(json.dumps(result))
    except Exception as error:
        raise SystemExit(str(error)) from error
