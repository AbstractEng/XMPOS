"""Download selected official G1 source archives, verify LFS SHA256; never execute them."""
import concurrent.futures
import hashlib
import json
from pathlib import Path
import subprocess
import urllib.parse

ROOT = Path(__file__).resolve().parent.parent
REPO = ROOT / "references/repos/akai-mpc-g1-3.10"
DEST = ROOT / "references/archives/akai-mpc-g1-3.10"
SELECT = {"linux-az01", "alsa-lib", "alsa-utils", "alsa-state", "dtc", "libusb1", "libgpiod", "libubootenv"}

def git(*args):
    return subprocess.check_output(["git", "-c", "core.hooksPath=/dev/null", "-C", str(REPO), *args], text=True).strip()

def fetch(item, commit):
    output = DEST / Path(item["path"]).name
    def digest(path):
        h = hashlib.sha256()
        with path.open("rb") as source:
            for data in iter(lambda: source.read(1024*1024), b""):
                h.update(data)
        return h.hexdigest()
    if output.is_file() and output.stat().st_size == item["size"] and digest(output) == item["sha256"]:
        return {**item, "status": "verified", "localPath": str(output.relative_to(ROOT))}
    url = f'https://media.githubusercontent.com/media/inmusic-software/az0x-open-source/{commit}/{urllib.parse.quote(item["path"], safe="/")}'
    temporary = output.with_suffix(".partial")
    try:
        # Use the platform's certificate store via curl; never disable TLS checks.
        subprocess.run(["curl", "--fail", "--location", "--silent", "--show-error",
                        "--proto", "=https", "--max-time", "120", "--max-filesize", str(item["size"]),
                        "--output", str(temporary), url], check=True)
        if temporary.stat().st_size != item["size"] or digest(temporary) != item["sha256"]:
            raise RuntimeError("Source failed LFS size/hash verification")
        temporary.replace(output)
        print(f'Verified {output.name} ({item["size"] / 1024 / 1024:.1f} MiB)', flush=True)
        return {**item, "status": "verified", "localPath": str(output.relative_to(ROOT))}
    finally:
        temporary.unlink(missing_ok=True)

def main():
    source = json.loads((ROOT / "os/live-mk1/kernel.lock.json").read_text())["source"]
    commit = source["commit"]
    # Fetch only the reviewed source commit; no other reference checkout, LFS
    # filter, firmware, upstream build script or existing branch is needed.
    REPO.mkdir(parents=True, exist_ok=True)
    if not (REPO / ".git").is_dir():
        git("init", "--quiet")
    exists = subprocess.run(["git", "-C", str(REPO), "cat-file", "-e", f"{commit}^{{commit}}"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
    if not exists:
        git("fetch", "--depth=1", source["repository"], commit)
    if git("rev-parse", f"{commit}^{{commit}}") != commit:
        raise RuntimeError("Official source commit does not match kernel lock")
    catalog = []
    for path in git("ls-tree", "-r", "--name-only", commit).splitlines():
        if not path.endswith(".tar.xz"):
            continue
        pointer = git("show", f"{commit}:{path}")
        fields = dict(line.split(" ", 1) for line in pointer.splitlines())
        if fields.get("version") != "https://git-lfs.github.com/spec/v1":
            continue
        package = Path(path).parts[1]
        selected = any(package.startswith(name + "-") for name in SELECT)
        catalog.append({"path": path, "sha256": fields["oid"].removeprefix("sha256:"),
                        "size": int(fields["size"]), "selected": selected})
    DEST.mkdir(parents=True, exist_ok=True)
    selected = [item for item in catalog if item["selected"]]
    print(f'{len(catalog)} official source archives cataloged; downloading {len(selected)} hardware/audio archives', flush=True)
    def attempt(item):
        try:
            return fetch(item, commit)
        except Exception as error:
            return {**item, "status": "failed", "error": str(error)}
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        results = list(pool.map(attempt, selected))
    manifest = {"repository": "https://github.com/inmusic-software/az0x-open-source", "branch": "mpc-g1/3.10",
                "commit": commit, "catalog": catalog, "downloaded": results}
    (ROOT / "references/official-g1-sources.json").write_text(json.dumps(manifest, indent=2) + "\n")
    if any(item["status"] != "verified" for item in results):
        raise SystemExit("Some source archives were unavailable; see references/official-g1-sources.json")

if __name__ == "__main__":
    main()
