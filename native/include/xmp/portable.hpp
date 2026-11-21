#pragma once
// Opening the files XMP's browser studio saves, in C++: the C++ port of
// packages/core assets.ts importPortable (and hashSample). It opens:
//   - a plain project ("xmp-project", any version);
//   - a version 1 bundle ("xmp-bundle", project.xmp.json): samples stored once
//     each, by SHA-256 hash, as JSON numbers;
//   - a version 2 song (.xmpsong): sample descriptors, a canonical project
//     hash, and packaged audio as base64 chunks of float32 or float64. A song
//     saved without its samples ("referenced") needs them from a library, which
//     the Live does not have yet: it reports them missing, as the browser does.
// Hashes are verified exactly as the browser computes them, so a damaged or
// altered file is refused. tests/parity/portable-parity.test.ts runs both.
#include "xmp/project.hpp"

namespace xmp::portable {

// A project's sample pool (assets.ts MAX_SAMPLES).
constexpr int32_t kMaxSamples = project::kMaxSamples;

using json::Value;

// ---- SHA-256 (FIPS 180-4) ----
class Sha256 {
 public:
  Sha256() { reset(); }
  void reset() {
    static const uint32_t kInit[8] = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                                      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
    memcpy(h_, kInit, sizeof h_);
    length_ = 0, used_ = 0;
  }
  void update(const uint8_t* data, size_t n) {
    length_ += n;
    while (n) {
      const size_t take = n < 64 - used_ ? n : 64 - used_;
      memcpy(block_ + used_, data, take);
      used_ += take, data += take, n -= take;
      if (used_ == 64) compress(), used_ = 0;
    }
  }
  void update(const Str& s) { update(reinterpret_cast<const uint8_t*>(s.data()), s.size()); }
  // "sha256-" and the lowercase hex digest.
  Str hex() {
    const uint64_t bits = length_ * 8;
    const uint8_t one = 0x80, zero = 0;
    update(&one, 1);
    while (used_ != 56) update(&zero, 1);
    uint8_t len[8];
    for (int i = 0; i < 8; ++i) len[i] = static_cast<uint8_t>(bits >> (56 - 8 * i));
    update(len, 8);
    static const char* kHex = "0123456789abcdef";
    Str out("sha256-");
    for (const uint32_t w : h_)
      for (int i = 28; i >= 0; i -= 4) out.push(kHex[(w >> i) & 15]);
    return out;
  }

 private:
  static uint32_t rotr(uint32_t x, int n) { return (x >> n) | (x << (32 - n)); }
  void compress() {
    static const uint32_t k[64] = {
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2};
    uint32_t w[64];
    for (int i = 0; i < 16; ++i)
      w[i] = (static_cast<uint32_t>(block_[i * 4]) << 24) | (static_cast<uint32_t>(block_[i * 4 + 1]) << 16) |
             (static_cast<uint32_t>(block_[i * 4 + 2]) << 8) | block_[i * 4 + 3];
    for (int i = 16; i < 64; ++i) {
      const uint32_t s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3),
                     s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10);
      w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    uint32_t a = h_[0], b = h_[1], c = h_[2], d = h_[3], e = h_[4], f = h_[5], g = h_[6], h = h_[7];
    for (int i = 0; i < 64; ++i) {
      const uint32_t t1 = h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + k[i] + w[i],
                     t2 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c));
      h = g, g = f, f = e, e = d + t1, d = c, c = b, b = a, a = t1 + t2;
    }
    h_[0] += a, h_[1] += b, h_[2] += c, h_[3] += d, h_[4] += e, h_[5] += f, h_[6] += g, h_[7] += h;
  }
  uint32_t h_[8];
  uint8_t block_[64];
  uint64_t length_ = 0;
  size_t used_ = 0;
};

// hashSample: SHA-256 over the rate, the length and each value as a float64 (-0 as 0).
inline bool hash_sample(double rate, const Vec<double>& pcm, Str& out, Str& error) {
  if (rate != floor(rate) || rate < 8000 || rate > 96000 || pcm.size() < 1 || pcm.size() > project_limits::kLoopSampleFrames)
    return error = "Invalid sample bounds", false;
  Sha256 sha;
  uint8_t head[8];
  const uint32_t r = static_cast<uint32_t>(rate), n = static_cast<uint32_t>(pcm.size());
  for (int i = 0; i < 4; ++i) head[i] = static_cast<uint8_t>(r >> (8 * i)), head[4 + i] = static_cast<uint8_t>(n >> (8 * i));
  sha.update(head, 8);
  for (const double v : pcm) {
    if (!isfinite(v) || v < -1 || v > 1) return error = "Invalid sample amplitude", false;
    const double x = v == 0 ? 0.0 : v;
    uint8_t bytes[8];
    memcpy(bytes, &x, 8);  // little-endian hosts (the Mac, the Live, WebAssembly)
    sha.update(bytes, 8);
  }
  out = sha.hex();
  return true;
}

namespace detail {
using project::detail::at;
using project::detail::list;
using project::detail::num;
using project::detail::str;
inline bool is_hash(const Value& v) {
  if (!v.is_string() || v.as_string().size() != 71 || !v.as_string().starts_with("sha256-")) return false;
  for (size_t i = 7; i < 71; ++i) {
    const char c = v.as_string()[i];
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
  }
  return true;
}
inline bool is_int(const Value& v, double lo, double hi) {
  return v.is_number() && v.as_number() == floor(v.as_number()) && v.as_number() >= lo && v.as_number() <= hi;
}
// The browser's canonical(): sorted keys, JSON.stringify for keys and values.
inline void canonical(const Value& v, Str& out) {
  if (v.is_array()) {
    out.push('[');
    for (int32_t i = 0; i < v.items().size(); ++i) {
      if (i) out.push(',');
      canonical(v.items()[i], out);
    }
    out.push(']');
    return;
  }
  if (v.is_object()) {
    Vec<int32_t> order;
    for (int32_t i = 0; i < v.members().size(); ++i) order.push(i);
    // JavaScript's default sort compares UTF-16 code units; project keys are ASCII.
    for (int32_t i = 1; i < order.size(); ++i)
      for (int32_t k = i; k > 0 && strcmp(v.members()[order[k - 1]].key.c_str(), v.members()[order[k]].key.c_str()) > 0; --k) {
        const int32_t t = order[k];
        order[k] = order[k - 1], order[k - 1] = t;
      }
    out.push('{');
    for (int32_t i = 0; i < order.size(); ++i) {
      if (i) out.push(',');
      const json::Member& m = v.members()[order[i]];
      out += json::stringify(Value::of(m.key));
      out.push(':');
      canonical(m.value, out);
    }
    out.push('}');
    return;
  }
  out += json::stringify(v);
}
inline Str descriptor_hash(const Value& project) {
  Str text;
  canonical(project, text);
  Sha256 sha;
  sha.update(text);
  return sha.hex();
}
// A record of unknown values, as zod parses it (a "__proto__" key is dropped).
inline Value as_record(const Value& v) {
  Value out = Value::new_object();
  for (const auto& m : v.members())
    if (m.key != "__proto__") out.set(m.key, m.value);
  return out;
}
inline const char* kAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
// The base64 alphabet's index of a character (-1: not in it), by table.
inline int32_t index_of(char c) {
  static const struct Table {
    int8_t at[256];
    Table() {
      for (int32_t i = 0; i < 256; ++i) at[i] = -1;
      for (int32_t i = 0; i < 64; ++i) at[static_cast<uint8_t>(kAlphabet[i])] = static_cast<int8_t>(i);
    }
  } table;
  return table.at[static_cast<uint8_t>(c)];
}
inline Str base64(const uint8_t* b, size_t n) {
  Str out;
  for (size_t i = 0; i < n; i += 3) {
    const uint32_t a = b[i], x = i + 1 < n ? b[i + 1] : 0, y = i + 2 < n ? b[i + 2] : 0, bits = a * 65536 + x * 256 + y;
    out.push(kAlphabet[(bits >> 18) & 63]).push(kAlphabet[(bits >> 12) & 63]);
    out.push(i + 1 < n ? kAlphabet[(bits >> 6) & 63] : '=').push(i + 2 < n ? kAlphabet[bits & 63] : '=');
  }
  return out;
}
// /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/ with length 4..960
inline bool chunk_shape(const Str& s) {
  const size_t n = s.utf16_length();
  if (n < 4 || n > 960 || s.size() % 4) return false;
  for (size_t i = 0; i < s.size(); ++i) {
    const char c = s[i];
    const bool b64 = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '+' || c == '/';
    const bool tail = i >= s.size() - 2;
    if (c == '=') {
      if (!tail || (i == s.size() - 2 && s[s.size() - 1] != '=')) return false;
    } else if (!b64)
      return false;
  }
  return true;
}
// decodeAsset
inline bool decode_asset(const Value& asset, Vec<double>& out, Str& error) {
  const bool f32 = str(asset, "encoding") == "pcm-f32le";
  const size_t width = f32 ? 4 : 8, frames = static_cast<size_t>(num(asset, "frames")), bytes_n = frames * width;
  const auto& chunks = list(asset, "chunks");
  if (static_cast<size_t>(chunks.size()) != (bytes_n + 719) / 720) return error = "Invalid audio chunk count", false;
  Vec<uint8_t> bytes;
  bytes.reserve(static_cast<int32_t>(bytes_n));
  size_t offset = 0;
  for (const auto& c : chunks) {
    const Str& chunk = c.as_string();
    const size_t size = 720 < bytes_n - offset ? 720 : bytes_n - offset;
    if (chunk.size() != ((size + 2) / 3) * 4) return error = "Invalid audio chunk length", false;
    uint8_t part[720];
    size_t at = 0;
    for (size_t i = 0; i < chunk.size(); i += 4) {
      const int32_t a = index_of(chunk[i]), b = index_of(chunk[i + 1]), x = index_of(chunk[i + 2]), y = index_of(chunk[i + 3]);
      const uint32_t bits = (static_cast<uint32_t>(a) << 18) | (static_cast<uint32_t>(b) << 12) |
                            (static_cast<uint32_t>(x < 0 ? 0 : x) << 6) | static_cast<uint32_t>(y < 0 ? 0 : y);
      if (at < size) part[at++] = (bits >> 16) & 255;
      if (at < size) part[at++] = (bits >> 8) & 255;
      if (at < size) part[at++] = bits & 255;
    }
    if (base64(part, size) != chunk) return error = "Noncanonical audio encoding", false;
    for (size_t i = 0; i < size; ++i) bytes.push(part[i]);
    offset += size;
  }
  out.clear();
  out.reserve(static_cast<int32_t>(frames));
  for (size_t i = 0; i < frames; ++i) {
    if (f32) {
      float v;
      memcpy(&v, bytes.begin() + i * 4, 4);
      out.push(v);
    } else {
      double v;
      memcpy(&v, bytes.begin() + i * 8, 8);
      out.push(v);
    }
  }
  return true;
}
inline Value sample_value(const Str& id, const Str& name, double rate, const Vec<double>& pcm) {
  Value s = Value::new_object();
  s.set("id", Value::of(id)), s.set("name", Value::of(name)), s.set("sampleRate", Value::of(rate));
  Value values = Value::new_array();
  values.items().reserve(pcm.size());
  for (const double v : pcm) values.push(Value::of(v));
  s.set("pcm", xmp::move(values));
  return s;
}
inline bool fail(Str& error, const char* message) { return error = message, false; }
}  // namespace detail

// The result of opening a file.
struct Opened {
  bool ok = false;
  Value project;  // canonical version 7
  Str error;
};

// Audio a song saved without its samples needs, from outside the file (the
// browser's sample library, or WAV files the user locates): importSongValue's
// resolveAsset, answered before opening. `missing` lists what was not found.
struct Library {
  struct Asset {
    Str hash;
    double rate = 0;
    Vec<double> pcm;
  };
  Vec<Asset> assets;
  const Asset* find(const Str& hash) const {
    for (const auto& a : assets)
      if (a.hash == hash) return &a;
    return nullptr;
  }
};
struct Missing {
  Str id, name, hash;
  double rate = 0, frames = 0;
};

namespace detail {
// prepareSong and importSongValue (version 2), with an optional sample library.
inline bool import_song(const Value& value, Value& out, Str& error, const Library* library = nullptr,
                        Vec<Missing>* missing_out = nullptr) {
  const Value* assets = value.get("assets");
  if (!assets || !assets->is_array() || assets->items().size() > kMaxSamples) return fail(error, "Invalid song asset table");
  const Value* project = value.get("project");
  const Value* samples_raw = project && project->is_object() ? project->get("samples") : nullptr;
  if (!samples_raw || !samples_raw->is_array() || samples_raw->items().size() < 1 || samples_raw->items().size() > kMaxSamples)
    return fail(error, "Invalid song sample descriptors");
  const int32_t max_sample = project_limits::sample_frames(*project), max_total = project_limits::total_frames(*project);
  double frames = 0;
  for (const auto& s : samples_raw->items()) {
    const Value* f = s.is_object() ? s.get("frames") : nullptr;
    if (!f || !is_int(*f, 1, max_sample)) return fail(error, "Invalid song sample bounds");
    frames += f->as_number();
    if (frames > max_total) return fail(error, project_limits::extended(*project) ? "Song exceeds extended sample budget" : "Song exceeds two million sample frames");
  }
  double declared = 0;
  for (const auto& raw : assets->items()) {
    const Value* f = raw.is_object() ? raw.get("frames") : nullptr;
    const Value* chunks = raw.is_object() ? raw.get("chunks") : nullptr;
    const Value* encoding = raw.is_object() ? raw.get("encoding") : nullptr;
    const bool known = encoding && encoding->is_string() &&
                       (encoding->as_string() == "pcm-f32le" || encoding->as_string() == "pcm-f64le");
    if (!f || !is_int(*f, 1, max_sample) || !chunks || !chunks->is_array() || !known ||
        chunks->items().size() !=
            static_cast<int32_t>(ceil((f->as_number() * (encoding->as_string() == "pcm-f32le" ? 4 : 8)) / 720)))
      return fail(error, "Invalid song audio bounds");
    declared += f->as_number();
    if (declared > max_total) return fail(error, project_limits::extended(*project) ? "Song assets exceed extended sample budget" : "Song assets exceed two million frames");
  }
  // songEnvelope
  static const char* kTop[] = {"format", "version", "sampleMode", "projectHash", "project", "assets"};
  for (const auto& m : value.members()) {
    bool ok = false;
    for (const char* k : kTop) ok = ok || m.key == k;
    if (!ok) return fail(error, "song: unrecognized key");
  }
  const Value& mode = at(value, "sampleMode");
  if (!mode.is_string() || (mode.as_string() != "embedded" && mode.as_string() != "referenced") ||
      !is_hash(at(value, "projectHash")) || !project->is_object())
    return fail(error, "song: invalid envelope");
  for (const auto& a : assets->items()) {
    static const char* kAsset[] = {"hash", "sampleRate", "frames", "encoding", "chunks"};
    for (const auto& m : a.members()) {
      bool ok = false;
      for (const char* k : kAsset) ok = ok || m.key == k;
      if (!ok) return fail(error, "song asset: unrecognized key");
    }
    if (!is_hash(at(a, "hash")) || !is_int(at(a, "sampleRate"), 8000, 96000) || list(a, "chunks").size() < 1 ||
        list(a, "chunks").size() > static_cast<int32_t>(ceil(max_sample * 8.0 / 720)))
      return fail(error, "song asset: invalid");
    for (const auto& c : list(a, "chunks"))
      if (!c.is_string() || !chunk_shape(c.as_string())) return fail(error, "song asset: invalid chunk");
  }
  const Value record = as_record(*project);
  // The sample descriptors.
  struct Descriptor {
    Str id, name, hash;
    double rate, frames;
  };
  Vec<Descriptor> samples;
  for (const auto& s : list(record, "samples")) {
    static const char* kKeys[] = {"id", "name", "assetHash", "sampleRate", "frames"};
    if (!s.is_object()) return fail(error, "song sample: expected an object");
    for (const auto& m : s.members()) {
      bool ok = false;
      for (const char* k : kKeys) ok = ok || m.key == k;
      if (!ok) return fail(error, "song sample: unrecognized key");
    }
    const Value &id = at(s, "id"), &name = at(s, "name");
    if (!id.is_string() || !schema::is_id(id.as_string()) || !name.is_string() || name.as_string().code_points() < 1 ||
        name.as_string().code_points() > 120 || !is_hash(at(s, "assetHash")) || !is_int(at(s, "sampleRate"), 8000, 96000) ||
        !is_int(at(s, "frames"), 1, max_sample))
      return fail(error, "song sample: invalid");
    samples.push(Descriptor{id.as_string(), name.as_string(), str(s, "assetHash"), num(s, "sampleRate"), num(s, "frames")});
  }
  if (descriptor_hash(record) != str(value, "projectHash")) return fail(error, "Corrupt song metadata; project was not changed");
  frames = 0;
  Vec<int32_t> unique;  // first descriptor per hash
  for (int32_t i = 0; i < samples.size(); ++i) {
    frames += samples[i].frames;
    if (frames > max_total) return fail(error, project_limits::extended(*project) ? "Song exceeds extended sample budget" : "Song exceeds two million sample frames");
    int32_t previous = -1;
    for (const int32_t u : unique)
      if (samples[u].hash == samples[i].hash) previous = u;
    if (previous >= 0 && (samples[previous].frames != samples[i].frames || samples[previous].rate != samples[i].rate))
      return fail(error, "Conflicting sample descriptors");
    if (previous < 0) unique.push(i);
  }
  // The whole musical model, with silent placeholders, before any audio.
  {
    Value check = record;
    Value placeholders = Value::new_array();
    for (const auto& s : samples) {
      Vec<double> zeros;
      for (int32_t i = 0; i < static_cast<int32_t>(s.frames); ++i) zeros.push(0);
      placeholders.push(sample_value(s.id, s.name, s.rate, zeros));
    }
    check.set("samples", xmp::move(placeholders));
    Value ignored;
    if (!project::migrate(check, ignored, error)) return false;
  }
  if (mode.as_string() == "referenced" && assets->items().size())
    return fail(error, "Referenced song must not contain embedded audio");
  double embedded = 0;
  for (const auto& a : assets->items()) {
    embedded += num(a, "frames");
    if (embedded > max_total) return fail(error, project_limits::extended(*project) ? "Song assets exceed extended sample budget" : "Song assets exceed two million frames");
  }
  struct Decoded {
    Str hash;
    Vec<double> pcm;
    double rate;
  };
  Vec<Decoded> decoded;
  for (const auto& a : assets->items()) {
    const Descriptor* expected = nullptr;
    for (const int32_t u : unique)
      if (samples[u].hash == str(a, "hash")) expected = &samples[u];
    bool seen = false;
    for (const auto& d : decoded) seen = seen || d.hash == str(a, "hash");
    if (seen || !expected || expected->frames != num(a, "frames") || expected->rate != num(a, "sampleRate"))
      return fail(error, "Duplicate, unreferenced or conflicting audio asset");
    Decoded d;
    d.hash = str(a, "hash"), d.rate = num(a, "sampleRate");
    if (!decode_asset(a, d.pcm, error)) return false;
    Str hash;
    if (!hash_sample(d.rate, d.pcm, hash, error)) return false;
    if (hash != d.hash) return fail(error, "Corrupt sample hash; project was not changed");
    decoded.push(xmp::move(d));
  }
  if (mode.as_string() == "embedded" && decoded.size() != unique.size())
    return fail(error, "Packaged song is missing embedded audio");
  // What the file lacks, from the library: the same rate, length and hash, else refused.
  Str missing;
  for (const int32_t u : unique) {
    bool have = false;
    for (const auto& d : decoded) have = have || d.hash == samples[u].hash;
    if (have) continue;
    const Library::Asset* found = library ? library->find(samples[u].hash) : nullptr;
    if (found) {
      Str hash, ignored;
      if (found->rate != samples[u].rate || found->pcm.size() != static_cast<int32_t>(samples[u].frames) ||
          !hash_sample(found->rate, found->pcm, hash, ignored) || hash != samples[u].hash) {
        error = Str("Sample content does not match ") + samples[u].name + "; project was not changed";
        return false;
      }
      Decoded d;
      d.hash = samples[u].hash, d.rate = found->rate, d.pcm = found->pcm;
      decoded.push(xmp::move(d));
      continue;
    }
    if (missing_out)
      missing_out->push(Missing{samples[u].id, samples[u].name, samples[u].hash, samples[u].rate, samples[u].frames});
    if (!missing.empty()) missing += ", ";
    missing += samples[u].name;
  }
  if (!missing.empty()) {
    error = Str("Missing samples: ") + missing +
            ". Locate matching WAV files or open a copy packaged with samples. Your song was not changed.";
    return false;
  }
  Value full = record;
  Value list_ = Value::new_array();
  for (const auto& s : samples)
    for (const auto& d : decoded)
      if (d.hash == s.hash) {
        list_.push(sample_value(s.id, s.name, d.rate, d.pcm));
        break;
      }
  full.set("samples", xmp::move(list_));
  return project::migrate(full, out, error);
}
}  // namespace detail

// importPortable: a project, bundle or song file to a canonical version 7 project.
inline Opened open(const char* text, size_t bytes, const Library* library = nullptr, Vec<Missing>* missing = nullptr) {
  using namespace detail;
  Opened r;
  if (!project::preflight(text, bytes, r.error, project_limits::kSongBytes)) return r;
  const auto parsed = json::parse(text, bytes);
  if (!parsed.ok) return r.error = parsed.error, r;
  const Value& v = parsed.value;
  const Value* body = v.is_object() ? v.get("project") : nullptr;
  const Value& profile = body ? *body : v;
  if (bytes > project_limits::kProjectBytes && !project_limits::extended(profile))
    return r.error = "Project exceeds 24 MiB", r;
  const Value* format = v.is_object() ? v.get("format") : nullptr;
  const Value* version = v.is_object() ? v.get("version") : nullptr;
  const bool bundle = format && format->is_string() && format->as_string() == "xmp-bundle";
  if (bundle && version && !(version->is_number() && (version->as_number() == 1 || version->as_number() == 2)))
    return r.error = "Unsupported song file version. Update XMP OS or use a legacy copy.", r;
  if (bundle && version && version->is_number() && version->as_number() == 2) {
    r.ok = import_song(v, r.project, r.error, library, missing);
    return r;
  }
  if (format && format->is_string() && format->as_string() == "xmp-project") {
    const auto opened = project::open(text, bytes);
    r.ok = opened.ok, r.project = opened.project, r.error = opened.error;
    return r;
  }
  // Version 1 bundle (envelopeSchema).
  static const char* kTop[] = {"format", "version", "project", "assets"};
  if (!v.is_object()) return r.error = "bundle: expected an object", r;
  for (const auto& m : v.members()) {
    bool ok = false;
    for (const char* k : kTop) ok = ok || m.key == k;
    if (!ok) return r.error = "bundle: unrecognized key", r;
  }
  if (!bundle || !version || !version->is_number() || version->as_number() != 1 || !at(v, "project").is_object() ||
      !at(v, "assets").is_array() || list(v, "assets").size() < 1 || list(v, "assets").size() > kMaxSamples)
    return r.error = "bundle: invalid envelope", r;
  const Value record = as_record(at(v, "project"));
  struct Descriptor {
    Str id, name, hash;
  };
  Vec<Descriptor> samples;
  const Value& raw_samples = at(record, "samples");
  if (!raw_samples.is_array() || raw_samples.items().size() < 1 || raw_samples.items().size() > kMaxSamples)
    return r.error = "bundle samples: invalid", r;
  for (const auto& s : raw_samples.items()) {
    if (!s.is_object()) return r.error = "bundle sample: expected an object", r;
    for (const auto& m : s.members())
      if (m.key != "id" && m.key != "name" && m.key != "assetHash") return r.error = "bundle sample: unrecognized key", r;
    const Value &id = at(s, "id"), &name = at(s, "name");
    if (!id.is_string() || !schema::is_id(id.as_string()) || !name.is_string() || name.as_string().code_points() < 1 ||
        name.as_string().code_points() > 120 || !is_hash(at(s, "assetHash")))
      return r.error = "bundle sample: invalid", r;
    samples.push(Descriptor{id.as_string(), name.as_string(), str(s, "assetHash")});
  }
  double frames = 0;
  for (const auto& raw : list(v, "assets")) {
    const Value* pcm = raw.is_object() ? raw.get("pcm") : nullptr;
    if (!pcm || !pcm->is_array()) return r.error = "Invalid sample asset", r;
    if (pcm->items().size() > project_limits::sample_frames(profile)) return r.error = "Sample exceeds 480000 frames", r;
    for (const auto& x : pcm->items())
      if (!x.is_number() || !isfinite(x.as_number()) || x.as_number() < -1 || x.as_number() > 1)
        return r.error = "Invalid sample amplitude", r;
    frames += pcm->items().size();
    if (frames > project_limits::total_frames(profile)) return r.error = "Asset import exceeds two million frames", r;
  }
  struct Asset {
    Str hash;
    double rate;
    Vec<double> pcm;
  };
  Vec<Asset> assets;
  for (const auto& raw : list(v, "assets")) {
    for (const auto& m : raw.members())
      if (m.key != "hash" && m.key != "sampleRate" && m.key != "pcm") return r.error = "bundle asset: unrecognized key", r;
    if (!is_hash(at(raw, "hash")) || !is_int(at(raw, "sampleRate"), 8000, 96000) || list(raw, "pcm").size() < 1)
      return r.error = "bundle asset: invalid", r;
    Asset a;
    a.hash = str(raw, "hash"), a.rate = num(raw, "sampleRate");
    for (const auto& x : list(raw, "pcm")) a.pcm.push(x.as_number());
    for (const auto& b : assets)
      if (b.hash == a.hash) return r.error = "Duplicate asset hash", r;
    Str hash;
    if (!hash_sample(a.rate, a.pcm, hash, r.error)) return r;
    if (hash != a.hash) return r.error = "Corrupt sample hash; project was not changed", r;
    assets.push(xmp::move(a));
  }
  for (const auto& a : assets) {
    bool used = false;
    for (const auto& s : samples) used = used || s.hash == a.hash;
    if (!used) return r.error = "Unreferenced asset in package", r;
  }
  Value full = record;
  Value list_ = Value::new_array();
  for (const auto& s : samples) {
    const Asset* a = nullptr;
    for (const auto& x : assets)
      if (x.hash == s.hash) a = &x;
    if (!a) return r.error = Str("Missing asset ") + s.hash, r;
    list_.push(sample_value(s.id, s.name, a->rate, a->pcm));
  }
  full.set("samples", xmp::move(list_));
  r.ok = project::migrate(full, r.project, r.error);
  return r;
}
inline Opened open(const Str& text) { return open(text.data(), text.size()); }

// exportSong(project, {packageSamples}) for a canonical version 7
// project: a version 2 song with each sample's audio stored once, by hash, as
// base64 chunks of float32 (when every value is exactly a float32) or float64.
// Saving needs one SHA-256 and one base64 pass over the audio instead of
// writing every value as shortest-digit text, which is what makes it quick on
// the Live (tests/parity/portable-parity.test.ts compares the bytes).
// `hashes`, when given, receives each sample's audio hash, in order.
inline bool save_song(const Value& project, Str& out, Str& error, bool package_samples = true,
                      Vec<Str>* hashes = nullptr) {
  using namespace detail;
  if (!project.is_object() || !project.get("samples") || !project.get("samples")->is_array())
    return fail(error, "Invalid project");
  Value descriptors = Value::new_array();
  Value assets = Value::new_array();
  Vec<Str> stored;
  Vec<double> pcm;
  Vec<uint8_t> bytes;
  for (const auto& s : list(project, "samples")) {
    const Value* values = s.is_object() ? s.get("pcm") : nullptr;
    if (!values || !values->is_array() || !s.get("sampleRate") || !s.get("sampleRate")->is_number())
      return fail(error, "Invalid sample");
    pcm.clear();
    pcm.reserve(values->items().size());
    for (const auto& v : values->items()) {
      if (!v.is_number()) return fail(error, "Invalid sample amplitude");
      pcm.push(v.as_number());
    }
    const double rate = num(s, "sampleRate");
    Str hash;
    if (!hash_sample(rate, pcm, hash, error)) return false;
    if (hashes) hashes->push(hash);
    Value d = Value::new_object();
    d.set("id", at(s, "id")), d.set("name", at(s, "name")), d.set("assetHash", Value::of(hash));
    d.set("sampleRate", Value::of(rate)), d.set("frames", Value::of(static_cast<double>(pcm.size())));
    descriptors.push(xmp::move(d));
    bool seen = !package_samples;  // a referenced song stores no audio
    for (const auto& h : stored) seen = seen || h == hash;
    if (seen) continue;
    stored.push(hash);
    bool f32 = true;
    for (const double v : pcm) f32 = f32 && static_cast<double>(static_cast<float>(v)) == v;
    const size_t width = f32 ? 4 : 8;
    bytes.clear();
    bytes.reserve(pcm.size() * static_cast<int32_t>(width));
    for (const double v : pcm) {
      uint8_t b[8];
      if (f32) {
        const float x = v == 0 ? 0.0f : static_cast<float>(v);
        memcpy(b, &x, 4);
      } else {
        const double x = v == 0 ? 0.0 : v;
        memcpy(b, &x, 8);
      }
      for (size_t i = 0; i < width; ++i) bytes.push(b[i]);
    }
    Value chunks = Value::new_array();
    const size_t total = static_cast<size_t>(bytes.size());
    for (size_t i = 0; i < total; i += 720) chunks.push(Value::of(base64(bytes.begin() + i, total - i < 720 ? total - i : 720)));
    Value a = Value::new_object();
    a.set("hash", Value::of(hash)), a.set("sampleRate", Value::of(rate));
    a.set("frames", Value::of(static_cast<double>(pcm.size())));
    a.set("encoding", Value::of(Str(f32 ? "pcm-f32le" : "pcm-f64le"))), a.set("chunks", xmp::move(chunks));
    assets.push(xmp::move(a));
  }
  Value descriptor = Value::new_object();
  for (const auto& m : project.members())
    if (m.key == "samples")
      descriptor.set(m.key, descriptors);
    else
      descriptor.set(m.key, m.value);
  Value song = Value::new_object();
  song.set("format", Value::of(Str("xmp-bundle"))), song.set("version", Value::of(2.0));
  song.set("sampleMode", Value::of(Str(package_samples ? "embedded" : "referenced")));
  song.set("projectHash", Value::of(descriptor_hash(descriptor)));
  song.set("project", xmp::move(descriptor)), song.set("assets", xmp::move(assets));
  out = json::stringify(song);
  return true;
}

// exportPortable: the legacy version 1 bundle (project.xmp.json), each
// sample's audio stored once by hash as JSON numbers. Slow for large samples
// (every value is written as shortest-digit text); kept for "Save legacy copy".
inline bool save_bundle(const Value& project, Str& out, Str& error) {
  using namespace detail;
  if (!project.is_object() || !project.get("samples") || !project.get("samples")->is_array())
    return fail(error, "Invalid project");
  Value descriptors = Value::new_array(), assets = Value::new_array();
  Vec<Str> stored;
  Vec<double> pcm;
  for (const auto& s : list(project, "samples")) {
    const Value* values = s.is_object() ? s.get("pcm") : nullptr;
    if (!values || !values->is_array() || !s.get("sampleRate") || !s.get("sampleRate")->is_number())
      return fail(error, "Invalid sample");
    pcm.clear();
    for (const auto& v : values->items()) {
      if (!v.is_number()) return fail(error, "Invalid sample amplitude");
      pcm.push(v.as_number());
    }
    Str hash;
    if (!hash_sample(num(s, "sampleRate"), pcm, hash, error)) return false;
    Value d = Value::new_object();
    d.set("id", at(s, "id")), d.set("name", at(s, "name")), d.set("assetHash", Value::of(hash));
    descriptors.push(xmp::move(d));
    bool seen = false;
    for (const auto& h : stored) seen = seen || h == hash;
    if (seen) continue;
    stored.push(hash);
    Value a = Value::new_object();
    a.set("hash", Value::of(hash)), a.set("sampleRate", at(s, "sampleRate")), a.set("pcm", *values);
    assets.push(xmp::move(a));
  }
  Value body = Value::new_object();
  for (const auto& m : project.members()) body.set(m.key, m.key == "samples" ? descriptors : m.value);
  Value bundle = Value::new_object();
  bundle.set("format", Value::of(Str("xmp-bundle"))), bundle.set("version", Value::of(1.0));
  bundle.set("project", xmp::move(body)), bundle.set("assets", xmp::move(assets));
  out = json::stringify(bundle);
  return true;
}

}  // namespace xmp::portable
