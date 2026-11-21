// Test driver for tests/parity/portable-parity.test.ts: reads files (project,
// bundle or song text) separated by NUL bytes on stdin and writes, for each,
// "ok\n" + the canonical project or "error\n" + the message, NUL-separated.
// With the argument "save", each input is a canonical project and the output
// is the song save_song writes for it.
#include <stdio.h>
#include <string.h>

#include "xmp/portable.hpp"

int main(int argc, char** argv) {
  const bool save = argc > 1 && strcmp(argv[1], "save") == 0;
  xmp::Str doc;
  int c;
  auto flush = [&] {
    bool ok = false;
    xmp::Str t;
    if (save) {
      const auto parsed = xmp::json::parse(doc);
      xmp::Str error;
      ok = parsed.ok && xmp::portable::save_song(parsed.value, t, error);
      if (!ok) t = parsed.ok ? error : parsed.error;
    } else {
      const auto r = xmp::portable::open(doc);
      ok = r.ok;
      t = r.ok ? xmp::json::stringify(r.project) : r.error;
    }
    fputs(ok ? "ok\n" : "error\n", stdout);
    fwrite(t.data(), 1, t.size(), stdout);
    fputc('\0', stdout);
    doc = xmp::Str();
  };
  while ((c = getchar()) != EOF) {
    if (c == 0)
      flush();
    else
      doc.push(static_cast<char>(c));
  }
  return 0;
}
