# CMake toolchain for reviewed downstream C++ session programs.
FROM xmp-live-mk1-probe:1
RUN apt-get update \
 && apt-get install -y --no-install-recommends cmake ninja-build \
 && rm -rf /var/lib/apt/lists/*
