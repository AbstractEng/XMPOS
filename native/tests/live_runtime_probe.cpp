// Runs only in an isolated ARM VM. Never opens an audio/MIDI device.
#include <alsa/asoundlib.h>
#include <gnu/libc-version.h>
#include <sys/reboot.h>
#include <unistd.h>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <stdexcept>
#include <thread>
#include <vector>

int main() {
  std::vector<int> values(1024, 7);
  int result = 0;
  std::thread worker([&] { for (int value : values) result += value; });
  worker.join();
  bool unwound = false;
  try { throw std::runtime_error("XMP original runtime probe"); }
  catch (const std::runtime_error&) { unwound = true; }
  const bool config = snd_config_update() >= 0;
  const bool ok = result == 7168 && unwound && config && std::isfinite(std::sin(0.5)) &&
                  std::strcmp(snd_asoundlib_version(), "1.2.11") == 0;
  std::printf("XMP_DYNAMIC_RUNTIME_%s libc=%s alsa=%s threads=%d unwind=%d config=%d\n",
              ok ? "OK" : "FAILED", gnu_get_libc_version(), snd_asoundlib_version(),
              result, unwound, config);
  std::fflush(stdout);
  if (getpid() == 1) { reboot(RB_POWER_OFF); for (;;) pause(); }
  return ok ? 0 : 1;
}
