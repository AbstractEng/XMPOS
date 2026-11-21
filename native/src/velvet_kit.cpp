// Writes XMP Velvet (native/include/xmp/velvet_kit.hpp) as an .xmpkit file.
//   xmp_velvet_kit <out.xmpkit>
#include <cstdio>

#include "xmp/velvet_kit.hpp"

int main(int argc, char** argv) {
  if (argc != 2) {
    std::fprintf(stderr, "usage: xmp_velvet_kit <out.xmpkit>\n");
    return 2;
  }
  const auto kit = xmp::kits::velvet::make();
  std::size_t frames = 0, takes = 0;
  for (const auto& sound : kit)
    for (const auto& layer : sound.layers)
      for (const auto& take : layer.takes) frames += take.pcm.size(), ++takes;
  const auto text = xmp::kits::velvet::to_json(kit);
  std::FILE* out = std::fopen(argv[1], "wb");
  if (!out || std::fwrite(text.data(), 1, text.size(), out) != text.size() || std::fclose(out) != 0) {
    std::fprintf(stderr, "could not write %s\n", argv[1]);
    return 1;
  }
  std::printf("%s: %zu sounds, %zu takes, %zu frames, %zu bytes\n", argv[1], kit.size(), takes, frames, text.size());
  return 0;
}
