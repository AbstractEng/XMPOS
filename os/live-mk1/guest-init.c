/* XMP Live Mk1 kernel boot probe (PID 1 in a throwaway initramfs).
 *
 * Runs only inside QEMU. It reads kernel identity files, runs XMP's static
 * ARMv7 engine tests, prints framed results on the console and powers off.
 * It writes nothing persistent: the initramfs lives in RAM and no block
 * device is attached.
 */
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/reboot.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

#define MAX_FILE 16384

static void hex_line(const char *tag, const char *name, const unsigned char *data, size_t n) {
  printf("%s %s ", tag, name);
  for (size_t i = 0; i < n; i++) printf("%02x", data[i]);
  printf("\n");
  fflush(stdout);
}

static void dump(const char *path) {
  static unsigned char buffer[MAX_FILE];
  int fd = open(path, O_RDONLY | O_CLOEXEC);
  if (fd < 0) {
    printf("XMP-MISSING %s %d\n", path, errno);
    return;
  }
  size_t total = 0;
  for (;;) {
    ssize_t got = read(fd, buffer + total, sizeof buffer - total);
    if (got <= 0) break;
    total += (size_t)got;
    if (total == sizeof buffer) break;
  }
  close(fd);
  hex_line("XMP-FILE", path, buffer, total);
}

static void list(const char *path) {
  DIR *dir = opendir(path);
  if (!dir) {
    printf("XMP-MISSING %s %d\n", path, errno);
    return;
  }
  char names[2048] = {0};
  size_t used = 0;
  struct dirent *entry;
  while ((entry = readdir(dir)) && used + 66 < sizeof names) {
    if (entry->d_name[0] == '.') continue;
    used += (size_t)snprintf(names + used, sizeof names - used, "%.64s\n", entry->d_name);
  }
  closedir(dir);
  hex_line("XMP-LIST", path, (const unsigned char *)names, used);
}

static void run(const char *label, char *const argv[]) {
  int pipefd[2];
  if (pipe(pipefd) != 0) return;
  pid_t child = fork();
  if (child == 0) {
    dup2(pipefd[1], 1);
    dup2(pipefd[1], 2);
    close(pipefd[0]);
    if (chdir("/tmp") != 0) _exit(126);
    char *const envp[] = {"PATH=/opt/g1/bin:/xmp/bin", "ALSA_CONFIG_DIR=/opt/g1/share/alsa", NULL};
    execve(argv[0], argv, envp);
    _exit(127);
  }
  close(pipefd[1]);
  static unsigned char output[MAX_FILE];
  size_t total = 0;
  ssize_t got;
  while ((got = read(pipefd[0], output + total, sizeof output - total - 1)) > 0) {
    total += (size_t)got;
    if (total >= sizeof output - 1) break;
  }
  close(pipefd[0]);
  int status = 0;
  waitpid(child, &status, 0);
  printf("XMP-TEST %s %d\n", label, WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status));
  hex_line("XMP-OUTPUT", label, output, total);
}

/* USB enumeration is asynchronous; wait up to ten seconds for a USB audio card. */
static int wait_for_usb_audio(void) {
  static char cards[4096];
  for (int attempt = 0; attempt < 100; attempt++) {
    int fd = open("/proc/asound/cards", O_RDONLY | O_CLOEXEC);
    if (fd >= 0) {
      ssize_t got = read(fd, cards, sizeof cards - 1);
      close(fd);
      if (got > 0) {
        cards[got] = 0;
        if (strstr(cards, "USB-Audio")) return 1;
      }
    }
    usleep(100000);
  }
  return 0;
}

int main(void) {
  mount("proc", "/proc", "proc", 0, NULL);
  mount("sysfs", "/sys", "sysfs", 0, NULL);
  mount("devtmpfs", "/dev", "devtmpfs", 0, NULL);
  mount("tmpfs", "/tmp", "tmpfs", 0, "size=64m");
  printf("XMP-LIVE-BOOT begin\n");
  printf("XMP-USB-AUDIO %d\n", wait_for_usb_audio());
  dump("/proc/version");
  dump("/proc/cmdline");
  dump("/sys/kernel/realtime");
  dump("/proc/device-tree/model");
  dump("/proc/device-tree/compatible");
  dump("/proc/asound/cards");
  list("/sys/class/power_supply");
  list("/sys/class/sound");
  list("/sys/class/gpio");
  list("/sys/bus/usb/drivers");
  run("sampler", (char *const[]){"/xmp/bin/xmp_sampler_test", NULL});
  const char *modes[] = {"render-short", "exhaustion", "tempo", "commands", "critical", "canary"};
  for (size_t i = 0; i < sizeof modes / sizeof modes[0]; i++)
    run(modes[i], (char *const[]){"/xmp/bin/xmp_engine_test", (char *)modes[i], NULL});
  /* Hardware-facing tools built from the official G1 sources. */
  run("g1-aplay-list", (char *const[]){"/opt/g1/bin/aplay", "-l", NULL});
  run("g1-amixer", (char *const[]){"/opt/g1/bin/amixer", "-c", "0", "scontrols", NULL});
  run("g1-gpiodetect", (char *const[]){"/opt/g1/bin/gpiodetect", NULL});
  run("g1-listdevs", (char *const[]){"/opt/g1/bin/listdevs", NULL});
  run("g1-aplay-tone",
      (char *const[]){"/opt/g1/bin/aplay", "-q", "-D", "plughw:0,0", "/xmp/tone.wav", NULL});
  /* XMP's continuous engine on the G1 alsa-lib, through the kernel's USB audio driver. */
  /* 1) Timing: one voice per quarter note, light enough for an emulated CPU. */
  run("alsa-timing", (char *const[]){"/xmp/bin/xmp_alsa_engine", "--graph", "/xmp/timing.xmph", "--card", "0",
                                     "--seconds", "20", "--report", "/tmp/alsa-timing.json", NULL});
  dump("/tmp/alsa-timing.json");
  /* 2) Stress: the 32-voice development graph; emulation underruns are expected. */
  run("alsa-engine", (char *const[]){"/xmp/bin/xmp_alsa_engine", "--graph", "/xmp/engine.xmph", "--card", "0",
                                     "--seconds", "10", "--report", "/tmp/alsa-engine.json", NULL});
  dump("/tmp/alsa-engine.json");
  printf("XMP-LIVE-BOOT end\n");
  fflush(stdout);
  sync();
  reboot(RB_POWER_OFF);
  for (;;) pause();
}
