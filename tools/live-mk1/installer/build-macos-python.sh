#!/bin/sh
# Build only the installer runtime, using macOS system zlib/liblzma.
# Complete, unchanged CPython source is included with the resulting runtime.
set -eu
export MACOSX_DEPLOYMENT_TARGET=12.0
mkdir -p mac-python-work mac-python-runtime/python/bin mac-python-runtime/python/lib/python3.13/lib-dynload mac-python-runtime/source mac-python-runtime/licenses
# SDKs no longer consistently ship lzma.h. Use pinned upstream public API
# headers; the linked liblzma remains the macOS system library.
xmp_lzma_headers="$(pwd)/mac-python-work/xz-5.8.4/src/liblzma/api"
curl -fLsS --max-time 180 https://github.com/tukaani-project/xz/releases/download/v5.8.4/xz-5.8.4.tar.xz -o mac-python-work/xz-5.8.4.tar.xz
printf '%s\n' '4ce24038fd4221e0d13bc1a2de7a4db56e90b92b3bf75321f6c14be73f65de4b  mac-python-work/xz-5.8.4.tar.xz' | shasum -a 256 -c -
cp mac-python-work/xz-5.8.4.tar.xz mac-python-runtime/source/
tar -xf mac-python-work/xz-5.8.4.tar.xz -C mac-python-work
cp mac-python-work/xz-5.8.4/COPYING.0BSD mac-python-runtime/licenses/xz-headers-0BSD.txt
curl -fLsS --max-time 180 https://www.python.org/ftp/python/3.13.18/Python-3.13.18.tar.xz -o mac-python-work/Python-3.13.18.tar.xz
printf '%s\n' 'abb0102e6d4ae027509bcb82327d9dd85515b44a3ba8ad538cfc5e9847029f68  mac-python-work/Python-3.13.18.tar.xz' | shasum -a 256 -c -
cp mac-python-work/Python-3.13.18.tar.xz mac-python-runtime/source/
tar -xf mac-python-work/Python-3.13.18.tar.xz -C mac-python-work
cd mac-python-work/Python-3.13.18
cat > Modules/Setup.local <<'DISABLED'
*disabled*
_ssl
_hashlib
_sqlite3
_dbm
_gdbm
_ctypes
_decimal
readline
_curses
_curses_panel
_tkinter
_bz2
_uuid
DISABLED
SDK=$(/usr/bin/xcrun --show-sdk-path)
export ac_cv_header_libintl_h=no ac_cv_lib_intl_textdomain=no
export LIBLZMA_CFLAGS="-I$xmp_lzma_headers" LIBLZMA_LIBS="$SDK/usr/lib/liblzma.tbd"
export ZLIB_CFLAGS="-isystem $SDK/usr/include" ZLIB_LIBS="$SDK/usr/lib/libz.tbd"
./configure --prefix=/opt/xmp-python --without-ensurepip --without-readline --without-static-libpython --disable-test-modules --with-pkg-config=no > ../../mac-python-runtime/source/configure.log 2>&1
make -j4 > ../../mac-python-runtime/source/make.log 2>&1
cp Modules/Setup.local ../../mac-python-runtime/source/
./python.exe -I -B -S - <<'PY'
from pathlib import Path
import shutil, json, hashlib, subprocess
out = Path('../../mac-python-runtime').resolve()
shutil.copy2('python.exe', out/'python/bin/python3.13')
shutil.copytree('Lib',out/'python/lib/python3.13',dirs_exist_ok=True,
    ignore=shutil.ignore_patterns('test','tests','__pycache__','*.pyc','ensurepip','idlelib','tkinter','turtledemo','_pyrepl'))
for p in Path('build').glob('lib.*/*.so'):
    shutil.copy2(p,out/'python/lib/python3.13/lib-dynload'/p.name)
for path in ['LICENSE','Doc/license.rst','Modules/expat/COPYING']:
    shutil.copy2(path,out/'licenses'/Path(path).name)
headers = []
for p in sorted(Path('Modules/_hacl').rglob('*.c')):
    s=p.read_text(); start=s.find('/*'); end=s.find('*/',start)
    if start>=0 and end>=0:
        block=s[start:end+2]
        if ('Copyright' in block or 'License' in block) and block not in headers:headers.append(block)
(out/'licenses/HACL.txt').write_text('\n\n'.join(headers)+'\n')
for p in [out/'python/bin/python3.13',*list((out/'python/lib/python3.13/lib-dynload').glob('*.so'))]:
    links=subprocess.check_output(['/usr/bin/otool','-L',str(p)],text=True).splitlines()[1:]
    if any(not line.strip().startswith(('/usr/lib/','/System/Library/')) for line in links):
        raise RuntimeError('Non-system linked library: '+str(p))
receipt={'format':'xmp-minimal-python','version':1,'pythonVersion':'3.13.18','sourceSha256':hashlib.sha256((out/'source/Python-3.13.18.tar.xz').read_bytes()).hexdigest(),'systemLibrariesOnly':True,'deploymentTarget':'12.0','disabledModules':Path('Modules/Setup.local').read_text(),'files':{p.relative_to(out).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in out.rglob('*') if p.is_file()}}
(out/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
PY
cd ../..
mac-python-runtime/python/bin/python3.13 -I -B -S -c 'import json,lzma,gzip,hashlib,struct,pathlib,plistlib,subprocess,shutil,importlib.util;assert hashlib.sha256(b"abc").hexdigest()=="ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";assert importlib.util.find_spec("_ssl") is None;assert importlib.util.find_spec("_hashlib") is None;assert lzma.decompress(lzma.compress(b"owner-local test"))==b"owner-local test";print("Minimal relocatable Python and bounded installer imports passed")'
