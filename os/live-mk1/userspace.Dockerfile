# Userspace cross-build layer on top of the kernel builder: adds the ARM
# hard-float C library and C++ compiler so G1 programs and the XMP ALSA engine
# can be linked statically.
FROM xmp-live-mk1-builder:1
RUN apt-get update \
 && apt-get install -y --no-install-recommends libc6-dev-armhf-cross g++-arm-linux-gnueabihf pkg-config \
 && rm -rf /var/lib/apt/lists/*
