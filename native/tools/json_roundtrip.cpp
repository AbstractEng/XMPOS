// Test driver for tests/parity/json-parity.test.ts: reads documents separated by a NUL
// byte on stdin and writes, for each, "ok\n" + JSON.stringify(compact) + "\n" +
// JSON.stringify(indent 2) or "error\n", separated by NUL bytes.
#include <stdio.h>

#include "xmp/json.hpp"

int main() {
  xmp::Str doc;
  int c;
  auto flush = [&] {
    const auto r = xmp::json::parse(doc);
    if (r.ok) {
      const auto a = xmp::json::stringify(r.value), b = xmp::json::stringify(r.value, 2);
      fputs("ok\n", stdout);
      fwrite(a.data(), 1, a.size(), stdout);
      fputc('\n', stdout);
      fwrite(b.data(), 1, b.size(), stdout);
    } else {
      fputs("error\n", stdout);
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
