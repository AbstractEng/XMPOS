#pragma once
// XMP's file formats in C++: WAV (as index.ts encodeWav and recording.ts
// decodeSampleWav) and Standard MIDI Files (encodeMidi, decodeMidi,
// exchangePlan and importMidiClip, whose TypeScript originals phase 9 retired).
// tests/parity/files-parity.test.ts runs this native build against the
// WebAssembly one.
#include "xmp/performance.hpp"

namespace xmp::files {

using json::Value;
using Bytes = Vec<uint8_t>;

// ---- WAV ----
// encodeWav: 16-bit PCM, one or two channels.
inline bool encode_wav(const Vec<Vec<float>>& channels, uint32_t rate, Bytes& out, Str& error) {
  const int32_t length = channels.size() ? channels[0].size() : 0;
  bool ok = channels.size() && channels.size() <= 2;
  for (const auto& c : channels) ok = ok && c.size() == length;
  if (!ok) return error = "Invalid WAV channels", false;
  const uint32_t n = static_cast<uint32_t>(channels.size()), bytes = 44 + static_cast<uint32_t>(length) * n * 2;
  out.clear();
  out.reserve(static_cast<int32_t>(bytes));
  auto text = [&](const char* s) {
    for (int i = 0; i < 4; ++i) out.push(static_cast<uint8_t>(s[i]));
  };
  auto u32 = [&](uint32_t v) {
    for (int i = 0; i < 4; ++i) out.push(static_cast<uint8_t>(v >> (8 * i)));
  };
  auto u16 = [&](uint32_t v) {
    out.push(static_cast<uint8_t>(v)), out.push(static_cast<uint8_t>(v >> 8));
  };
  text("RIFF"), u32(bytes - 8), text("WAVE"), text("fmt "), u32(16), u16(1), u16(n), u32(rate), u32(rate * n * 2);
  u16(n * 2), u16(16), text("data"), u32(bytes - 44);
  for (int32_t f = 0; f < length; ++f)
    for (uint32_t c = 0; c < n; ++c) {
      const double v = fmax(-1, fmin(1, static_cast<double>(channels[static_cast<int32_t>(c)][f])));
      const double scaled = v * (v < 0 ? 32768 : 32767), r = floor(scaled);
      const int32_t s = static_cast<int32_t>(scaled - r >= 0.5 ? r + 1 : r);  // Math.round
      u16(static_cast<uint32_t>(static_cast<uint16_t>(static_cast<int16_t>(s))));
    }
  return true;
}

struct Sample {
  Vec<float> pcm;
  uint32_t rate = 0;
};
// decodeSampleWav: mono or stereo PCM16/24/32 or float32, mixed to mono.
inline bool decode_sample_wav(const uint8_t* b, size_t size, Sample& out, Str& error) {
  if (size < 44 || size > 16 * 1024 * 1024) return error = "WAV must be between 44 bytes and 16 MiB", false;
  auto u32 = [&](size_t at) {
    return static_cast<uint32_t>(b[at]) | (static_cast<uint32_t>(b[at + 1]) << 8) |
           (static_cast<uint32_t>(b[at + 2]) << 16) | (static_cast<uint32_t>(b[at + 3]) << 24);
  };
  auto u16 = [&](size_t at) { return static_cast<uint32_t>(b[at]) | (static_cast<uint32_t>(b[at + 1]) << 8); };
  auto is = [&](size_t at, const char* t) { return memcmp(b + at, t, 4) == 0; };
  if (!is(0, "RIFF") || !is(8, "WAVE") || u32(4) != size - 8) return error = "Invalid RIFF WAV", false;
  uint32_t format = 0, channels = 0, rate = 0, bits = 0, align = 0;
  size_t data_at = 0, data_size = 0;
  int32_t chunks = 0;
  for (size_t at = 12; at + 8 <= size;) {
    if (++chunks > 64) return error = "WAV chunk budget exceeded", false;
    const uint32_t chunk = u32(at + 4);
    const size_t end = at + 8 + chunk;
    if (end > size) return error = "Truncated WAV chunk", false;
    if (is(at, "fmt ")) {
      if (format || chunk < 16) return error = "Invalid WAV format chunk", false;
      format = u16(at + 8), channels = u16(at + 10), rate = u32(at + 12), align = u16(at + 20), bits = u16(at + 22);
    }
    if (is(at, "data")) {
      if (data_at) return error = "Duplicate WAV data", false;
      data_at = at + 8, data_size = chunk;
    }
    at = end + (chunk % 2);
  }
  if ((format != 1 && format != 3) || (channels != 1 && channels != 2) || rate < 8000 || rate > 96000 ||
      (bits != 16 && bits != 24 && bits != 32) || (format == 3 && bits != 32) || align != (channels * bits) / 8 ||
      !data_at || !data_size || data_size % align)
    return error = "Use mono/stereo PCM16/24/32 or float32 WAV", false;
  const size_t frames = data_size / align;
  if (frames > 1536000 || static_cast<double>(frames) / rate > 32)
    return error = "Sample exceeds 32 seconds or 1536000 frames", false;
  out.pcm.clear();
  out.pcm.reserve(static_cast<int32_t>(frames));
  for (size_t f = 0; f < frames; ++f) {
    float acc = 0;
    for (uint32_t c = 0; c < channels; ++c) {
      const size_t at = data_at + f * align + (c * bits) / 8;
      double v;
      if (format == 3) {
        float x;
        const uint32_t raw = u32(at);
        memcpy(&x, &raw, 4);
        v = x;
      } else if (bits == 16)
        v = static_cast<int16_t>(u16(at)) / 32768.0;
      else if (bits == 32)
        v = static_cast<int32_t>(u32(at)) / 2147483648.0;
      else
        v = static_cast<int32_t>(b[at] | (b[at + 1] << 8) | (static_cast<int32_t>(static_cast<int8_t>(b[at + 2])) << 16)) /
            8388608.0;
      if (!isfinite(v)) return error = "Non-finite WAV amplitude", false;
      v = fmax(-1, fmin(1, v));
      acc = static_cast<float>(static_cast<double>(acc) + v / channels);  // a Float32Array element
    }
    out.pcm.push(acc);
  }
  out.rate = rate;
  return true;
}

// ---- Standard MIDI Files ----
constexpr double kPpq = 960;
struct MidiNote {
  double track = 0, channel = 0, note = 0, velocity = 0, tick = 0, duration = 0;
};
struct MidiTempo {
  double tick = 0, micros = 0;
};
struct MidiDocument {
  double ppq = kPpq;
  Vec<MidiNote> notes;
  Vec<MidiTempo> tempos;
  double end_tick = 0, ignored_events = 0;
};

namespace detail {
inline bool safe_int(double v) { return v == floor(v) && fabs(v) <= 9007199254740991.0; }
inline bool validate(const MidiDocument& d, Str& error) {
  if (!(d.ppq == floor(d.ppq)) || d.ppq < 1 || d.ppq > 9600 || d.notes.size() > 8192 || d.tempos.size() < 1 ||
      d.tempos.size() > 65 || !safe_int(d.end_tick) || d.end_tick < 0 || d.end_tick > d.ppq * 16384)
    return error = "Invalid MIDI document budget", false;
  for (const auto& n : d.notes) {
    const double all[] = {n.track, n.channel, n.note, n.velocity, n.tick, n.duration};
    bool ok = true;
    for (const double x : all) ok = ok && safe_int(x);
    if (!ok || n.track < 0 || n.track > 16 || n.channel < 0 || n.channel > 15 || n.note < 0 || n.note > 127 ||
        n.velocity < 1 || n.velocity > 127 || n.tick < 0 || n.duration < 1 || n.tick + n.duration > d.end_tick)
      return error = "Invalid MIDI note", false;
  }
  for (int32_t i = 0; i < d.tempos.size(); ++i) {
    const auto& t = d.tempos[i];
    if (!safe_int(t.tick) || t.tick < 0 || t.tick > d.end_tick || !(t.micros == floor(t.micros)) || t.micros < 200000 ||
        t.micros > 2000000 || (i > 0 && t.tick <= d.tempos[i - 1].tick))
      return error = "Invalid MIDI tempo map", false;
  }
  return true;
}
struct Event {
  double tick;
  uint8_t data[6];
  int32_t size, priority;
};
// A stable sort by (tick, priority).
inline void sort_events(Vec<Event>& e) {
  for (int32_t i = 1; i < e.size(); ++i)
    for (int32_t k = i; k > 0; --k) {
      const Event &a = e[k - 1], &b = e[k];
      if (!(a.tick > b.tick || (a.tick == b.tick && a.priority > b.priority))) break;
      const Event t = e[k];
      e[k] = e[k - 1], e[k - 1] = t;
    }
}
inline bool vlq(double n, Bytes& out, Str& error) {
  if (!safe_int(n) || n < 0 || n > 0xfffffff) return error = "Invalid MIDI delta", false;
  uint32_t v = static_cast<uint32_t>(n);
  uint8_t buf[5];
  int32_t k = 0;
  buf[k++] = v & 127;
  v >>= 7;
  while (v) buf[k++] = static_cast<uint8_t>((v & 127) | 128), v >>= 7;
  while (k) out.push(buf[--k]);
  return true;
}
inline bool track_chunk(Vec<Event> events, double end, Bytes& out, Str& error) {
  sort_events(events);
  Bytes data;
  double last = 0;
  for (const auto& e : events) {
    if (!vlq(e.tick - last, data, error)) return false;
    for (int32_t i = 0; i < e.size; ++i) data.push(e.data[i]);
    last = e.tick;
  }
  if (!vlq(fmax(last, end) - last, data, error)) return false;
  data.push(0xff), data.push(0x2f), data.push(0);
  const char* m = "MTrk";
  for (int i = 0; i < 4; ++i) out.push(static_cast<uint8_t>(m[i]));
  const uint32_t n = static_cast<uint32_t>(data.size());
  out.push(static_cast<uint8_t>(n >> 24)), out.push(static_cast<uint8_t>(n >> 16)), out.push(static_cast<uint8_t>(n >> 8));
  out.push(static_cast<uint8_t>(n));
  for (const uint8_t x : data) out.push(x);
  return true;
}
}  // namespace detail

// encodeMidi: format 1, a conductor track with the tempos, then a track per note track.
inline bool encode_midi(const MidiDocument& d, Bytes& out, Str& error) {
  if (!detail::validate(d, error)) return false;
  Vec<double> ids;
  for (const auto& n : d.notes) {
    bool seen = false;
    for (const double t : ids) seen = seen || t == n.track;
    if (!seen) ids.push(n.track);
  }
  if (ids.size() > 16) return error = "MIDI export supports at most sixteen note tracks plus conductor", false;
  {
    // Same-pitch notes may not overlap (checked in start order).
    Vec<int32_t> order;
    for (int32_t i = 0; i < d.notes.size(); ++i) order.push(i);
    for (int32_t i = 1; i < order.size(); ++i)
      for (int32_t k = i; k > 0 && d.notes[order[k - 1]].tick > d.notes[order[k]].tick; --k) {
        const int32_t t = order[k];
        order[k] = order[k - 1], order[k - 1] = t;
      }
    struct End {
      double track, channel, note, end;
    };
    Vec<End> ends;
    for (const int32_t i : order) {
      const MidiNote& n = d.notes[i];
      End* found = nullptr;
      for (auto& e : ends)
        if (e.track == n.track && e.channel == n.channel && e.note == n.note) found = &e;
      if ((found ? found->end : 0) > n.tick)
        return error = "Overlapping same-pitch notes cannot be exported unambiguously; shorten or move a note", false;
      if (found)
        found->end = n.tick + n.duration;
      else
        ends.push(End{n.track, n.channel, n.note, n.tick + n.duration});
    }
  }
  for (int32_t i = 1; i < ids.size(); ++i)
    for (int32_t k = i; k > 0 && ids[k - 1] > ids[k]; --k) {
      const double t = ids[k];
      ids[k] = ids[k - 1], ids[k - 1] = t;
    }
  Vec<Bytes> chunks;
  {
    Vec<detail::Event> tempo;
    for (const auto& t : d.tempos) {
      const uint32_t m = static_cast<uint32_t>(t.micros);
      tempo.push(detail::Event{t.tick, {0xff, 0x51, 3, static_cast<uint8_t>((m >> 16) & 255), static_cast<uint8_t>((m >> 8) & 255),
                                        static_cast<uint8_t>(m & 255)},
                               6, 0});
    }
    Bytes c;
    if (!detail::track_chunk(tempo, d.end_tick, c, error)) return false;
    chunks.push(xmp::move(c));
  }
  for (const double id : ids) {
    Vec<detail::Event> events;
    for (const auto& n : d.notes)
      if (n.track == id) {
        const auto ch = static_cast<uint8_t>(n.channel), note = static_cast<uint8_t>(n.note),
                   vel = static_cast<uint8_t>(n.velocity);
        events.push(detail::Event{n.tick, {static_cast<uint8_t>(0x90 | ch), note, vel, 0, 0, 0}, 3, 1});
        events.push(detail::Event{n.tick + n.duration, {static_cast<uint8_t>(0x80 | ch), note, 0, 0, 0, 0}, 3, 0});
      }
    Bytes c;
    if (!detail::track_chunk(events, d.end_tick, c, error)) return false;
    chunks.push(xmp::move(c));
  }
  out.clear();
  const char* m = "MThd";
  for (int i = 0; i < 4; ++i) out.push(static_cast<uint8_t>(m[i]));
  const uint32_t count = static_cast<uint32_t>(chunks.size()), ppq = static_cast<uint32_t>(d.ppq);
  const uint8_t header[] = {0, 0, 0, 6, 0, 1, static_cast<uint8_t>(count >> 8), static_cast<uint8_t>(count),
                            static_cast<uint8_t>(ppq >> 8), static_cast<uint8_t>(ppq)};
  for (const uint8_t x : header) out.push(x);
  for (const auto& c : chunks)
    for (const uint8_t x : c) out.push(x);
  return true;
}

// decodeMidi: SMF 0 or 1 with PPQ timing; notes paired, tempos merged.
inline bool decode_midi(const uint8_t* bytes, size_t length, MidiDocument& out, Str& error) {
  if (length > 1048576) return error = "MIDI exceeds 1 MiB", false;
  size_t pos = 0, limit = length;
  int64_t events = 0;
  bool bad = false;
  auto read = [&](int n) -> double {
    if (pos + static_cast<size_t>(n) > limit) {
      if (!bad) error = "Truncated MIDI";
      bad = true;
      return 0;
    }
    double v = 0;
    for (int i = 0; i < n; ++i) v = v * 256 + bytes[pos++];
    return v;
  };
#define XMP_TRY(expr) \
  do {                \
    expr;             \
    if (bad) return false; \
  } while (0)
  auto magic = [&](const char* s) {
    for (int i = 0; i < 4; ++i) {
      const double c = read(1);
      if (bad) return false;
      if (c != static_cast<uint8_t>(s[i])) return error = "Invalid MIDI chunk", bad = true, false;
    }
    return true;
  };
  auto delta = [&](double& v) {
    v = 0;
    for (int i = 0; i < 4; ++i) {
      const double b = read(1);
      if (bad) return false;
      v = v * 128 + (static_cast<uint32_t>(b) & 127);
      if (!(static_cast<uint32_t>(b) & 128)) return true;
    }
    return error = "Oversized MIDI VLQ", bad = true, false;
  };
  if (!magic("MThd")) return false;
  double header = 0;
  XMP_TRY(header = read(4));
  if (header != 6) return error = "Unsupported MIDI header", false;
  double format = 0, tracks = 0, ppq = 0;
  XMP_TRY(format = read(2));
  XMP_TRY(tracks = read(2));
  XMP_TRY(ppq = read(2));
  if (format > 1 || tracks < 1 || tracks > 17 || (format == 0 && tracks != 1) || ppq < 1 || ppq > 9600)
    return error = "Only SMF 0/1 PPQ timing is supported", false;
  out = MidiDocument{};
  out.ppq = ppq;
  for (int32_t track = 0; track < static_cast<int32_t>(tracks); ++track) {
    limit = length;
    if (!magic("MTrk")) return false;
    double size = 0;
    XMP_TRY(size = read(4));
    const size_t end = pos + static_cast<size_t>(size);
    if (end > length) return error = "Truncated MIDI track", false;
    limit = end;
    double tick = 0;
    uint32_t running = 0;
    bool ended = false;
    struct Held {
      double tick, velocity;
    };
    // held[channel][note]: a queue of note-ons.
    static Vec<Held> held[16][128];
    for (auto& ch : held)
      for (auto& q : ch) q.clear();
    while (pos < end) {
      if (++events > 32768) return error = "MIDI event budget exceeded", false;
      double d = 0;
      if (!delta(d)) return false;
      tick += d;
      if (tick > ppq * 16384) return error = "MIDI duration budget exceeded", false;
      double s = 0;
      XMP_TRY(s = read(1));
      uint32_t status = static_cast<uint32_t>(s);
      if (status < 128) {
        if (!running) return error = "Invalid running status", false;
        --pos;
        status = running;
      }
      if (status == 0xff) {
        running = 0;
        double type = 0, len = 0;
        XMP_TRY(type = read(1));
        if (!delta(len)) return false;
        if (pos + static_cast<size_t>(len) > end) return error = "Truncated meta event", false;
        if (type == 0x51) {
          if (len != 3 || out.tempos.size() >= 65) return error = "Invalid tempo meta event", false;
          double micros = 0;
          XMP_TRY(micros = read(3));
          out.tempos.push(MidiTempo{tick, micros});
        } else if (type == 0x2f) {
          if (len != 0 || pos != end) return error = "Invalid end-of-track", false;
          ended = true;
        } else {
          pos += static_cast<size_t>(len);
          ++out.ignored_events;
        }
      } else {
        if (status >= 0xf0) return error = "SysEx and system messages are unsupported in MIDI files", false;
        running = status;
        const uint32_t kind = status & 0xf0;
        double a = 0, b = 0;
        XMP_TRY(a = read(1));
        if (kind != 0xc0 && kind != 0xd0) XMP_TRY(b = read(1));
        if (a > 127 || b > 127) return error = "Invalid MIDI data byte", false;
        auto& queue = held[status & 15][static_cast<int32_t>(a)];
        if (kind == 0x90 && b > 0)
          queue.push(Held{tick, b});
        else if (kind == 0x80 || kind == 0x90) {
          if (queue.empty() || tick <= queue[0].tick) return error = "Unpaired or zero-length MIDI note", false;
          const Held on = queue[0];
          queue.erase(0);
          if (out.notes.size() >= 8192) return error = "MIDI note budget exceeded", false;
          out.notes.push(MidiNote{static_cast<double>(track), static_cast<double>(status & 15), a, on.velocity, on.tick,
                                  tick - on.tick});
        } else
          ++out.ignored_events;
      }
    }
    bool holding = false;
    for (auto& ch : held)
      for (auto& q : ch) holding = holding || !q.empty();
    if (!ended || holding) return error = "MIDI track has no end marker or contains held notes", false;
    out.end_tick = fmax(out.end_tick, tick);
  }
#undef XMP_TRY
  if (pos != length) return error = "Trailing MIDI chunks", false;
  // Tempos by tick (stable), one per tick, and 120 BPM at the start if none.
  auto& t = out.tempos;
  for (int32_t i = 1; i < t.size(); ++i)
    for (int32_t k = i; k > 0 && t[k - 1].tick > t[k].tick; --k) {
      const MidiTempo x = t[k];
      t[k] = t[k - 1], t[k - 1] = x;
    }
  Vec<MidiTempo> merged;
  for (int32_t i = 0; i < t.size(); ++i) {
    if (i > 0 && t[i - 1].tick == t[i].tick) {
      if (t[i - 1].micros != t[i].micros) return error = "Conflicting MIDI tempos", false;
      continue;
    }
    merged.push(t[i]);
  }
  t = xmp::move(merged);
  if (!t.size() || t[0].tick != 0) t.insert(0, MidiTempo{0, 500000});
  auto& n = out.notes;
  for (int32_t i = 1; i < n.size(); ++i)
    for (int32_t k = i; k > 0; --k) {
      const MidiNote &a = n[k - 1], &b = n[k];
      const bool after = a.tick > b.tick || (a.tick == b.tick && (a.track > b.track || (a.track == b.track && a.note > b.note)));
      if (!after) break;
      const MidiNote x = n[k];
      n[k] = n[k - 1], n[k - 1] = x;
    }
  return detail::validate(out, error);
}

// exchangePlan: the MIDI document for a scene or a finite song, played through
// the performance so launches, song mode, mutes and solos shape it.
inline bool exchange_plan(const Value& project, const Str& mode, const Str& scene, MidiDocument& out, double& steps_out,
                          Str& error) {
  using namespace play::detail;
  Value checked;
  if (!project::canonical(project, checked, error)) return false;
  if (mode != "scene" && mode != "song") return error = "Invalid exchange mode", false;
  const Value* perf = project.get("performance");
  if (mode == "song" && (!perf || !list(*perf, "chain").size() || str(*perf, "end") != "stop"))
    return error = "Song export requires a finite chain ending in Stop", false;
  play::Performance player(project);
  if (!player.ok()) return error = player.error(), false;
  if (!player.start(scene, mode == "song", false, error)) return false;
  const double swing = num(project, "swing");
  const auto& tracks = list(project, "tracks");
  auto index_of = [&](const Str& id) {
    for (int32_t i = 0; i < tracks.size(); ++i)
      if (str(tracks[i], "id") == id) return i;
    return -1;
  };
  auto tick_at = [&](double position) {
    const double v = (xmp::sequencer::groove_position(position, swing) * kPpq) / 4, r = floor(v);
    return v - r >= 0.5 ? r + 1 : r;
  };
  struct Cut {
    int32_t track;
    double tick;
  };
  Vec<Cut> cuts;
  out = MidiDocument{};
  double steps = 1024;
  if (mode == "scene") {
    const Value* sc = nullptr;
    for (const auto& s : list(project, "scenes"))
      if (str(s, "id") == scene) sc = &s;
    steps = sc ? scene_length(project, *sc) : 16;
  }
  bool complete = mode == "scene";
  for (double step = 0; step < steps; ++step) {
    Value w;
    if (!play::performance_window(player, step, false, swing, 48000, w, error)) return false;
    for (const auto& id : list(w, "releases")) {
      const double v = (step * kPpq) / 4, r = floor(v);
      cuts.push(Cut{index_of(id.as_string()), v - r >= 0.5 ? r + 1 : r});
    }
    for (const auto& c : list(w, "controls"))
      for (const auto& id : list(c, "blocked")) cuts.push(Cut{index_of(id.as_string()), tick_at(num(c, "position"))});
    if (!at(at(w, "snapshot"), "running").as_bool()) {
      steps = step;
      complete = true;
      break;
    }
    const auto slots = player.slots();
    for (const auto& n : list(w, "notes")) {
      const double velocity = num(n, "velocity");
      if (velocity <= 0) continue;
      const double position = num(n, "position"), tick = tick_at(position), finish = tick_at(position + num(n, "duration"));
      const int32_t index = index_of(str(n, "trackId"));
      const Value* track = index >= 0 ? &tracks[index] : nullptr;
      const play::Performance::Slot* slot = player.slot(slots, str(n, "trackId"));
      const Value* clip = nullptr;
      if (track && slot && slot->has_clip)
        for (const auto& c : list(*track, "clips"))
          if (str(c, "id") == slot->clip) clip = &c;
      const Value* legacy = nullptr;
      if (strstr(str(n, "id").c_str(), ":legacy:") && clip) {
        const double local = fmod(position - (slot ? slot->anchor : 0), clip ? num(*clip, "length") : 16);
        for (const auto& s : list(*clip, "steps"))
          if (num(s, "pad") == num(n, "pad") && num(s, "step") == local) {
            legacy = &s;
            break;
          }
      }
      const Value* machine = track ? track->get("machine") : nullptr;
      const Value* pb =
          project::detail::track_pads(project, track)[static_cast<int32_t>(num(n, "pad"))].get("playback");
      const bool pad_pitch = legacy && !legacy->get("note") && (!machine || str(*machine, "id") == "xmp.sampler") &&
                             !(pb && str(*pb, "mode") == "chromatic");
      if (out.notes.size() >= 8192) return error = "MIDI note budget exceeded", false;
      const double v = velocity * 127, r = floor(v);
      out.notes.push(MidiNote{static_cast<double>(index), static_cast<double>(index),
                              pad_pitch ? 36 + num(n, "pad") : num(n, "note"), fmax(1, v - r >= 0.5 ? r + 1 : r), tick,
                              fmax(1, finish - tick)});
    }
  }
  if (!complete || steps < 1) return error = "Song exceeds 1023-step export budget or is empty", false;
  const double v = (steps * kPpq) / 4, r = floor(v), end = v - r >= 0.5 ? r + 1 : r;
  for (auto& n : out.notes) {
    n.duration = fmin(n.duration, end - n.tick);
    for (const auto& c : cuts)
      if (c.track == n.track && c.tick > n.tick && c.tick < n.tick + n.duration) n.duration = c.tick - n.tick;
  }
  auto micros = [](double bpm) {
    const double x = 60000000 / bpm, rr = floor(x);
    return x - rr >= 0.5 ? rr + 1 : rr;
  };
  out.tempos.push(MidiTempo{0, micros(num(project, "bpm"))});
  if (const Value* mix = project.get("mix"))
    for (const auto& t : list(*mix, "tempos"))
      if (num(t, "step") < steps) out.tempos.push(MidiTempo{(num(t, "step") * kPpq) / 4, micros(num(t, "bpm"))});
  out.ppq = kPpq;
  out.end_tick = end;
  steps_out = steps;
  return true;
}

// importMidiClip: one track of a MIDI file into an existing clip, as one edit.
inline edit::Edited import_midi_clip(const Value& project, const uint8_t* bytes, size_t length, double file_track,
                                     const Str& track_id, const Str& clip_id) {
  edit::Edited e;
  MidiDocument d;
  if (!decode_midi(bytes, length, d, e.error)) return e;
  Vec<MidiNote> notes;
  for (const auto& n : d.notes)
    if (n.track == file_track) notes.push(n);
  Value next = project;
  Value* clip = edit::detail::clip(next, track_id, clip_id);
  if (!clip || notes.size() < 1 || notes.size() > 1024)
    return e.error = "Choose a nonempty MIDI track with at most 1024 notes and an existing clip", e;
  for (const auto& t : d.tempos) {
    // Math.abs(bars - Math.round(bars)) > 1e-8
    const double bars = ((t.tick / d.ppq) * 4) / 16;
    if (fabs(bars - edit::detail::js_round(bars)) > 1e-8)
      return e.error = "This preview imports tempo changes only at bar boundaries", e;
  }
  const double length_steps = (d.end_tick / d.ppq) * 4;
  if (length_steps > 64) return e.error = "MIDI clip exceeds 64 steps; select a shorter file", e;
  clip->set("length", Value::of(length_steps <= 16 ? 16.0 : length_steps <= 32 ? 32.0 : 64.0));
  clip->set("steps", Value::new_array());
  Value seq = edit::detail::empty_sequence();
  Value list = Value::new_array();
  for (int32_t i = 0; i < notes.size(); ++i) {
    Value n = Value::new_object();
    n.set("id", Value::of(Str("midi-") + int_text(i)));
    n.set("position", Value::of((notes[i].tick / d.ppq) * 4));
    n.set("duration", Value::of((notes[i].duration / d.ppq) * 4));
    n.set("pad", Value::of(0.0)), n.set("note", Value::of(notes[i].note));
    n.set("velocity", Value::of(notes[i].velocity / 127));
    n.set("probability", Value::of(1.0)), n.set("microtiming", Value::of(0.0)), n.set("condition", Value::of("always"));
    list.push(xmp::move(n));
  }
  seq.set("notes", xmp::move(list));
  clip->set("sequence", xmp::move(seq));
  next.set("bpm", Value::of(60000000 / (d.tempos.size() ? d.tempos[0].micros : 500000)));
  if (!next.get("mix")) next.set("mix", edit::detail::empty_mix());
  Value tempos = Value::new_array();
  for (int32_t i = 1; i < d.tempos.size(); ++i) {
    Value t = Value::new_object();
    const double s = (d.tempos[i].tick / d.ppq) * 4, r = floor(s);
    t.set("step", Value::of(s - r >= 0.5 ? r + 1 : r));
    t.set("bpm", Value::of(60000000 / d.tempos[i].micros));
    tempos.push(xmp::move(t));
  }
  edit::detail::member(next, "mix").set("tempos", xmp::move(tempos));
  return edit::detail::finish(next);
}

}  // namespace xmp::files
