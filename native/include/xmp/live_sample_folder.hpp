#pragma once
// Loads a sampler track's sounds from the owner's stick (xmp/samples/trackN/)
// into a SampleBank, before the audio thread starts. Everything is bounded:
// file count, file size, length, and a total memory budget shared by all
// sampler tracks. Nothing found in the folder is executed or interpreted
// beyond its name and the WAV format.
//
// Two layouts:
//   Flat: up to 16 .wav files, sorted by name, go to pads 1-16, one each.
//   Per pad: folders whose names start with the pad number ("01", "03 hat_c1",
//   "16 crash"), each with up to 64 .wav files:
//     - "_v<1-8>" in a file name sets its velocity layer (1 = softest); files
//       with the same layer are round-robin takes (up to 8);
//     - without "_v" tokens, every file is its own layer, softest first by name;
//     - "_c<1-9>" in the folder name puts the pad in that choke group.
#include <dirent.h>
#include <sys/stat.h>

#include <algorithm>
#include <cctype>
#include <cstdint>
#include <cstdio>
#include <map>
#include <string>
#include <vector>

#include "xmp/live_sampler.hpp"
#include "xmp/live_wav.hpp"

namespace xmp::live {

constexpr std::size_t kSampleBudgetFrames = 48u * 1024 * 1024;  // 192 MB of float, all sampler tracks
constexpr std::size_t kMaxPadFiles = 64;

struct FolderLoad {
  std::size_t files = 0, frames = 0, pads = 0;
  std::vector<std::string> notes;  // what was skipped and why
};

namespace folder_detail {
inline std::string lower(std::string s) {
  for (auto& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  return s;
}
inline bool is_wav(const std::string& name) {
  const auto l = lower(name);
  return l.size() > 4 && l.compare(l.size() - 4, 4, ".wav") == 0 && name[0] != '.';
}
// Entries of `dir` (no dot files), sorted; at most `limit`.
inline std::vector<std::string> list(const std::string& dir, bool want_dirs, std::size_t limit) {
  std::vector<std::string> out;
  DIR* d = opendir(dir.c_str());
  if (!d) return out;
  std::size_t seen = 0;
  while (dirent* e = readdir(d)) {
    if (++seen > 4096) break;
    const std::string name = e->d_name;
    if (name.empty() || name[0] == '.' || name.size() > 200) continue;
    struct stat st {};
    if (lstat((dir + "/" + name).c_str(), &st) != 0) continue;
    if (want_dirs ? S_ISDIR(st.st_mode) : (S_ISREG(st.st_mode) && is_wav(name))) out.push_back(name);
  }
  closedir(d);
  std::sort(out.begin(), out.end(), [](const std::string& a, const std::string& b) { return lower(a) < lower(b); });
  if (out.size() > limit) out.resize(limit);
  return out;
}
// The number after `_<letter>` in `name` (case-insensitive), or 0.
inline int token(const std::string& name, char letter, int hi) {
  const auto l = lower(name);
  for (std::size_t at = l.find(std::string("_") + letter); at != std::string::npos;
       at = l.find(std::string("_") + letter, at + 1)) {
    std::size_t end = at + 2;
    int v = 0;
    while (end < l.size() && std::isdigit(static_cast<unsigned char>(l[end])) && end < at + 4) v = v * 10 + (l[end++] - '0');
    if (end > at + 2 && v >= 1 && v <= hi) return v;
  }
  return 0;
}
// "03 closed hat_c1" -> "closed hat": no pad number and no _c, _v or _rr tags.
inline std::string pad_name_from(const std::string& name, bool numbered = true) {
  std::string s = name;
  if (numbered && s.size() >= 2 && std::isdigit(static_cast<unsigned char>(s[0])) &&
      std::isdigit(static_cast<unsigned char>(s[1])))
    s = s.substr(2);
  auto is_tag = [](const std::string& part) {
    const auto l = lower(part);
    std::size_t digits = l.rfind("rr", 0) == 0 ? 2 : (l[0] == 'c' || l[0] == 'v') ? 1 : 0;
    if (!digits || l.size() <= digits) return false;
    return l.find_first_not_of("0123456789", digits) == std::string::npos;
  };
  std::string out;
  std::size_t at = 0;
  for (bool first = true;; first = false) {
    const auto bar = s.find('_', at);
    const auto part = s.substr(at, bar == std::string::npos ? std::string::npos : bar - at);
    if (first || (!part.empty() && !is_tag(part))) out += (first ? "" : " ") + part;
    if (bar == std::string::npos) break;
    at = bar + 1;
  }
  while (!out.empty() && out.front() == ' ') out.erase(out.begin());
  while (!out.empty() && out.back() == ' ') out.pop_back();
  return out.substr(0, 32);
}
inline bool read_file(const std::string& path, std::vector<std::uint8_t>& out) {
  std::FILE* f = std::fopen(path.c_str(), "rb");
  if (!f) return false;
  out.clear();
  std::uint8_t buf[65536];
  std::size_t n;
  while ((n = std::fread(buf, 1, sizeof buf, f)) > 0) {
    if (out.size() + n > kWavMaxBytes) {
      std::fclose(f);
      return false;
    }
    out.insert(out.end(), buf, buf + n);
  }
  std::fclose(f);
  return true;
}
}  // namespace folder_detail

// Loads `dir` into `bank`. `budget` is the number of frames still allowed and
// is reduced by what is loaded.
inline FolderLoad load_sample_folder(const std::string& dir, std::uint32_t rate, SampleBank& bank,
                                     std::size_t& budget) {
  using namespace folder_detail;
  FolderLoad result;
  std::vector<std::uint8_t> bytes;
  auto load = [&](const std::string& path, std::vector<float>& out) {
    if (!read_file(path, bytes)) {
      result.notes.push_back(path + ": unreadable or larger than 48 MB");
      return false;
    }
    auto wav = decode_wav(bytes, rate);
    if (!wav.error.empty()) {
      result.notes.push_back(path + ": " + wav.error);
      return false;
    }
    if (wav.samples.size() > budget) {
      result.notes.push_back(path + ": over the sample memory budget");
      return false;
    }
    budget -= wav.samples.size();
    result.frames += wav.samples.size();
    ++result.files;
    out = std::move(wav.samples);
    return true;
  };

  // Per-pad folders take precedence over flat files.
  std::vector<std::pair<int, std::string>> pad_dirs;
  for (const auto& name : list(dir, true, 64)) {
    if (name.size() < 2 || !std::isdigit(static_cast<unsigned char>(name[0])) ||
        !std::isdigit(static_cast<unsigned char>(name[1])))
      continue;
    const int pad = (name[0] - '0') * 10 + (name[1] - '0');
    if (pad >= 1 && pad <= 16) pad_dirs.emplace_back(pad - 1, name);
  }
  if (!pad_dirs.empty()) {
    for (const auto& [pad, name] : pad_dirs) {
      auto& p = bank.pads[static_cast<std::size_t>(pad)];
      if (!p.empty()) {
        result.notes.push_back(name + ": pad " + std::to_string(pad + 1) + " already has a folder");
        continue;
      }
      const auto files = list(dir + "/" + name, false, kMaxPadFiles);
      bool tagged = false;
      for (const auto& f : files) tagged = tagged || token(f, 'v', 8) > 0;
      std::map<int, std::vector<std::vector<float>>> layers;  // layer number -> takes
      int next = 1;
      for (const auto& f : files) {
        const int layer = tagged ? token(f, 'v', 8) : next;
        if (layer < 1 || layer > static_cast<int>(kMaxLayers)) {
          result.notes.push_back(name + "/" + f + (tagged ? ": no _v layer tag" : ": more than 8 layers"));
          continue;
        }
        const auto found = layers.find(layer);
        if (found != layers.end() && found->second.size() >= kMaxTakes) {
          result.notes.push_back(name + "/" + f + ": more than 8 takes in a layer");
          continue;
        }
        std::vector<float> sound;
        if (!load(dir + "/" + name + "/" + f, sound)) continue;
        layers[layer].push_back(std::move(sound));
        if (!tagged) ++next;
      }
      std::size_t i = 0;
      for (auto& [number, takes] : layers) {
        (void)number;
        p.layers.push_back({SamplePad::even_top(i++, layers.size()), std::move(takes)});
      }
      p.choke = static_cast<std::uint8_t>(token(name, 'c', 9));
      p.name = pad_name_from(name);
      result.pads += !p.empty();
    }
    return result;
  }
  const auto files = list(dir, false, 16);
  for (std::size_t i = 0; i < files.size(); ++i) {
    std::vector<float> sound;
    if (!load(dir + "/" + files[i], sound)) continue;
    bank.set_single(static_cast<int>(i), std::move(sound));
    bank.pads[i].name = pad_name_from(files[i].substr(0, files[i].size() - 4), false);
    ++result.pads;
  }
  return result;
}

}  // namespace xmp::live
