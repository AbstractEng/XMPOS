# Probe image assembly layer: edits a copy of an ext4 root filesystem offline
# (debugfs; nothing is mounted), builds U-Boot script and ramdisk images, and
# creates FAT test media. Runs with no network, capabilities or devices.
FROM xmp-live-mk1-userspace:1
RUN apt-get update \
 && apt-get install -y --no-install-recommends e2fsprogs u-boot-tools dosfstools mtools \
 && rm -rf /var/lib/apt/lists/*
