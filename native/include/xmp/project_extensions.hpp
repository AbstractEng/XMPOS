#pragma once
// Stable project extension descriptors. Unknown optional features are data,
// preserved verbatim through edits and saves, never executable code.
#include "xmp/json.hpp"
#include "xmp/project_schema.hpp"

namespace xmp::project::extensions {
using json::Value;

// Keep in step with project-extensions.ts. Advertise a version only when its
// native/Wasm semantics and validation are implemented, never from file input.
inline bool supported(const Str& id, int32_t version) { return (id == "xmp.extended-samples" || id == "xmp.sampler-input") && version == 1; }

inline bool namespace_id(const Str& id) {
  if (id.empty() || id.size() > 64) return false;
  bool start = true, dot = false;
  for (size_t i = 0; i < id.size(); ++i) {
    const char c = id[i];
    if (c == '.') {
      if (start) return false;
      start = true, dot = true;
    } else {
      if (start && !(c >= 'a' && c <= 'z')) return false;
      if (!(c >= 'a' && c <= 'z') && !(c >= '0' && c <= '9') && c != '-') return false;
      start = false;
    }
  }
  return dot && !start;
}

inline bool bounded(const Value& v, int32_t depth, int32_t& nodes) {
  if (++nodes > 8192 || depth > 10) return false;
  if (v.is_null() || v.is_bool()) return true;
  if (v.is_number()) return isfinite(v.as_number());
  if (v.is_string()) return v.as_string().utf16_length() <= 512;
  if (v.is_array()) {
    if (v.items().size() > 256) return false;
    for (const auto& child : v.items()) if (!bounded(child, depth + 1, nodes)) return false;
    return true;
  }
  if (!v.is_object() || v.members().size() > 64) return false;
  for (const auto& m : v.members())
    if (m.key.utf16_length() > 64 || m.key == "__proto__" || m.key == "constructor" || m.key == "prototype" ||
        !bounded(m.value, depth + 1, nodes)) return false;
  return true;
}

inline bool sampler_input_valid(const Value& data) {
  const auto* tracks = data.get("tracks");
  if (data.members().size() != 1 || !tracks || !tracks->is_object() || tracks->members().size() > 8) return false;
  for (const auto& t : tracks->members()) {
    const auto* monitor = t.value.get("monitor"), *bars = t.value.get("bars");
    if (!schema::is_id(t.key) || !t.value.is_object() || t.value.members().size() != 2 ||
        !monitor || !monitor->is_bool() || !bars || !bars->is_number() ||
        (bars->as_number() != 1 && bars->as_number() != 2 && bars->as_number() != 4)) return false;
  }
  return true;
}
inline bool validate(const Value& value, Str& error) {
  auto invalid = [&]() { error = "Invalid project extensions or JSON budget exceeded"; return false; };
  int32_t nodes = 0;
  if (!value.is_object() || value.members().size() > 32 || !bounded(value, 0, nodes)) return invalid();
  for (const auto& m : value.members()) {
    const auto& e = m.value;
    if (!namespace_id(m.key) || !e.is_object()) return invalid();
    for (const auto& field : e.members())
      if (field.key != "version" && field.key != "required" && field.key != "data") return invalid();
    const Value* version = e.get("version"), *data = e.get("data"), *required = e.get("required");
    if (!version || !version->is_number() || version->as_number() < 1 || version->as_number() > 65535 ||
        floor(version->as_number()) != version->as_number() || !data || !data->is_object() ||
        (required && !required->is_bool())) return invalid();
  }
  if (json::stringify(value).size() > 256 * 1024) return invalid();
  for (const auto& m : value.members()) {
    const auto* required = m.value.get("required");
    const auto version = static_cast<int32_t>(m.value.get("version")->as_number());
    if (version == 1 && ((m.key == "xmp.extended-samples" && !m.value.get("data")->members().empty()) || (m.key == "xmp.sampler-input" && !sampler_input_valid(*m.value.get("data"))))) return invalid();
    if (required && required->as_bool() && !supported(m.key, version)) {
      error = Str("Required project extension ") + m.key + " v" + int_text(version) +
              " is not supported by this XMP build";
      return false;
    }
  }
  return true;
}
}  // namespace xmp::project::extensions
