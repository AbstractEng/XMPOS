#include "xmp/live_library.hpp"
#include <cstdio>
#include <cstdlib>
#include <fstream>
int main() {
  namespace lib = xmp::live::library;
  char folder[] = "/tmp/xmp-library-test-XXXXXX";
  const char *root = mkdtemp(folder);
  if (!root)
    return 1;
  const std::string base = root;
  std::ofstream(base + "/hit.wav", std::ios::binary) << "test";
  std::ofstream(base + "/plugin.so", std::ios::binary) << "ignore";
  symlink("/etc/passwd", (base + "/alias.wav").c_str());
  symlink("/etc", (base + "/other").c_str());
  auto entries = lib::scan(base);
  int failures = 0;
  // Browser adapters use an opaque file ID as the relative locator. Search
  // must match the displayed filename, as it does on the USB-stick adapter.
  const lib::Entry browser_file{"42", "NEWCLAP.wav", 1, 128};
  if (!lib::matches(browser_file, "newclap") || !lib::matches(browser_file, "") ||
      lib::matches(browser_file, "missing") ||
      !lib::matches({"Drums/Break.wav", "Break.wav", 1, 128}, "drums")) ++failures;
  if (entries.size() != 1 || entries[0].name != "hit.wav")
    ++failures;
  std::vector<unsigned char> bytes;
  if (entries.empty() || !lib::read(base, entries[0], bytes) || bytes.size() != 4)
    ++failures;
  unlink((base + "/hit.wav").c_str());
  symlink("/etc/passwd", (base + "/hit.wav").c_str());
  if (!entries.empty() && lib::read(base, entries[0], bytes))
    ++failures;
  if (lib::read(base, {"../escape.wav", "bad", 1, 4}, bytes))
    ++failures;
  unlink((base + "/hit.wav").c_str());
  unlink((base + "/plugin.so").c_str());
  unlink((base + "/alias.wav").c_str());
  unlink((base + "/other").c_str());
  rmdir(root);
  std::printf("library bounds: %s\n", failures ? "FAILED" : "passed");
  return failures ? 1 : 0;
}
