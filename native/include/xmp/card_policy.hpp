#pragma once
#include <algorithm>
#include <cctype>
#include <string>

namespace xmp {

// An ALSA card whose procfs identity names an Akai/inMusic product (or carries
// Akai's USB vendor ID 09e8) is refused: no device-specific authorization exists.
inline bool protected_card_identity(std::string identity) {
  std::transform(identity.begin(), identity.end(), identity.begin(),
                 [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  for (const char* word : {"akai", "inmusic", "force", "mpc", "09e8:"})
    if (identity.find(word) != std::string::npos) return true;
  return false;
}

}  // namespace xmp
