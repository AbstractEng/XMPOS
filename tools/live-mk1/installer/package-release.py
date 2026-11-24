"""Package a verified installer tree with neutral ZIP ownership metadata."""
import os
from pathlib import Path
import stat
import sys
import zipfile

root = Path(sys.argv[1]).resolve()
output = Path(sys.argv[2])
if not root.is_dir() or output.exists() or output.resolve().is_relative_to(root):
    raise ValueError("New ZIP destination outside the installer tree required")
with zipfile.ZipFile(output, "x", zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
    for directory, dirs, names in os.walk(root, followlinks=False):
        for name in sorted(dirs + names):
            path = Path(directory) / name
            if name in {".DS_Store", "__MACOSX"}:
                continue
            mode = path.lstat().st_mode
            if stat.S_ISDIR(mode):
                continue
            relative = path.relative_to(root).as_posix()
            entry = zipfile.ZipInfo(relative, date_time=(2026, 1, 1, 0, 0, 0))
            entry.create_system = 3
            entry.external_attr = (stat.S_IFLNK | 0o777 if stat.S_ISLNK(mode) else stat.S_IFREG | (0o755 if mode & 0o111 else 0o644)) << 16
            entry.compress_type = zipfile.ZIP_DEFLATED
            if stat.S_ISLNK(mode):
                target = os.readlink(path)
                if os.path.isabs(target) or not (path.parent / target).resolve().is_relative_to(root):
                    raise ValueError("Installer link must stay inside its tree")
                archive.writestr(entry, target.encode())
            elif stat.S_ISREG(mode):
                with path.open("rb") as source, archive.open(entry, "w", force_zip64=True) as dest:
                    while chunk := source.read(1024 * 1024):
                        dest.write(chunk)
            else:
                raise ValueError("Only regular files and internal links can be packaged")
