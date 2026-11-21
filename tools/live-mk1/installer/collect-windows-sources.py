"""Collect exact Cygwin source packages for the retained runtime file inventory.

Run with build-host Python, not the trimmed installer Python. All downloads
are checked against the selected upstream setup metadata; no archive is run.
"""
from pathlib import Path, PurePosixPath
import hashlib
import io
import json
import lzma
import re
import tarfile
import sys
import urllib.request

base = Path(sys.argv[1]).resolve()
out = base/'source/cygwin-sources'
out.mkdir(parents=True, exist_ok=True)
mirror = 'https://mirrors.kernel.org/sourceware/cygwin/'
metadata = urllib.request.urlopen(mirror+'x86_64/setup.xz', timeout=60).read()
(base/'source/setup.xz').write_bytes(metadata)
records = {}
package = None
current = None
for line in lzma.decompress(metadata).decode().splitlines():
    if line.startswith('@ '):
        package=line[2:];records[package]=[];current=None
    elif line.startswith('version: ') and package:
        current={'version':line[9:]};records[package].append(current)
    elif current is not None and line.startswith(('install: ','source: ')):
        key,value=line.split(': ',1);path,size,digest=value.split()
        current[key]={'path':path,'bytes':int(size),'sha512':digest}
installed = {}
for line in (base/'source/installed-packages.txt').read_text().splitlines()[2:]:
    parts=line.split()
    if len(parts)==2:installed[parts[0]]=parts[1]
closure=json.loads((base/'source/runtime-closure.json').read_text())
original={'bin/'+n for n in ['debugfs.exe','e2fsck.exe','dumpe2fs.exe','mke2fs.exe']}
needed=set(closure['imports'])-original
owners={}
notices=[]
source_pins={}
# Explicit candidates; actual package archive contents must establish every
# native file's ownership. A filename guess alone never clears a component.
candidates=['cygwin','python312','libgcc1','libintl8','libiconv2','libblkid1','libuuid1','zlib0','liblzma5','libexpat1','libcrypt2','libbz2_1','libffi8','libsqlite3_0','libreadline8','libncursesw10']

def download(pin, folder):
    name=PurePosixPath(pin['path']).name
    target=folder/name
    if not target.exists():
        with urllib.request.urlopen(mirror+pin['path'],timeout=120) as response, target.open('wb') as f:
            size=0
            while data:=response.read(1024**2):
                size+=len(data)
                if size>pin['bytes']:raise ValueError('Oversized upstream package '+name)
                f.write(data)
    data=target.read_bytes()
    if len(data)!=pin['bytes'] or hashlib.sha512(data).hexdigest()!=pin['sha512']:
        raise ValueError('Changed upstream package '+name)
    return target

binary_cache=out/'binary-audit-inputs'
binary_cache.mkdir(exist_ok=True)
for name in candidates:
    if name not in installed:continue
    matches=[r for r in records.get(name,[]) if r['version']==installed[name]]
    if len(matches)!=1:raise ValueError('Exact installed package is unavailable: '+name+' '+installed[name])
    record=matches[0]
    print('Attributing '+name+' '+record['version'],flush=True)
    archive=download(record['install'],binary_cache)
    hits={}
    with tarfile.open(archive) as tar:
        for member in tar:
            path=member.name.removeprefix('./').removeprefix('usr/')
            if path in needed:
                hits[path]={'package':name,'version':record['version'],'source':record['source'],'binaryPackage':record['install']}
            if member.isfile() and re.search(r'(?:^|/)(?:COPYING[^/]*|LICENSE[^/]*|copyright)$',member.name,re.I) and member.size<=512*1024:
                notices.append((name+': '+member.name,tar.extractfile(member).read().decode(errors='replace')))
    if hits:
        owners.update(hits)
        pin=record['source'];source_pins[pin['path']]=pin
    archive.unlink()
missing=sorted(needed-owners.keys())
if missing:raise ValueError('Unattributed runtime native files: '+str(missing))
# Include the matching Windows API headers used to rebuild the patched tools.
for name in ['w32api-headers','cygwin-devel']:
    match=[r for r in records.get(name,[]) if r['version']==installed[name]]
    if len(match)!=1:raise ValueError('Missing build header source '+name)
    pin=match[0]['source'];source_pins[pin['path']]=pin

def licenses(tar, label, depth=0):
    count=0
    for member in tar:
        count+=1
        if count>300000:raise ValueError('Unbounded source archive')
        if not member.isfile():continue
        if re.search(r'(?:^|/)(?:COPYING[^/]*|LICENSE[^/]*|copyright)$',member.name,re.I) and member.size<=512*1024:
            text=tar.extractfile(member).read().decode(errors='replace')
            if text.strip() and text not in [n[1] for n in notices]:notices.append((label+': '+member.name,text))
        elif depth<1 and re.search(r'\.(?:tar\.(?:xz|gz|bz2)|tgz)$',member.name) and member.size<=256*1024**2:
            with tarfile.open(fileobj=io.BytesIO(tar.extractfile(member).read())) as nested:
                licenses(nested,label+'/'+member.name,depth+1)

for pin in source_pins.values():
    print('Collecting '+pin['path'],flush=True)
    archive=download(pin,out)
    with tarfile.open(archive) as tar:licenses(tar,archive.name)
notice='Windows installer retained host runtime — exact source and licence inventory\n\n'
notice+='The complete source packages below, including Cygwin patches and build recipes, accompany the binaries. Windows system DLLs are OS-provided and are not bundled. Original XMP process code is separate from these host utilities.\n\n'
for label,text in notices:notice+='\n===== '+label+' =====\n'+text+'\n'
(base/'source/WINDOWS-THIRD-PARTY-NOTICES.txt').write_text(notice,encoding='utf-8',newline='')
lock={'format':'xmp-cygwin-corresponding-source','version':1,'setupSha256':hashlib.sha256(metadata).hexdigest(),'mirror':mirror,'nativeFileOwners':owners,'sourcePackages':list(source_pins.values()),'noticeSha256':hashlib.sha256(notice.encode()).hexdigest(),'unattributedNativeFiles':[]}
(base/'source/cygwin-sources.lock.json').write_text(json.dumps(lock,indent=2)+'\n',encoding='utf-8',newline='')
binary_cache.rmdir()
print(json.dumps({'nativeFilesAttributed':len(owners),'sourcePackages':len(source_pins),'licenceTexts':len(notices)}))
