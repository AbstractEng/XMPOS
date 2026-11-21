#pragma once
// Shared codec for the Live's whole song plus its optional referenced autosave.
// No filesystem or device access: host, ARM and Wasm use these exact bytes.
#include "xmp/portable.hpp"

namespace xmp::song_snapshot {
constexpr const char* kEditsHead = "xmp-edits 1 ";
constexpr size_t kMaxEditsBytes = project_limits::kSongBytes + 128;

inline Str identity(const char* text, size_t size) {
  uint64_t h = 1469598103934665603ULL;
  for (size_t i = 0; i < size; ++i) h = (h ^ static_cast<uint8_t>(text[i])) * 1099511628211ULL;
  char out[48];
  snprintf(out, sizeof out, "%zu-%016llx", size, static_cast<unsigned long long>(h));
  return Str(out);
}

struct Opened {
  bool ok = false, edits_applied = false, stale_edits = false;
  json::Value project;
  Str error;
};

inline Opened open(const char* base, size_t size, const char* edits = "", size_t edits_size = 0) {
  Opened result;
  const auto whole = portable::open(base, size);
  if (!whole.ok) { result.error = whole.error; return result; }
  result.project = whole.project;
  if (edits_size) {
    if (edits_size > kMaxEditsBytes) { result.error = "Song edits exceed import budget"; return result; }
    const Str body(edits, edits_size), prefix(kEditsHead);
    if (!body.starts_with(prefix)) {
      result.error = body.starts_with("xmp-edits ") ? "Unsupported song edits version; use a compatible XMP release" :
                                                     "Invalid song edits header; saved files were retained";
      return result;
    }
    const Str head = prefix + identity(base, size) + "\n";
    if (!body.starts_with(head)) {
      result.stale_edits = true;
    } else {
      portable::Library library;
      for (const auto& s : project::detail::list(whole.project, "samples")) {
        portable::Library::Asset asset;
        asset.rate = project::detail::num(s, "sampleRate");
        for (const auto& v : project::detail::list(s, "pcm")) asset.pcm.push(v.as_number());
        if (!portable::hash_sample(asset.rate, asset.pcm, asset.hash, result.error)) return result;
        library.assets.push(xmp::move(asset));
      }
      const auto later = portable::open(edits + head.size(), edits_size - head.size(), &library);
      // A matching newer save must never be replaced with an older interpretation.
      if (!later.ok) { result.error = later.error; return result; }
      result.project = later.project;
      result.edits_applied = true;
    }
  }
  result.ok = true;
  return result;
}
}  // namespace xmp::song_snapshot
