#pragma once
#include <cstdint>
#include <cstdlib>

namespace xmp {

// How the calling thread was scheduled for audio work.
enum class RealtimeScheduling : std::uint8_t {
  None = 0,             // the OS refused; the thread keeps normal priority
  MachTimeConstraint,   // macOS: the policy CoreAudio uses for its I/O threads
  SchedFifo,            // Linux: SCHED_FIFO real-time priority
};

struct RealtimeResult {
  RealtimeScheduling scheduling = RealtimeScheduling::None;
  bool memoryLocked = false;  // Linux: mlockall succeeded, so pages cannot fault mid-render
  int pinnedCpu = -1;         // Linux: CPU the thread was pinned to (an isolated core), or -1
};

// Highest CPU in a kernel CPU list such as "2-3" or "1,3-5" (the format of
// /sys/devices/system/cpu/isolated), or -1 for an empty or malformed list.
// The MPC Live boots with isolcpus=2-3, keeping cores 2 and 3 free of other work.
inline int highest_isolated_cpu(const char* text) {
  int best = -1;
  const char* p = text;
  while (p && *p && *p != '\n') {
    char* end = nullptr;
    long first = std::strtol(p, &end, 10);
    if (end == p || first < 0 || first > 1023) return -1;
    long last = first;
    p = end;
    if (*p == '-') {
      last = std::strtol(p + 1, &end, 10);
      if (end == p + 1 || last < first || last > 1023) return -1;
      p = end;
    }
    if (last > best) best = static_cast<int>(last);
    if (*p == ',') ++p;
    else if (*p && *p != '\n') return -1;
  }
  return best;
}

// Promote the calling thread for a periodic audio callback. Call once, before
// the render loop and outside any audited callback. Never throws.
RealtimeResult promote_audio_thread(std::uint64_t period_ns);

const char* scheduling_name(RealtimeScheduling scheduling);

}  // namespace xmp
