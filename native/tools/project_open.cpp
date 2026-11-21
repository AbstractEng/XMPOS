// Test driver for tests/parity/project-parity.test.ts: reads project texts separated
// by NUL bytes on stdin and writes, for each, "ok <migrated>\n" + the canonical
// JSON, or "error\n" + the message, separated by NUL bytes.
#include <stdio.h>

#include "xmp/project.hpp"

int main() {
  xmp::Str doc;
  int c;
  auto flush = [&] {
    const auto r = xmp::project::open(doc);
    if (r.ok) {
      const auto text = xmp::json::stringify(r.project);
      fputs(r.migrated ? "ok 1\n" : "ok 0\n", stdout);
      fwrite(text.data(), 1, text.size(), stdout);
    } else {
      fputs("error\n", stdout);
      fwrite(r.error.data(), 1, r.error.size(), stdout);
    }
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
