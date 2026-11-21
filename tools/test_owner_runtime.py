"""Synthetic filesystem tests: no updater, vendor bytes or hardware required."""
import hashlib
import importlib.util
from pathlib import Path
import struct
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('owner_runtime', Path(__file__).parent / 'live-mk1/owner-runtime.py')
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


def fixture():
    data = bytearray(8192)
    struct.pack_into('<I', data, 1024, 16)  # inode count
    struct.pack_into('<I', data, 1024 + 40, 16)
    struct.pack_into('<H', data, 1024 + 56, 0xef53)
    struct.pack_into('<H', data, 1024 + 88, 256)
    struct.pack_into('<H', data, 1024 + 254, 64)
    struct.pack_into('<I', data, 2048 + 8, 4)  # inode table
    for number, mode, size, block in [(2, 0x4000, 1024, 6), (3, 0x8000, 5, 7)]:
        offset = 4096 + (number - 1) * 256
        struct.pack_into('<H', data, offset, mode)
        struct.pack_into('<I', data, offset + 4, size)
        struct.pack_into('<I', data, offset + 32, 0x80000)
        struct.pack_into('<HHHHI', data, offset + 40, 0xf30a, 1, 4, 0, 0)
        struct.pack_into('<IHHI', data, offset + 52, 0, 1, 0, block)
    offset = 4096 + 3 * 256
    struct.pack_into('<H', data, offset, 0xa000)
    struct.pack_into('<I', data, offset + 4, 4)
    data[offset + 40:offset + 44] = b'file'
    cursor = 6144
    for number, name, kind, length in [(2, '.', 2, 12), (2, '..', 2, 12),
                                       (3, 'file', 1, 12), (4, 'link', 7, 988)]:
        struct.pack_into('<IHBB', data, cursor, number, length, len(name), kind)
        data[cursor + 8:cursor + 8 + len(name)] = name.encode()
        cursor += length
    data[7168:7173] = b'hello'
    return data


class OwnerRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='xmp-runtime-test-')
        self.directory = Path(self.temp.name)
        self.image = self.directory / 'synthetic.ext4'
        self.image.write_bytes(fixture())
        self.fs = runtime.Ext4(self.image)
        self.lock = {'rootfsSha256': runtime.sha(self.image.read_bytes()),
                     'updaterImageSha256': 'a' * 64,
                     'files': [{'source': '/file', 'destination': 'usr/share/alsa/test',
                                'sha256': runtime.sha(b'hello'), 'bytes': 5}]}

    def tearDown(self):
        self.fs.close()
        self.temp.cleanup()

    def test_reads_extents_and_image_internal_symlinks(self):
        self.assertEqual(self.fs.content(self.fs.lookup('/file')), b'hello')
        self.assertEqual(self.fs.content(self.fs.lookup('/link')), b'hello')
        with self.assertRaisesRegex(ValueError, 'Missing'):
            self.fs.lookup('/etc/passwd')

    def test_short_symlink_may_use_an_extent_instead_of_inline_bytes(self):
        self.fs.close()
        data = fixture()
        offset = 4096 + 3 * 256
        struct.pack_into('<I', data, offset + 32, 0x80000)
        struct.pack_into('<HHHHI', data, offset + 40, 0xf30a, 1, 4, 0, 0)
        struct.pack_into('<IHHI', data, offset + 52, 0, 1, 0, 7)
        data[7168:7172] = b'file'
        self.image.write_bytes(data)
        self.fs = runtime.Ext4(self.image)
        self.assertEqual(self.fs.content(self.fs.inode(4)), b'file')
        self.assertEqual(self.fs.content(self.fs.lookup('/link')), b'fileo')

    def test_refuses_invalid_and_out_of_bounds_metadata(self):
        for offset, count in [(-1, 8), (8191, 8), (0, 32 * 1024**2 + 1)]:
            with self.assertRaises(ValueError):
                self.fs.read(offset, count)
        with self.assertRaises(ValueError):
            list(self.fs.extents(b'\0' * 60))
        with self.assertRaises(ValueError):
            self.fs.inode(999)

    def test_hash_checked_exclusive_extract(self):
        output = self.directory / 'runtime'
        receipt = runtime.extract(self.image, self.lock, output)
        self.assertFalse(receipt['hardwareAccess'])
        self.assertFalse(receipt['abiExecutionTested'])
        self.assertEqual((output / 'usr/share/alsa/test').read_bytes(), b'hello')
        with self.assertRaises(FileExistsError):
            runtime.extract(self.image, self.lock, output)

    def test_rejects_changed_rootfs_or_file_before_output(self):
        output = self.directory / 'runtime'
        self.lock['rootfsSha256'] = 'b' * 64
        with self.assertRaisesRegex(ValueError, 'pinned'):
            runtime.extract(self.image, self.lock, output)
        self.lock['rootfsSha256'] = runtime.sha(self.image.read_bytes())
        self.lock['files'][0]['sha256'] = 'b' * 64
        with self.assertRaisesRegex(ValueError, 'hash/size'):
            runtime.extract(self.image, self.lock, output)
        self.assertFalse(output.exists())

    def test_rejects_escape_and_duplicate_destinations(self):
        output = self.directory / 'runtime'
        self.lock['files'][0]['destination'] = '../outside'
        with self.assertRaisesRegex(ValueError, 'Unsafe'):
            runtime.extract(self.image, self.lock, output)
        self.lock['files'][0]['destination'] = 'usr/share/test'
        self.lock['files'] *= 2
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            runtime.extract(self.image, self.lock, output)
        self.assertFalse(output.exists())

    def test_public_filesystem_requires_dynamic_elf_and_excludes_owner_libraries(self):
        spec = importlib.util.spec_from_file_location('public_fixture',
                    Path(__file__).parents[1] / 'tests/fixtures/public-filesystem.py')
        fixture = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(fixture)
        lock = {'libraries': {name: {'provides': []} for name in
                    ('libc.so.6', 'libasound.so.2', 'libstdc++.so.6', 'libgcc_s.so.1')}}
        for extra, static, message in [(None, True, 'dynamic runtime'),
                                       ('/lib/libc.so.6', False, 'Unapproved')]:
            self.image.write_bytes(fixture.filesystem(extra, static))
            with self.assertRaisesRegex(ValueError, message):
                runtime.audit_public(self.image, lock)
        self.image.write_bytes(fixture.filesystem())
        result = runtime.audit_public(self.image, lock)
        self.assertEqual(len(result['binaries']), 3)
        self.assertFalse(result['runtimeLibrariesIncluded'])

    def test_rejects_library_search_paths_outside_owner_runtime(self):
        spec = importlib.util.spec_from_file_location('rpath_fixture',
                    Path(__file__).parents[1] / 'tests/fixtures/public-filesystem.py')
        fixture = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(fixture)
        lock = {'libraries': {name: {'provides': []} for name in
                    ('libc.so.6', 'libasound.so.2', 'libstdc++.so.6', 'libgcc_s.so.1')}}
        image = fixture.filesystem().replace(b'/lib\0', b'/bad\0')
        self.image.write_bytes(image)
        with self.assertRaisesRegex(ValueError, 'search path'):
            runtime.audit_public(self.image, lock)

    def test_rejects_non_arm_elf(self):
        for data in [b'', b'\x7fELF' + bytes(80), Path(__file__).read_bytes()]:
            with self.assertRaisesRegex(ValueError, 'ARM hard-float'):
                runtime.elf(data)


if __name__ == '__main__':
    unittest.main()
