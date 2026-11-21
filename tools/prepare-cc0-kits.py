"""Fetch only the pinned, explicitly approved CC0 sounds; never run upstream code.

Requires curl and ffmpeg. Committed prepared WAVs make normal builds/tests offline.
"""
import array
import concurrent.futures
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import urllib.parse
import wave

ROOT = Path(__file__).resolve().parent.parent
RECIPE = json.loads((ROOT / "references/drum-kits.json").read_text())
ARCHIVE = ROOT / "references/archives/cc0-kits"
PUBLIC = ROOT / "apps/studio/public/kits"


def fetch(source_key, item):
    source = RECIPE["sources"][source_key]
    path = item["path"]
    if ".." in Path(path).parts or Path(path).is_absolute():
        raise ValueError("Invalid source path")
    url = f'https://raw.githubusercontent.com/{source["repo"]}/{source["commit"]}/{urllib.parse.quote(path)}'
    dest = ARCHIVE / source_key / path
    dest.parent.mkdir(parents=True, exist_ok=True)
    if not dest.exists():
        subprocess.run(["curl", "-fsSL", "--max-time", "45", "--max-filesize", "8388608", url, "-o", str(dest)], check=True)
    data = dest.read_bytes()
    blob = hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
    if len(data) != item["bytes"] or blob != item["gitBlob"]:
        raise ValueError(f"Pinned Git blob mismatch: {path}")
    return dest, url, hashlib.sha256(data).hexdigest()


def prepare():
    PUBLIC.mkdir(parents=True, exist_ok=True)
    for key, source in RECIPE["sources"].items():
        for notice in source["notices"]:
            local, _, _ = fetch(key, notice)
            dest = PUBLIC / "licenses" / key / notice["path"]
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(local, dest)
        if b"CC0 1.0 Universal" not in (PUBLIC / "licenses" / key / "LICENSE").read_bytes():
            raise ValueError(f"Expected CC0 license for {key}")
    requests = {(s["source"], s["path"]): s for kit in RECIPE["kits"] for s in kit["samples"]}
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        fetched = dict(zip(requests, pool.map(lambda key: fetch(key[0], requests[key]), requests)))
    catalog = {"version": 1, "kits": []}
    for kit in RECIPE["kits"]:
        result = {key: kit[key] for key in ["id", "name", "description"]}
        result["license"] = "CC0-1.0"
        result["credits"] = sorted({RECIPE["sources"][s["source"]]["credit"] for s in kit["samples"]})
        result["licensePaths"] = sorted({f'kits/licenses/{s["source"]}/LICENSE' for s in kit["samples"]})
        result["files"] = []
        for sample in kit["samples"]:
            local, url, source_hash = fetched[(sample["source"], sample["path"])]
            slug = re.sub(r"[^a-z0-9]+", "-", sample["name"].lower()).strip("-")
            relative = f'kits/cc0/{kit["id"]}/{slug}.wav'
            dest = PUBLIC.parent / relative
            dest.parent.mkdir(parents=True, exist_ok=True)
            processing = "Unmodified source WAV; renamed only."
            if sample["source"] == "octal":
                shutil.copyfile(local, dest)
            else:
                intermediate = ARCHIVE / "converted" / f"{slug}.wav"
                intermediate.parent.mkdir(parents=True, exist_ok=True)
                subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", str(local), "-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le", str(intermediate)], check=True, timeout=30)
                with wave.open(str(intermediate), "rb") as src:
                    count = src.getnframes()
                    pcm = array.array("h", src.readframes(min(count, 72000)))
                if sys.byteorder != "little":
                    pcm.byteswap()
                if count > 72000:
                    for i in range(480):
                        pcm[-480 + i] = round(pcm[-480 + i] * (479 - i) / 480)
                if sys.byteorder != "little":
                    pcm.byteswap()
                with wave.open(str(dest), "wb") as out:
                    out.setparams((1, 2, 24000, 0, "NONE", "not compressed"))
                    out.writeframes(pcm.tobytes())
                processing = "Decoded FLAC; downmixed to mono PCM16 at 24000 Hz."
                if count > 72000:
                    processing += " Tail capped at 3 s with a 20 ms fade."
            with wave.open(str(dest), "rb") as audio:
                rate, frames = audio.getframerate(), audio.getnframes()
            data = dest.read_bytes()
            result["files"].append({"name": sample["name"], "path": relative,
                "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(),
                "sampleRate": rate, "frames": frames, "sourceUrl": url,
                "sourceSha256": source_hash, "sourceGitBlob": sample["gitBlob"],
                "processing": processing})
        result["totalFrames"] = sum(f["frames"] for f in result["files"])
        if result["totalFrames"] + 1 > 1000000:
            raise ValueError("Kit exceeds the current project frame budget")
        catalog["kits"].append(result)
        print(f'{result["name"]}: {len(result["files"])} sounds, {result["totalFrames"]} frames')
    (PUBLIC / "catalog.json").write_text(json.dumps(catalog, indent=2) + "\n")


if __name__ == "__main__":
    prepare()
