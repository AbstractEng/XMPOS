#include "xmp/card_policy.hpp"
#include <cstdio>
#include <string>

// Identities as procfs presents them: "<id>\n <usbid>\n <stream0 head>".
int main() {
  const char* refused[] = {"Force\n 09e8:0000\n Akai Professional Force",
                           "Live\n 09e8:0000\n Akai Professional MPC Live",
                           "Audio\n\n inMusic Brands device",
                           "x\n 09E8:1234\n"};
  const char* allowed[] = {"Audio\n 46f4:0002\n QEMU QEMU USB Audio at usb-0000:00:01.0-1",
                           "Intel\n\n HDA Intel PCH"};
  int failures = 0;
  for (const char* identity : refused)
    if (!xmp::protected_card_identity(identity)) {
      std::printf("not refused: %s\n", identity);
      ++failures;
    }
  for (const char* identity : allowed)
    if (xmp::protected_card_identity(identity)) {
      std::printf("wrongly refused: %s\n", identity);
      ++failures;
    }
  std::printf(failures ? "card policy failed\n" : "card policy passed\n");
  return failures ? 1 : 0;
}
