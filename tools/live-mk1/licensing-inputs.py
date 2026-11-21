"""Fetch/verify the exact public Debian source inputs; never execute package code."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]


def inputs(fetch=False):
    lock = json.loads((ROOT / 'os/live-mk1/host-source.lock.json').read_text())
    base = ROOT / 'references/archives/armhf-sources'
    base.mkdir(parents=True, exist_ok=True)
    result = []
    for row in lock['files']:
        name = row['name']
        if Path(name).name != name or not 0 < row['bytes'] <= 128 * 1024**2:
            raise ValueError('Invalid pinned source file')
        path = base / name
        if fetch and not path.exists():
            partial = path.with_suffix(path.suffix + '.partial')
            subprocess.run(['curl', '-fLsS', '--max-time', '180', '--max-filesize', str(row['bytes']), row['url'], '-o', str(partial)], check=True)
            with partial.open('rb') as stream: actual = hashlib.file_digest(stream, 'sha256').hexdigest()
            if partial.stat().st_size != row['bytes'] or actual != row['sha256']:
                partial.unlink(); raise ValueError('Source download mismatch: ' + name)
            partial.rename(path)
        if not path.is_file() or path.is_symlink() or path.stat().st_size != row['bytes']:
            raise ValueError('Missing/invalid source input: ' + name)
        with path.open('rb') as stream: actual = hashlib.file_digest(stream, 'sha256').hexdigest()
        if actual != row['sha256']: raise ValueError('Changed source input: ' + name)
        result.append({**row, 'path': str(path)})
    return result


if __name__ == '__main__':
    if sys.argv[1:] not in ([], ['--fetch']): raise SystemExit('Usage: python3 tools/live-mk1/licensing-inputs.py [--fetch]')
    print(json.dumps(inputs('--fetch' in sys.argv)))
