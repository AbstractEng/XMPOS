"""Development package extraction must never install or execute package payloads."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('host_headers', Path(__file__).parent / 'live-mk1/host-headers.py')
headers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(headers)


def tar(entries, mode):
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode=mode) as archive:
        for name, data in entries:
            entry = tarfile.TarInfo(name)
            entry.size = len(data)
            archive.addfile(entry, io.BytesIO(data))
    return stream.getvalue()


def deb(data):
    name = 'data.tar.gz/'.ljust(16)
    header = f'{name}{0:<12}{0:<6}{0:<6}{"100644":<8}{len(data):<10}`\n'.encode()
    return b'!<arch>\n' + header + data + b'\n' * (len(data) % 2)


class HostHeaderTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='xmp-headers-test-')
        self.base = Path(self.temp.name)
        self.alsa = self.base / 'alsa.tar.xz'
        self.alsa.write_bytes(tar([('alsa-lib-1.2.11/include/version.h', b'#define TEST 1\n')], 'w:xz'))

    def tearDown(self):
        self.temp.cleanup()

    def fixture(self, entries):
        data = deb(tar(entries, 'w:gz'))
        (self.base / 'synthetic.deb').write_bytes(data)
        return {'packages': [{'package': 'synthetic', 'bytes': len(data),
                              'sha256': hashlib.sha256(data).hexdigest()}]}

    def test_only_headers_startup_objects_and_notices_are_extracted(self):
        lock = self.fixture([('usr/arm-linux-gnueabihf/include/test.h', b'/* test */'),
                             ('usr/arm-linux-gnueabihf/lib/crt1.o', b'Synthetic CRT'),
                             ('usr/arm-linux-gnueabihf/lib/libc.so.6', b'NEVER COPY'),
                             ('postinst', b'NEVER EXECUTE')])
        output = self.base / 'out'
        result = headers.extract(self.base, lock, self.alsa, output)
        self.assertFalse(result['packageScriptsExecuted'])
        self.assertTrue((output / 'usr/arm-linux-gnueabihf/include/test.h').exists())
        self.assertTrue((output / 'usr/arm-linux-gnueabihf/lib/crt1.o').exists())
        self.assertFalse((output / 'usr/arm-linux-gnueabihf/lib/libc.so.6').exists())
        self.assertFalse((output / 'postinst').exists())

    def test_refuses_changed_package_and_traversal(self):
        lock = self.fixture([('../escape', b'bad')])
        with self.assertRaisesRegex(ValueError, 'Unsafe'):
            headers.extract(self.base, lock, self.alsa, self.base / 'unsafe')
        lock['packages'][0]['sha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'hash mismatch'):
            headers.extract(self.base, lock, self.alsa, self.base / 'changed')

    def test_rejects_non_deb_and_truncated_members(self):
        for data in [b'not ar', deb(b'x')[:-9]]:
            with self.assertRaises(ValueError):
                headers.payload(data)


if __name__ == '__main__':
    unittest.main()
