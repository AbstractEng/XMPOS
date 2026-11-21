#pragma once
// Read-only metadata index beneath the loader's configured USB project
// directory. Never follows symlinks or opens a device; selected regular files
// are bounded.
#include <algorithm>
#include <cctype>
#include <cerrno>
#include <dirent.h>
#include <fcntl.h>
#include <string>
#include <sys/stat.h>
#include <unistd.h>
#include <vector>
namespace xmp::live::library {
struct Entry {
  std::string relative, name;
  int kind = 1;
  std::size_t bytes = 0;
  bool factory = false;
};
inline std::string lower(std::string s) {
  for (auto &c : s)
    c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  return s;
}
inline bool matches(const Entry& entry, const std::string& query) {
  return query.empty() || lower(entry.name).find(query) != std::string::npos ||
         lower(entry.relative).find(query) != std::string::npos;
}
#ifndef __wasi__
inline std::vector<Entry> scan(const std::string &root) {
  std::vector<Entry> entries;
  if (root.empty() || root.size() > 1024)
    return entries;
  int top = open(root.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (top < 0)
    return entries;
  std::size_t seen = 0;
  auto visit = [&](auto &&self, int parent, const std::string &relative, int depth) -> void {
    if (depth > 4 || seen >= 10000)
      return;
    DIR *directory = fdopendir(dup(parent));
    if (!directory)
      return;
    while (auto *item = readdir(directory)) {
      if (++seen > 10000)
        break;
      std::string name = item->d_name;
      if (name.empty() || name[0] == '.' || name.size() > 200)
        continue;
      struct stat st{};
      if (fstatat(parent, name.c_str(), &st, AT_SYMLINK_NOFOLLOW) != 0)
        continue;
      const std::string path = relative.empty() ? name : relative + "/" + name;
      if (S_ISDIR(st.st_mode)) {
        int next = openat(parent, name.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        if (next >= 0) {
          self(self, next, path, depth + 1);
          close(next);
        }
        continue;
      }
      if (!S_ISREG(st.st_mode) || st.st_size <= 0)
        continue;
      const auto normalized = lower(name);
      int kind = 0;
      auto ends = [&](const char *suffix) {
        const std::string s = suffix;
        return normalized.size() >= s.size() && normalized.compare(normalized.size() - s.size(), s.size(), s) == 0;
      };
      if (ends(".wav") && st.st_size <= 16 * 1024 * 1024)
        kind = 1;
      else if ((ends(".xmpkit") || ends(".kit.json")) && st.st_size <= 24 * 1024 * 1024)
        kind = 2;
      else if ((ends(".xmpsong") || ends(".xmp.json")) && st.st_size <= 96 * 1024 * 1024)
        kind = 3;
      if (kind)
        entries.push_back({path, name, kind, static_cast<std::size_t>(st.st_size)});
    }
    closedir(directory);
  };
  visit(visit, top, "", 0);
  close(top);
  std::sort(entries.begin(), entries.end(),
            [](const Entry &a, const Entry &b) { return lower(a.name) < lower(b.name); });
  return entries;
}
inline bool read(const std::string &root, const Entry &entry, std::vector<unsigned char> &bytes) {
  if (entry.relative.empty() || entry.relative.size() > 2048 || entry.bytes > 96 * 1024 * 1024)
    return false;
  int directory = open(root.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (directory < 0)
    return false;
  std::size_t begin = 0;
  int file = -1;
  for (;;) {
    const auto end = entry.relative.find('/', begin);
    const auto part = entry.relative.substr(begin, end == std::string::npos ? end : end - begin);
    if (part.empty() || part == "." || part == "..") {
      close(directory);
      return false;
    }
    if (end == std::string::npos) {
      file = openat(directory, part.c_str(), O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
      close(directory);
      break;
    }
    int next = openat(directory, part.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    close(directory);
    if (next < 0)
      return false;
    directory = next;
    begin = end + 1;
  }
  if (file < 0)
    return false;
  struct stat st{};
  if (fstat(file, &st) != 0 || !S_ISREG(st.st_mode) || st.st_size != static_cast<off_t>(entry.bytes)) {
    close(file);
    return false;
  }
  bytes.resize(entry.bytes);
  std::size_t at = 0;
  while (at < bytes.size()) {
    const auto n = ::read(file, bytes.data() + at, bytes.size() - at);
    if (n <= 0) {
      close(file);
      bytes.clear();
      return false;
    }
    at += static_cast<std::size_t>(n);
  }
  close(file);
  return true;
}
// Named copies always stay inside the configured stick project directory. An
// exclusive create prevents replacing an existing file, including a symlink.
inline bool save_copy(const std::string& root, const std::string& name, const char* data, std::size_t size) {
  if (root.empty() || name.empty() || name.find_first_of("/\\") != std::string::npos ||
      size == 0 || size > 24 * 1024 * 1024) return false;
  const int top = open(root.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (top < 0) return false;
  const bool directory_ready = mkdirat(top, "Projects", 0755) == 0 || errno == EEXIST;
  const int directory = directory_ready ? openat(top, "Projects", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC) : -1;
  close(top);
  if (directory < 0) return false;
  const std::string file = name + ".xmpsong";
  const int fd = openat(directory, file.c_str(), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0644);
  if (fd < 0) {
    close(directory);
    return false;
  }
  std::size_t done = 0;
  while (done < size) {
    const auto count = write(fd, data + done, size - done);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) break;
    done += static_cast<std::size_t>(count);
  }
  const bool written = done == size && fsync(fd) == 0;
  const bool closed = close(fd) == 0;
  if (!written || !closed) unlinkat(directory, file.c_str(), 0);
  close(directory);
  return written && closed;
}

#endif
} // namespace xmp::live::library
