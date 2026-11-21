"""Public source archives must not expose the build host account in headers."""
import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import json
import hashlib

spec = importlib.util.spec_from_file_location("source_review", Path(__file__).parent / "live-mk1/source-review.py")
review = importlib.util.module_from_spec(spec)
spec.loader.exec_module(review)


class PublicSourceMetadataTest(unittest.TestCase):
    def test_owner_and_extended_metadata_are_removed(self):
        entry = tarfile.TarInfo("source.c")
        entry.uid, entry.gid = 1234, 5678
        entry.uname, entry.gname = "private-builder", "private-group"
        entry.pax_headers = {"uname": "private-builder", "atime": "123", "SCHILY.xattr.owner": "private-builder"}
        entry.mode = 0o755
        sanitized = review.public_source_metadata(entry)
        self.assertEqual((sanitized.uid, sanitized.gid, sanitized.uname, sanitized.gname, sanitized.mtime), (0, 0, "", "", 0))
        self.assertEqual(sanitized.pax_headers, {})
        self.assertEqual(sanitized.mode, 0o755)

    def test_paths_with_spaces_and_make_escaping_are_normalized(self):
        prefix = "/private/build owner/runtime"
        escaped = prefix.replace(" ", "\\ ")
        payload = (prefix + "/lib/libc.so.6\n" + escaped + "/include/header.h\n").encode()
        result = review.normalize_build_text(payload, [(prefix, "$XMP_RUNTIME")])
        self.assertEqual(result, b"$XMP_RUNTIME/lib/libc.so.6\n$XMP_RUNTIME/include/header.h\n")

    def test_factory_sources_are_verified_and_modified_audio_is_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            public = root / "apps/studio/public"
            (public / "kits/cc0/example").mkdir(parents=True)
            (public / "kits/licenses/example").mkdir(parents=True)
            sample = public / "kits/cc0/example/drum.wav"
            sample.write_bytes(b"original wave")
            (public / "kits/licenses/example/LICENSE").write_text("CC0-1.0")
            catalog = {"kits": [{"license": "CC0-1.0", "licensePaths": ["kits/licenses/example/LICENSE"], "files": [{"path": "kits/cc0/example/drum.wav", "bytes": sample.stat().st_size, "sha256": hashlib.sha256(sample.read_bytes()).hexdigest(), "sourceUrl": "https://example.invalid/source.wav", "processing": "Unmodified"}]}]}
            (public / "kits/catalog.json").write_text(json.dumps(catalog))
            with patch.object(review, "ROOT", root):
                self.assertEqual(review.factory_content_review()["selectedFiles"], 1)
                sample.write_bytes(b"modified wave")
                with self.assertRaisesRegex(ValueError, "Changed or unreviewed"):
                    review.factory_content_review()

    def test_unreviewed_factory_licence_is_refused_before_file_access(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            public = root / "apps/studio/public/kits"
            public.mkdir(parents=True)
            (public / "catalog.json").write_text(json.dumps({"kits": [{"license": "unreviewed"}]}))
            with patch.object(review, "ROOT", root):
                with self.assertRaisesRegex(ValueError, "Unreviewed factory content licence"):
                    review.factory_content_review()

    def test_archive_round_trip_preserves_source_without_host_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "original.c"
            source.write_bytes(b"int main(void) { return 0; }\n")
            output = io.BytesIO()
            with tarfile.open(fileobj=output, mode="w:gz") as archive:
                archive.add(source, arcname="sources/original.c", recursive=False, filter=review.public_source_metadata)
            output.seek(0)
            with tarfile.open(fileobj=output, mode="r:gz") as archive:
                member = archive.getmember("sources/original.c")
                self.assertEqual((member.uid, member.gid, member.uname, member.gname), (0, 0, "", ""))
                self.assertEqual(archive.extractfile(member).read(), source.read_bytes())


if __name__ == "__main__":
    unittest.main()
