"""Real local ext4 assembly with wholly synthetic ELF bytes and runtime receipts."""
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


runtime = module('owner_runtime_assembly', ROOT / 'tools/live-mk1/owner-runtime.py')
fixture = module('public_assembly_fixture', ROOT / 'tests/fixtures/public-filesystem.py')


class OwnerAssemblyTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='xmp-assembly-test-')
        self.base = Path(self.temporary.name)
        self.template = self.base / 'public.img'
        self.template.write_bytes(fixture.filesystem())
        self.owner = self.base / 'owner files'
        self.owner.mkdir()
        libraries = ['libc.so.6', 'libasound.so.2', 'libstdc++.so.6', 'libgcc_s.so.1', 'ld-linux-armhf.so.3']
        self.lock = {'rootfsSha256': 'a' * 64, 'updaterImageSha256': 'b' * 64,
                     'libraries': {n: {'provides': []} for n in libraries}, 'files': []}
        for name in libraries:
            data = fixture.fake_elf()
            path = self.owner / 'lib' / name
            path.parent.mkdir(exist_ok=True)
            path.write_bytes(data)
            self.lock['files'].append({'source': '/lib/' + name, 'destination': 'lib/' + name,
                                       'bytes': len(data), 'sha256': runtime.sha(data)})
        self.preparation = {'format': 'xmp-owner-local-runtime', 'version': 1, 'mpcOsVersion': '3.10.1',
                            'updaterImageSha256': self.lock['updaterImageSha256'],
                            'rootfsSha256': self.lock['rootfsSha256'], 'files': self.lock['files'],
                            'updaterSignatureVerified': True}
        self.save_preparation()
        (self.owner / 'runtime-receipt.json').write_text('{}')

    def save_preparation(self):
        (self.owner / 'owner-preparation.json').write_text(json.dumps(self.preparation))

    def tearDown(self):
        self.temporary.cleanup()

    def make_image(self, tree, name):
        if not shutil.which('mke2fs'):
            self.skipTest('e2fsprogs mke2fs required for actual ext4 integration')
        image = self.base / name
        with image.open('xb') as stream:
            stream.truncate(32 * 1024**2)
        import os
        result = subprocess.run(['mke2fs', '-q', '-t', 'ext4', '-F', '-b', '4096', '-I', '256', '-m', '0',
                                 '-O', 'extent,^64bit,^has_journal,^orphan_file', '-d', str(tree), str(image)],
                                env={**os.environ, 'MKE2FS_CONFIG': str(ROOT / 'os/live-mk1/mke2fs.conf')},
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        return image

    def test_assembles_exact_files_and_keeps_public_template_unchanged(self):
        digest = runtime.sha(self.template.read_bytes())
        tree = self.base / 'stage with spaces'
        runtime.stage_owner(self.template, self.owner, self.lock, tree)
        image = self.make_image(tree, 'owner.img')
        audit = runtime.audit_owner(image, self.template, self.owner, self.lock)
        self.assertTrue(audit['runtimeLibrariesIncluded'])
        self.assertFalse(audit['abiExecutionTested'])
        self.assertEqual(runtime.sha(self.template.read_bytes()), digest)
        with self.assertRaisesRegex(ValueError, 'Unapproved'):
            runtime.audit_public(image, self.lock)
        with self.assertRaises(FileExistsError):
            runtime.stage_owner(self.template, self.owner, self.lock, tree)

    def test_public_artwork_survives_assembly_and_rejects_corruption(self):
        tree = self.base / 'public-tree'
        for name, data in runtime.image_files(self.template).items():
            target = tree / name.lstrip('/')
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            target.chmod(0o755 if data.startswith(b'\x7fELF') else 0o644)
        artwork = tree / runtime.BOOT_SCREEN.lstrip('/')
        artwork.parent.mkdir(parents=True, exist_ok=True)
        approved = (ROOT / 'os/live-mk1/assets/boot-screen.rgb').read_bytes()
        artwork.write_bytes(approved)
        public = self.make_image(tree, 'public-artwork.img')
        audit = runtime.audit_public(public, self.lock)
        self.assertIn(runtime.BOOT_SCREEN, audit['publicFiles'])
        owner_tree = self.base / 'owner-with-artwork'
        runtime.stage_owner(public, self.owner, self.lock, owner_tree)
        self.assertEqual((owner_tree / runtime.BOOT_SCREEN.lstrip('/')).read_bytes(), approved)
        artwork.write_bytes(approved[:-1] + bytes([approved[-1] ^ 1]))
        with self.assertRaisesRegex(ValueError, 'Boot screen differs'):
            runtime.audit_public(self.make_image(tree, 'bad-artwork.img'), self.lock)

    def test_owner_push_audits_marker_runtime_binary_and_file_allowlist(self):
        tree = self.base / 'push-stage'
        runtime.stage_owner(self.template, self.owner, self.lock, tree)
        boot = tree / 'usr/share/xmp/boot-screen.rgb'
        boot.write_bytes((ROOT / 'os/live-mk1/assets/boot-screen.rgb').read_bytes())
        source_hash = 'c' * 64
        marker = tree / 'etc/xmp-release'
        marker.write_text('XMP MPC Live Mk1; MPC OS 3.10.1; source ' + source_hash + '\n')
        session_hash = runtime.sha(fixture.fake_elf())
        image = self.make_image(tree, 'push.img')
        self.assertEqual(runtime.audit_owner_push(image, self.lock, source_hash, session_hash)['runtimeFilesVerified'], 5)
        boot.write_bytes(b'invalid artwork')
        with self.assertRaisesRegex(ValueError, 'Boot screen'):
            runtime.audit_owner_push(self.make_image(tree, 'bad-boot.img'), self.lock, source_hash, session_hash)
        boot.write_bytes((ROOT / 'os/live-mk1/assets/boot-screen.rgb').read_bytes())
        with self.assertRaisesRegex(ValueError, 'source marker'):
            runtime.audit_owner_push(image, self.lock, 'd' * 64, session_hash)
        with self.assertRaisesRegex(ValueError, 'session binary'):
            runtime.audit_owner_push(image, self.lock, source_hash, 'd' * 64)
        library = tree / 'lib/libc.so.6'
        original = library.read_bytes()
        library.write_bytes(original + b'altered')
        with self.assertRaisesRegex(ValueError, 'runtime mismatch'):
            runtime.audit_owner_push(self.make_image(tree, 'bad-runtime.img'), self.lock, source_hash, session_hash)
        library.write_bytes(original)
        extra = tree / 'usr/lib/xmp/xmp-live-twin'
        extra.write_bytes(fixture.fake_elf())
        extra.chmod(0o755)
        with self.assertRaisesRegex(ValueError, 'Unexpected'):
            runtime.audit_owner_push(self.make_image(tree, 'bad-extra.img'), self.lock, source_hash, session_hash)

    def test_emulator_extras_are_bound_and_never_enter_public_template(self):
        tree = self.base / 'stage'
        runtime.stage_owner(self.template, self.owner, self.lock, tree)
        init, twin = self.base / 'init', self.base / 'twin'
        init.write_bytes(fixture.fake_elf() + b'EMULATOR INIT')
        twin.write_bytes(fixture.fake_elf() + b'EMULATOR TWIN')
        runtime.stage_emulator(tree, init, twin, self.lock)
        image = self.make_image(tree, 'emulator.img')
        audit = runtime.audit_owner(image, self.template, self.owner, self.lock, [init, twin])
        self.assertIn('/usr/lib/xmp/xmp-live-twin', audit['fileHashes'])
        self.assertNotIn('/usr/lib/xmp/xmp-live-twin', runtime.image_files(self.template))
        with self.assertRaisesRegex(ValueError, 'differs'):
            runtime.audit_owner(image, self.template, self.owner, self.lock)

    def test_refuses_changed_runtime_before_staging(self):
        (self.owner / 'lib/libc.so.6').write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'size mismatch|hash mismatch'):
            runtime.stage_owner(self.template, self.owner, self.lock, self.base / 'stage')
        self.assertFalse((self.base / 'stage').exists())

    def test_refuses_wrong_receipt_version_and_updater(self):
        for field, value in [('mpcOsVersion', '3.10.0'), ('updaterImageSha256', 'c' * 64),
                             ('updaterSignatureVerified', False)]:
            original = self.preparation[field]
            self.preparation[field] = value
            self.save_preparation()
            with self.assertRaisesRegex(ValueError, 'pinned'):
                runtime.runtime_files(self.owner, self.lock)
            self.preparation[field] = original

    def test_refuses_extra_files_and_symlinked_runtime(self):
        extra = self.owner / 'extra.bin'
        extra.write_bytes(b'Not part of runtime')
        with self.assertRaisesRegex(ValueError, 'Unexpected'):
            runtime.runtime_files(self.owner, self.lock)
        extra.unlink()
        target = self.owner / 'lib/libc.so.6'
        target.unlink()
        target.symlink_to(self.owner / 'lib/libm.so.6')
        with self.assertRaisesRegex(ValueError, 'symlink'):
            runtime.runtime_files(self.owner, self.lock)

    def test_rejects_missing_or_static_emulator_helpers(self):
        tree = self.base / 'stage'
        runtime.stage_owner(self.template, self.owner, self.lock, tree)
        bad = self.base / 'bad'
        bad.write_bytes(fixture.fake_elf(static=True))
        with self.assertRaisesRegex(ValueError, 'dynamic'):
            runtime.stage_emulator(tree, bad, bad, self.lock)


if __name__ == '__main__':
    unittest.main()
