#include "xmp/rt_thread.hpp"

#include <pthread.h>

#include <cstdio>

#if defined(__APPLE__)
#include <mach/mach.h>
#include <mach/mach_time.h>
#include <mach/thread_policy.h>
#elif defined(__linux__)
#include <sched.h>
#include <sys/mman.h>
#endif

namespace xmp {

RealtimeResult promote_audio_thread(std::uint64_t period_ns) {
  RealtimeResult result;
#if defined(__APPLE__)
  mach_timebase_info_data_t timebase{};
  if (mach_timebase_info(&timebase) != KERN_SUCCESS || timebase.numer == 0) return result;
  const auto to_abs = [&](std::uint64_t ns) {
    return static_cast<std::uint32_t>(ns * timebase.denom / timebase.numer);
  };
  // Period = one block; computation = 40% of it (the render needs far less);
  // constraint = the whole block, as for CoreAudio I/O threads.
  thread_time_constraint_policy_data_t policy{};
  policy.period = to_abs(period_ns);
  policy.computation = to_abs(period_ns * 2 / 5);
  policy.constraint = to_abs(period_ns);
  policy.preemptible = TRUE;
  if (thread_policy_set(pthread_mach_thread_np(pthread_self()), THREAD_TIME_CONSTRAINT_POLICY,
                        reinterpret_cast<thread_policy_t>(&policy),
                        THREAD_TIME_CONSTRAINT_POLICY_COUNT) == KERN_SUCCESS)
    result.scheduling = RealtimeScheduling::MachTimeConstraint;
#elif defined(__linux__)
  (void)period_ns;
  sched_param param{};
  const int maximum = sched_get_priority_max(SCHED_FIFO);
  param.sched_priority = maximum > 80 ? 80 : maximum;
  if (param.sched_priority > 0 && pthread_setschedparam(pthread_self(), SCHED_FIFO, &param) == 0)
    result.scheduling = RealtimeScheduling::SchedFifo;
  result.memoryLocked = mlockall(MCL_CURRENT | MCL_FUTURE) == 0;
  // Prefer a core the kernel keeps free of other work (isolcpus), if any.
  if (FILE* isolated = std::fopen("/sys/devices/system/cpu/isolated", "r")) {
    char text[128] = {0};
    const bool read = std::fgets(text, sizeof text, isolated) != nullptr;
    std::fclose(isolated);
    const int cpu = read ? highest_isolated_cpu(text) : -1;
    if (cpu >= 0 && cpu < CPU_SETSIZE) {
      cpu_set_t set;
      CPU_ZERO(&set);
      CPU_SET(cpu, &set);
      if (pthread_setaffinity_np(pthread_self(), sizeof set, &set) == 0) result.pinnedCpu = cpu;
    }
  }
#else
  (void)period_ns;
#endif
  return result;
}

const char* scheduling_name(RealtimeScheduling scheduling) {
  switch (scheduling) {
    case RealtimeScheduling::MachTimeConstraint:
      return "mach-time-constraint";
    case RealtimeScheduling::SchedFifo:
      return "sched-fifo";
    case RealtimeScheduling::None:
      break;
  }
  return "none";
}

}  // namespace xmp
