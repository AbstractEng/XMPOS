"""Create/verify the exact pinned Zig compiler-runtime source subset; no code execution."""
from pathlib import Path, PurePosixPath
import hashlib
import gzip
import io
import json
import sys
import tarfile

operation, source, output, lock = sys.argv[1:]
expected=json.loads(Path(lock).read_text())['files']
if operation == 'make':
    base=Path(source)
    with open(output,'xb') as raw,gzip.GzipFile(fileobj=raw,mode='wb',mtime=0) as compressed,tarfile.open(fileobj=compressed,mode='w') as tar:
        for name in sorted(expected):
            data=(base/name).read_bytes()
            if hashlib.sha256(data).hexdigest()!=expected[name]:raise ValueError('Changed pinned compiler-runtime source '+name)
            entry=tarfile.TarInfo('zig-0.13.0/'+name);entry.size=len(data);entry.mode=0o644;entry.mtime=0
            tar.addfile(entry,io.BytesIO(data))
elif operation == 'check':
    found={};total=0
    with tarfile.open(source) as tar:
        for member in tar:
            if not member.isfile() or member.size>2*1024**2 or len(found)>4096:raise ValueError('Regular bounded compiler-runtime source required')
            path=PurePosixPath(member.name)
            if path.parts[0]!='zig-0.13.0' or '..' in path.parts:raise ValueError('Unsafe source archive path')
            name=path.relative_to('zig-0.13.0').as_posix()
            if name in found:raise ValueError('Duplicate source archive entry')
            total+=member.size
            if total>32*1024**2:raise ValueError('Source archive exceeds bound')
            found[name]=hashlib.sha256(tar.extractfile(member).read()).hexdigest()
    if found!=expected:raise ValueError('Compiler-runtime source archive differs from pinned file inventory')
else:raise ValueError('Use make or check')
print(json.dumps({'filesVerified':len(expected),'treeSha256':hashlib.sha256(json.dumps(expected,sort_keys=True,separators=(',',':')).encode()).hexdigest()}))
