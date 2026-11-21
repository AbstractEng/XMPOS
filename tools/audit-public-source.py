"""Audit tracked source without printing sensitive matches or opening devices.

Optional private terms are read from a local JSON string list outside the repo.
Keep that file private. Required upstream licence attribution is not personal
project data and must not be removed by this audit.
"""
import argparse
import base64
import io
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import zipfile

RULES = {
    "home-directory": rb"(?:/Users/|/home/)[A-Za-z0-9_.-]+|[A-Z]:\\Users\\[A-Za-z0-9_.-]+",
    "shared-chat-link": rb"https?://(?:chatgpt|chat\.openai)\.com/share/[A-Za-z0-9-]+",
    "session-markers": rb'<\|(?:im_start|im_sep|analysis)\|>|"conversation_id"\s*:|"session_' rb'meta"',
    "private-key": rb"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\r?\n",
    "credential": rb"\b(?:ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{50,}|AKIA[A-Z0-9]{16}|sk-(?:proj-|ant-)[A-Za-z0-9_-]{30,})",
}
FORBIDDEN_PARTS = {".claude", ".codex", ".cursor", "artifacts", "reports", "output", "node_modules", ".venv", "voice-auditions"}
FORBIDDEN_SUFFIXES = {".jsonl", ".har", ".log", ".key", ".pem", ".mp4", ".webm"}


def audit_bytes(name, data, private_terms=(), depth=0):
    if depth > 3 or len(data) > 128 * 1024**2:
        return [{"file": name, "rule": "inspection-bound"}]
    findings = []
    for rule, pattern in RULES.items():
        if re.search(pattern, data):
            findings.append({"file": name, "rule": rule})
    if any(term.lower().encode() in data.lower() for term in private_terms):
        findings.append({"file": name, "rule": "private-term"})
    if name.endswith(".json"):
        try:
            value = json.loads(data)
            def conversation(v):
                if isinstance(v, dict):
                    if v.get("role") in {"user", "assistant", "system"} and "content" in v:
                        return True
                    return any(conversation(x) for x in v.values())
                return isinstance(v, list) and any(conversation(x) for x in v)
            if conversation(value):
                findings.append({"file": name, "rule": "conversation-record"})
        except (UnicodeDecodeError, json.JSONDecodeError):
            pass
    for match in re.finditer(rb'BASE64\s*=\s*["`]([A-Za-z0-9+/=\s]+)["`]', data):
        try:
            decoded = base64.b64decode(match[1], validate=False)
            findings.extend(audit_bytes(name + "#decoded", decoded, private_terms, depth + 1))
        except ValueError:
            findings.append({"file": name, "rule": "unreadable-embedded-data"})
    if zipfile.is_zipfile(io.BytesIO(data)):
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            if len(archive.infolist()) > 4096:
                return findings + [{"file": name, "rule": "archive-bound"}]
            total = 0
            for item in archive.infolist():
                if item.is_dir():
                    continue
                total += item.file_size
                path = PurePosixPath(item.filename)
                if path.is_absolute() or ".." in path.parts or total > 128 * 1024**2:
                    findings.append({"file": name, "rule": "archive-bound"})
                    break
                findings.extend(audit_bytes(name + "#" + item.filename, archive.read(item), private_terms, depth + 1))
    return findings


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--private-terms-file", type=Path)
    args = parser.parse_args()
    terms = json.loads(args.private_terms_file.read_text()) if args.private_terms_file else []
    if not isinstance(terms, list) or any(not isinstance(x, str) or not x for x in terms):
        raise SystemExit("Private terms must be a JSON list of nonempty strings")
    paths = subprocess.check_output(["git", "ls-files", "-z"]).decode().split("\0")
    findings = []
    inspected = 0
    for name in filter(None, paths):
        p = Path(name)
        inspected += 1
        if p.is_symlink() or not p.is_file():
            findings.append({"file": name, "rule": "regular-file-required"})
            continue
        if set(p.parts) & FORBIDDEN_PARTS or p.suffix.lower() in FORBIDDEN_SUFFIXES or p.name.startswith(".env") and p.name != ".env.example":
            findings.append({"file": name, "rule": "excluded-path"})
        findings.extend(audit_bytes(name, p.read_bytes(), terms))
    print(json.dumps({"files": inspected, "findings": findings, "thirdPartyAttributionPreserved": True}, indent=2))
    raise SystemExit(bool(findings))


if __name__ == "__main__":
    main()
