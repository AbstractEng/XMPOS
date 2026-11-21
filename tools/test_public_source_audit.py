import base64
import importlib.util
import io
import json
from pathlib import Path
import unittest
import zipfile

spec = importlib.util.spec_from_file_location("public_audit", Path(__file__).with_name("audit-public-source.py"))
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


class PublicSourceAudit(unittest.TestCase):
    def rules(self, name, data, terms=()):
        return [x["rule"] for x in audit.audit_bytes(name, data, terms)]

    def test_detects_chat_links_and_structured_messages(self):
        link = ("https://" + "chatgpt.com" + "/share/" + "example").encode()
        self.assertIn("shared-chat-link", self.rules("notes.md", link))
        data = json.dumps([dict(role="user", content="example")]).encode()
        self.assertIn("conversation-record", self.rules("chat.json", data))

    def test_scans_compiled_embedded_data(self):
        payload = ("/Users/" + "fixture/project").encode()
        source = b'export const MODULE_BASE64 = "' + base64.b64encode(payload) + b'";'
        self.assertIn("home-directory", self.rules("module.ts", source))

    def test_scans_archive_contents_and_rejects_parent_paths(self):
        data = io.BytesIO()
        with zipfile.ZipFile(data, "w") as archive:
            archive.writestr("safe.json", json.dumps(dict(name="Example Fixture")))
            archive.writestr("../bad", "example")
        self.assertIn("private-term", self.rules("kit.zip", data.getvalue(), ["Example Fixture"]))
        self.assertIn("archive-bound", self.rules("kit.zip", data.getvalue()))

    def test_preserves_ordinary_licence_attribution_and_requirements(self):
        self.assertEqual(self.rules("LICENSE", b"Copyright Example Upstream <author@example.org>\nMIT"), [])
        self.assertEqual(self.rules("requirements.txt", b"S1 Extensible instruments and workflows"), [])


if __name__ == "__main__":
    unittest.main()
