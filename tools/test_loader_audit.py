"""Real host filesystem fixtures and independent legacy-header decoding; no hardware."""
import hashlib
import importlib.util
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import unittest
import zlib

spec = importlib.util.spec_from_file_location('loader_audit', Path(__file__).parent / 'live-mk1/loader-audit.py')
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


class LoaderAuditTests(unittest.TestCase):
    def test_legacy_script_header_crc_and_two_component_layout(self):
        script, ramdisk = b'echo test\n', b'original-test-ramdisk'
        image = audit.script_image(script, ramdisk)
        magic, crc, stamp, size, load, entry, data_crc = struct.unpack('>7I', image[:28])
        self.assertEqual(magic, 0x27051956)
        self.assertEqual((stamp, load, entry), (0, 0, 0))
        header = bytearray(image[:64]); header[4:8] = bytes(4)
        self.assertEqual(crc, zlib.crc32(header))
        self.assertEqual(data_crc, zlib.crc32(image[64:]))
        self.assertEqual(size, len(image) - 64)
        self.assertEqual(image[28:32], bytes([5, 2, 6, 0]))
        self.assertEqual(struct.unpack('>3I', image[64:76]), (len(script), len(ramdisk), 0))
        self.assertEqual(image[76:76 + len(script)], script)
        self.assertEqual(image[76 + len(script) + (-len(script) % 4):], ramdisk)
        for args in [(b'', b'x'), (b'x', b''), (b'x' * 32769, b'x')]:
            with self.assertRaises(ValueError): audit.script_image(*args)

    @unittest.skipUnless(shutil.which('mke2fs'), 'Local filesystem tool not installed')
    def test_streaming_ledger_handles_empty_sparse_and_large_files(self):
        with tempfile.TemporaryDirectory(prefix='xmp-loader-ledger-') as at:
            base = Path(at); tree = base / 'tree'; boot = tree / 'boot'; boot.mkdir(parents=True)
            (boot / 'boot.scr.uimg').write_bytes(b'old script')
            (boot / 'zImage-test').write_bytes(b'original fixture kernel')
            (boot / 'zImage').symlink_to('zImage-test')
            (tree / 'empty').touch()
            size = 33 * 1024**2 + 1
            with (tree / 'sparse').open('wb') as stream: stream.truncate(size)
            image = base / 'test.ext4'
            with image.open('wb') as stream: stream.truncate(64 * 1024**2)
            subprocess.run(['mke2fs', '-q', '-t', 'ext4', '-F', '-b', '4096', '-I', '256', '-O', 'extent,^has_journal,^orphan_file', '-d', str(tree), str(image)], check=True, capture_output=True)
            result = audit.ledger(image)
            self.assertEqual(result['rows']['empty'], '644\t' + hashlib.sha256(b'').hexdigest())
            digest = hashlib.sha256()
            for n in range(0, size, 65536): digest.update(bytes(min(65536, size - n)))
            self.assertEqual(result['rows']['sparse'], '644\t' + digest.hexdigest())
            self.assertEqual(result['rows']['boot/zImage'], 'link\tzImage-test')
            self.assertTrue(all(0 < inode <= result['perGroup'] for inode in result['inodes']))


if __name__ == '__main__': unittest.main()
