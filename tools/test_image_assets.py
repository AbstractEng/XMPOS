"""Regression coverage for the complete guest application bundle, with no devices."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("xmp_build_image", Path(__file__).parent / "os/build-image.py")
image = importlib.util.module_from_spec(spec)
spec.loader.exec_module(image)

class ApplicationAssetsTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.previous_root = image.ROOT
        image.ROOT = Path(self.temporary.name).resolve()
        self.app = image.ROOT / "build/app/guest.mjs"
        self.app.parent.mkdir(parents=True)
        self.app.write_text('import "./assets/core.js";')
        self.assets = self.app.parent / "assets"
        self.assets.mkdir()
        (self.assets / "core.js").write_text("export const ready = true;")

    def tearDown(self):
        image.ROOT = self.previous_root
        self.temporary.cleanup()

    def test_entry_and_runtime_chunks_are_delivered_and_hashed(self):
        files = image.application_files(self.app)
        self.assertEqual(set(files), {"guest.mjs", "assets/core.js"})
        self.assertIn(b"ready", files["assets/core.js"])
        before = image.digest(files["assets/core.js"])
        (self.assets / "core.js").write_text("export const ready = false;")
        self.assertNotEqual(before, image.digest(image.application_files(self.app)["assets/core.js"]))

    def test_symlink_asset_is_refused(self):
        (self.assets / "link.js").symlink_to(self.app)
        with self.assertRaisesRegex(ValueError, "Symlink"):
            image.application_files(self.app)

    def test_excessive_generated_file_count_is_refused(self):
        for i in range(256):
            (self.assets / f"chunk-{i}.js").write_text("")
        with self.assertRaisesRegex(ValueError, "Bounded application bundle"):
            image.application_files(self.app)

if __name__ == "__main__":
    unittest.main()
