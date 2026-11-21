/* XMP hardware probe (v3) for the MPC Live Mk1. It runs in one of two ways:
 *
 * - Probe mode: PID 1 in a RAM-only initramfs, started by the XMP boot script.
 *   It shows its progress on screen and halts (below).
 * - Report mode: an ordinary systemd service inside Akai's own system, for when
 *   U-Boot falls back to the stock boot. It writes the same report (including
 *   /proc/cmdline, which says which boot path ran and why) and exits. It never
 *   touches the screen or LEDs, which belong to the MPC app there.
 *
 * In probe mode it reads hardware facts and writes them to a FAT partition labelled XMPPROBE
 * on removable media, then halts and shows its result on the screen (and the
 * board LEDs): blue = running, green = report written, red = no XMPPROBE
 * drive found, yellow = drive found but writing failed. It never powers off or
 * restarts by itself, so it cannot fall into a restart loop; the owner holds
 * the power button to switch the unit off. It never mounts, opens for writing or
 * otherwise touches the internal eMMC (controller ff0f0000): block devices on
 * that controller are refused by path before anything else happens. Nothing
 * is written anywhere except the XMPPROBE partition.
 */
#define XMP_TAG "XMP-PROBE"
#include "xmp-live-common.h"

static const char *REPORT_DIR = "/report";
static int service_mode; /* not PID 1: running inside the stock system */
static FILE *report;

static void section(const char *name) { fprintf(report, "\n===== %s\n", name); }

static void put_file(const char *name, const char *path) {
  static char buffer[MAX_FILE];
  section(name);
  int n = read_file(path, buffer, sizeof buffer);
  if (n < 0) {
    fprintf(report, "(missing: %s, errno %d)\n", path, errno);
    return;
  }
  for (int i = 0; i < n; i++) fputc(buffer[i] ? buffer[i] : ' ', report);
  fputc('\n', report);
}

static void put_listing(const char *name, const char *dir_path) {
  section(name);
  DIR *dir = opendir(dir_path);
  if (!dir) {
    fprintf(report, "(missing: %s)\n", dir_path);
    return;
  }
  struct dirent *e;
  while ((e = readdir(dir)))
    if (e->d_name[0] != '.') fprintf(report, "%s\n", e->d_name);
  closedir(dir);
}

static void put_command(const char *name, char *const argv[]) {
  if (access(argv[0], X_OK) != 0) return; /* tool not present in this system */
  section(name);
  fflush(report);
  int pipefd[2];
  if (pipe(pipefd) != 0) return;
  pid_t child = fork();
  if (child == 0) {
    dup2(pipefd[1], 1);
    dup2(pipefd[1], 2);
    close(pipefd[0]);
    char *const envp[] = {"PATH=/opt/g1/bin", "ALSA_CONFIG_DIR=/opt/g1/share/alsa", NULL};
    execve(argv[0], argv, envp);
    _exit(127);
  }
  close(pipefd[1]);
  char buffer[4096];
  ssize_t n;
  while ((n = read(pipefd[0], buffer, sizeof buffer)) > 0) fwrite(buffer, 1, (size_t)n, report);
  close(pipefd[0]);
  int status = 0;
  waitpid(child, &status, 0);
  fprintf(report, "(exit %d)\n", WIFEXITED(status) ? WEXITSTATUS(status) : -1);
}

/* Power supplies: type, online, capacity, voltage for every entry. */
static void put_power(void) {
  section("power supplies");
  DIR *dir = opendir("/sys/class/power_supply");
  if (!dir) return;
  struct dirent *e;
  while ((e = readdir(dir))) {
    if (e->d_name[0] == '.') continue;
    const char *fields[] = {"type", "online", "status", "capacity", "voltage_now", "model_name", "technology"};
    for (size_t i = 0; i < sizeof fields / sizeof fields[0]; i++) {
      char value[256];
      snprintf(path_buffer, sizeof path_buffer, "/sys/class/power_supply/%s/%s", e->d_name, fields[i]);
      if (read_file(path_buffer, value, sizeof value) >= 0) {
        value[strcspn(value, "\n")] = 0;
        fprintf(report, "%s.%s=%s\n", e->d_name, fields[i], value);
      }
    }
  }
  closedir(dir);
}

/* Kernel log, read non-blocking from /dev/kmsg (read-only). */
static void put_kmsg(void) {
  section("kernel log");
  int fd = open("/dev/kmsg", O_RDONLY | O_NONBLOCK | O_CLOEXEC);
  if (fd < 0) {
    fprintf(report, "(kmsg unavailable, errno %d)\n", errno);
    return;
  }
  char record[2048];
  ssize_t n;
  size_t total = 0;
  while ((n = read(fd, record, sizeof record - 1)) > 0 || (n < 0 && errno == EPIPE)) {
    if (n <= 0) continue; /* EPIPE: a record was overwritten; keep reading */
    record[n] = 0;
    char *text = strchr(record, ';');
    fputs(text ? text + 1 : record, report);
    total += (size_t)n;
    if (total > 4u * 1024u * 1024u) break;
  }
  close(fd);
}

/* In report mode a failure just ends the service; in probe mode it halts on screen. */
static int finish(const char *outcome, unsigned r, unsigned g, unsigned b) {
  if (service_mode) {
    printf("XMP-PROBE report mode: %s\n", outcome);
    fflush(stdout);
    return strncmp(outcome, "end", 3) == 0 ? 0 : 1;
  }
  halt_showing(outcome, r, g, b);
  return 0;
}

int main(void) {
  service_mode = getpid() != 1;
  if (service_mode) {
    REPORT_DIR = "/run/xmp-probe";
  } else {
    mount("proc", "/proc", "proc", 0, NULL);
    mount("sysfs", "/sys", "sysfs", 0, NULL);
    mount("devtmpfs", "/dev", "devtmpfs", 0, NULL);
    /* Emulator self-test only: run report mode as an ordinary child process,
     * exactly as systemd would start it, then halt. Never set on the Live. */
    char cmdline[1024] = {0};
    if (read_file("/proc/cmdline", cmdline, sizeof cmdline) > 0 && strstr(cmdline, "xmp.selftest=report")) {
      mkdir("/run", 0755);
      pid_t child = fork();
      if (child == 0) {
        execl("/init", "xmp-probe-report", (char *)NULL);
        _exit(127);
      }
      int status = 0;
      waitpid(child, &status, 0);
      printf("XMP-PROBE selftest: report mode exited %d; halted\n", WIFEXITED(status) ? WEXITSTATUS(status) : -1);
      fflush(stdout);
      for (;;) pause();
    }
  }
  printf("XMP-PROBE begin (%s mode)\n", service_mode ? "report" : "probe");
  if (!service_mode) {
    led("az01:red:usr1", "heartbeat", 1);
    led("az01:red:usr2", "none", 0);
    show(0, 0, 255); /* blue: running, looking for the XMPPROBE drive */
  }
  /* USB storage behind the Live's internal hub enumerates asynchronously: wait up
   * to 60 s in probe mode, 180 s in report mode (the stock system boots slower). */
  char device[300] = {0};
  int attempts = service_mode ? 360 : 120;
  for (int attempt = 0; attempt < attempts && !find_fat_partition("XMPPROBE", device, sizeof device); attempt++)
    usleep(500000);
  if (!device[0]) {
    if (!service_mode) led("az01:red:usr2", "timer", 1);
    return finish("no XMPPROBE partition found, nothing written", 255, 0, 0);
  }
  mkdir(REPORT_DIR, 0700);
  if (mount(device, REPORT_DIR, "vfat", MS_NOSUID | MS_NODEV | MS_NOEXEC, "utf8=1") != 0) {
    printf("XMP-PROBE cannot mount %s (errno %d)\n", device, errno);
    return finish("mount failed", 255, 255, 0);
  }
  char name[160];
  snprintf(name, sizeof name, "%s/xmp-%s-%ld.txt", REPORT_DIR, service_mode ? "stock-boot" : "probe",
           (long)time(NULL));
  report = fopen(name, "w");
  if (report) {
    fprintf(report, "XMP hardware probe report (%s mode)\nwritten to %s\n",
            service_mode ? "report: Akai's system booted, see cmdline for why" : "probe", device);
    put_file("kernel", "/proc/version");
    put_file("cmdline", "/proc/cmdline");
    put_file("realtime", "/sys/kernel/realtime");
    put_file("model", "/proc/device-tree/model");
    put_file("compatible (board revision: rockchip,rk3288-c means RK3288-C)", "/proc/device-tree/compatible");
    put_file("product code", "/proc/device-tree/inmusic,product-code");
    put_file("cpuinfo", "/proc/cpuinfo");
    put_file("meminfo", "/proc/meminfo");
    put_file("block devices", "/proc/partitions");
    put_file("sound cards", "/proc/asound/cards");
    put_file("mounts", "/proc/mounts");
    /* Formats, rates and channels each USB audio card offers, and raw MIDI ports. */
    for (int card = 0; card < 8; card++) {
      char label[64], file[64];
      const char *parts[] = {"stream0", "midi0", "usbid"};
      for (size_t i = 0; i < sizeof parts / sizeof parts[0]; i++) {
        snprintf(file, sizeof file, "/proc/asound/card%d/%s", card, parts[i]);
        if (access(file, R_OK) != 0) continue;
        snprintf(label, sizeof label, "card%d %s", card, parts[i]);
        put_file(label, file);
      }
    }
    put_listing("input devices", "/sys/class/input");
    put_listing("drm connectors", "/sys/class/drm");
    put_listing("leds", "/sys/class/leds");
    put_listing("usb devices", "/sys/bus/usb/devices");
    put_power();
    put_command("aplay -l", (char *const[]){"/opt/g1/bin/aplay", "-l", NULL});
    put_command("amixer", (char *const[]){"/opt/g1/bin/amixer", "scontrols", NULL});
    put_command("gpiodetect", (char *const[]){"/opt/g1/bin/gpiodetect", NULL});
    put_command("gpioinfo", (char *const[]){"/opt/g1/bin/gpioinfo", NULL});
    put_command("usb device list", (char *const[]){"/opt/g1/bin/listdevs", NULL});
    put_kmsg();
    fprintf(report, "\nXMP-PROBE end\n");
    fflush(report);
    fsync(fileno(report));
    fclose(report);
    printf("XMP-PROBE wrote %s\n", name);
  }
  sync();
  umount(REPORT_DIR);
  sync();
  if (!report) return finish("report could not be created", 255, 255, 0);
  if (!service_mode) led("az01:red:usr2", "none", 1);
  return finish("end: report written", 0, 255, 0);
}
