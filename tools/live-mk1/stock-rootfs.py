"""Stream one verified AZ01 rootfs to a new local file or hash; never execute or mount it."""
import contextlib
import hashlib
import json
import lzma
import os
from pathlib import Path
import sys

MAX_ROOTFS = 512 * 1024 * 1024


def extract(image, offset, size, expected, output, limit=MAX_ROOTFS):
    if not 4096 <= limit <= MAX_ROOTFS or offset < 0 or size < 1:
        raise ValueError("Invalid extraction bounds")
    with open(image, "rb") as source:
        source.seek(offset)
        remaining = size
        compressed_hash = hashlib.sha1()
        while remaining:
            block = source.read(min(65536, remaining))
            if not block:
                raise ValueError("Truncated partition")
            compressed_hash.update(block)
            remaining -= len(block)
        if compressed_hash.hexdigest() != expected:
            raise ValueError("Compressed partition hash mismatch")
        source.seek(offset)

        consumed_hash = hashlib.sha1()

        class Partition:
            remaining = size

            def read(self, count=-1):
                count = self.remaining if count < 0 else min(count, self.remaining)
                data = source.read(count)
                self.remaining -= len(data)
                consumed_hash.update(data)
                return data

        digest = hashlib.sha256()
        total = 0
        partition = Partition()
        header = bytearray()
        destination = (contextlib.nullcontext(None) if output == "-" else
                       os.fdopen(os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb"))
        with lzma.LZMAFile(partition) as decoded, destination as dest:
            while True:
                block = decoded.read(65536)
                if not block:
                    break
                total += len(block)
                if total > limit:
                    raise ValueError("Rootfs exceeds extraction bound")
                digest.update(block)
                if len(header) < 1082:
                    header.extend(block[:1082-len(header)])
                if dest is not None:
                    dest.write(block)
        if partition.remaining or consumed_hash.hexdigest() != expected:
            raise ValueError("Partition changed during extraction")
        if total < 4096 or total % 1024:
            raise ValueError("Invalid rootfs size")
        if header[1080:1082] != b"\x53\xef":
            raise ValueError("Expected ext4 root filesystem")
        return {"sha256": digest.hexdigest(), "bytes": total}


if __name__ == "__main__":
    try:
        print(json.dumps(extract(sys.argv[1], int(sys.argv[2]), int(sys.argv[3]),
                                 sys.argv[4], sys.argv[5], int(sys.argv[6]))))
    except Exception as error:
        raise SystemExit(str(error)) from error
