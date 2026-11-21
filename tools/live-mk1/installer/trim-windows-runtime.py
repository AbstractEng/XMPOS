"""Trim a previously built host bundle to tested imports and their PE closure."""
from pathlib import Path
import importlib.util
import json
import hashlib
import subprocess
import shutil
import sys

spec = importlib.util.spec_from_file_location('pe_imports', Path(__file__).with_name('pe-imports.py'))
pe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pe)
base = Path(sys.argv[1]).resolve()
cygbase = '/cygdrive/' + str(base)[0].lower() + '/' + str(base)[3:].replace('\\','/')
code = 'import sys;sys.modules["_hashlib"]=None;import json,lzma,gzip,hashlib,struct,pathlib,plistlib,subprocess,shutil;print(json.dumps(sorted({m.__file__ for m in sys.modules.values() if getattr(m,"__file__","").endswith((".dll",".so",".pyd"))})))'
paths = json.loads(subprocess.check_output([str(base/'bin/python3.12.exe'),'-B','-I','-S','-c',code],text=True))
keep = set()
for name in paths:
    native = Path(subprocess.check_output([str(base/'bin/cygpath.exe'),'-w',name],text=True).strip()).resolve()
    if not native.is_relative_to(base):
        raise ValueError('Native module is outside the portable runtime: '+name)
    keep.add(native.relative_to(base).as_posix())
roots = ['bin/'+n for n in ['python3.12.exe','cygpath.exe','debugfs.exe','e2fsck.exe','dumpe2fs.exe','mke2fs.exe']]
queue = roots + sorted(keep)
available = {p.name.lower():p.relative_to(base).as_posix() for p in (base/'bin').iterdir() if p.is_file()}
system = {'kernel32.dll','advapi32.dll','user32.dll','shell32.dll','ole32.dll','oleaut32.dll','ws2_32.dll','msvcrt.dll','ntdll.dll','bcrypt.dll','secur32.dll','crypt32.dll','iphlpapi.dll','userenv.dll','psapi.dll','shlwapi.dll','version.dll','netapi32.dll','gdi32.dll','rpcrt4.dll'}
imports = {}
for relative in queue:
    if relative in imports:continue
    data = (base/relative).read_bytes()
    deps = pe.imports(data)
    imports[relative] = deps
    for dep in deps:
        if dep in available:
            target = available[dep]
            if target not in imports:queue.append(target)
        elif dep not in system and not dep.startswith(('api-ms-win-','ext-ms-win-')):
            raise ValueError('Unresolved non-system import '+dep+' in '+relative)
keep.update(imports)
removed = []
for p in (base/'bin').iterdir():
    if p.is_file() and p.relative_to(base).as_posix() not in keep:
        removed.append(p.relative_to(base).as_posix());p.unlink()
for p in (base/'lib/python3.12/lib-dynload').iterdir():
    if p.is_file() and p.suffix.lower() in ('.dll','.so','.pyd') and p.relative_to(base).as_posix() not in keep:
        removed.append(p.relative_to(base).as_posix());p.unlink()
site = base/'lib/python3.12/site-packages'
if site.exists():shutil.rmtree(site)
for p in list(base.rglob('__pycache__')):
    if p.is_dir():shutil.rmtree(p)
for p in (base/'lib/python3.12').glob('config-*'):
    if p.is_dir():shutil.rmtree(p)
for name in ['test','tests','idlelib','tkinter','ensurepip','turtledemo']:
    p=base/'lib/python3.12'/name
    if p.exists():shutil.rmtree(p)
receipt={'format':'xmp-windows-runtime-closure','version':1,'nativeModules':paths,'imports':imports,'removed':removed,'files':{p.relative_to(base).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in base.rglob('*') if p.is_file()}}
(base/'source/runtime-closure.json').write_text(json.dumps(receipt,indent=2)+'\n')
subprocess.run([str(base/'bin/python3.12.exe'),'-B','-I','-S','-c',code],check=True)
print(json.dumps({'retainedNativeFiles':len(imports),'removedNativeFiles':len(removed)}))
