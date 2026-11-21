#pragma once
#include "xmp/json.hpp"
namespace xmp::project_limits {
constexpr int32_t kSampleFrames = 480000, kTotalFrames = 2000000;
constexpr int32_t kLoopSampleFrames = 1536000, kLoopTotalFrames = 8000000;
constexpr size_t kProjectBytes = 24 * 1024 * 1024, kSongBytes = 96 * 1024 * 1024;
inline bool extended(const json::Value& project) {
  const auto* extensions = project.get("extensions");
  const auto* e = extensions && extensions->is_object() ? extensions->get("xmp.extended-samples") : nullptr;
  if (!e || !e->is_object()) return false;
  const auto *version = e->get("version"), *required = e->get("required"), *data = e->get("data");
  return version && version->is_number() && version->as_number() == 1 && required && required->is_bool() &&
         required->as_bool() && data && data->is_object() && data->members().empty();
}
inline int32_t sample_frames(const json::Value& p) { return extended(p) ? kLoopSampleFrames : kSampleFrames; }
inline int32_t total_frames(const json::Value& p) { return extended(p) ? kLoopTotalFrames : kTotalFrames; }
inline bool prepare_samples(json::Value& project, Str& error) {
  int64_t total = 0, largest = 0;
  const auto* samples = project.get("samples");
  if (!samples || !samples->is_array()) return error = "Invalid sample pool", false;
  for (const auto& sample : samples->items()) {
    const auto* pcm = sample.get("pcm");
    if (!pcm || !pcm->is_array()) return error = "Invalid sample asset", false;
    total += pcm->items().size();
    if (pcm->items().size() > largest) largest = pcm->items().size();
  }
  if (total > kLoopTotalFrames || largest > kLoopSampleFrames) return error = "Sampler memory budget exceeded", false;
  if (total <= kTotalFrames && largest <= kSampleFrames) return true;
  auto* extensions = project.get("extensions");
  if (!extensions) {
    project.set("extensions", json::Value::new_object());
    extensions = project.get("extensions");
  }
  if (const auto* existing = extensions->get("xmp.extended-samples")) {
    const auto* version = existing->get("version"), *data = existing->get("data");
    if (!version || !version->is_number() || version->as_number() != 1 || !data || !data->is_object() || !data->members().empty())
      return error = "A newer sample profile must be preserved; use a supporting XMP build", false;
  }
  json::Value entry = json::Value::new_object();
  entry.set("version", json::Value::of(1.0)), entry.set("required", json::Value::of(true));
  entry.set("data", json::Value::new_object()), extensions->set("xmp.extended-samples", entry);
  return true;
}
}  // namespace xmp::project_limits
