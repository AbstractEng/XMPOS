#include "xmp/song_snapshot.hpp"
#include "xmp/wave_export.hpp"
#include <memory>
#include <vector>
#define EXPORT(name) extern "C" __attribute__((export_name(#name)))
namespace {
std::vector<unsigned char> input;
std::unique_ptr<xmp::files::WaveExport> renderer;
xmp::Str error;
}
EXPORT(input_buffer) unsigned char* input_buffer(int bytes) {
  if (bytes < 0 || static_cast<size_t>(bytes) > xmp::project_limits::kSongBytes) return nullptr;
  input.resize(bytes); return input.data();
}
EXPORT(begin) int begin(int size, int song, int scene_size, double tail) {
  renderer.reset();
  if (size < 1 || scene_size < 0 || scene_size > 64 || static_cast<size_t>(size + scene_size) > input.size() || (song != 0 && song != 1)) return 0;
  auto opened = xmp::song_snapshot::open(reinterpret_cast<const char*>(input.data()), size);
  if (!opened.ok) { error = opened.error; return 0; }
  renderer = std::make_unique<xmp::files::WaveExport>();
  const xmp::Str scene(reinterpret_cast<const char*>(input.data() + size), scene_size);
  if (!renderer->begin(opened.project, song, scene, tail)) { error = renderer->error; renderer.reset(); return 0; }
  return 1;
}
EXPORT(next) int next() {
  if (!renderer) return -1;
  const int n = renderer->next(); if (n < 0) error = renderer->error; return n;
}
EXPORT(output) const unsigned char* output() { return renderer ? renderer->bytes : nullptr; }
EXPORT(error_bytes) const char* error_bytes() { return error.c_str(); }
EXPORT(error_size) int error_size() { return error.size(); }
EXPORT(close) void close_renderer() { renderer.reset(); input.clear(); }
