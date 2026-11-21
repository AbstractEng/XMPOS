# Linux build environment for the official az01 kernel. It runs on the Mac
# through Docker. Builds and boots run with no network, no devices and no
# capabilities (see tools/live-mk1/kernel.mjs). Package versions are recorded
# in every build manifest.
FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc
ENV DEBIAN_FRONTEND=noninteractive LC_ALL=C.UTF-8
# Fixed Debian archive state, with normal signed Release/package verification.
# Historical archives need expiry checks disabled; signatures remain required.
RUN rm -f /etc/apt/sources.list /etc/apt/sources.list.d/debian.sources \
 && printf '%s\n' \
      'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20261101T000000Z/ bookworm main' \
      'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/20261101T000000Z/ bookworm-security main' \
      > /etc/apt/sources.list
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bc bison cpio device-tree-compiler flex gcc gcc-arm-linux-gnueabihf \
      kmod libc6-dev libelf-dev libssl-dev make perl python3 \
      qemu-system-arm xz-utils \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /work
