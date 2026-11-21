/* /sbin/init of the XMP session system image (xmp/system.img on the owner's
 * USB stick), started by the XMP stick loader on the MPC Live Mk1 (AGENTS.md,
 * "Device-specific authorization 2"). The loader has already mounted the image
 * read-only under a RAM overlay and moved the stick to /media/xmp.
 *
 * It makes the stick writable (the only writable storage XMP uses), picks a new
 * log file there, runs the session program, and switches off when it ends. If
 * the session fails it shows red and switches off at the power button or after
 * 10 minutes. It mounts nothing else and never touches internal storage. */
#define XMP_TAG "XMP-SESSION"
#include "xmp-live-common.h"
#include "boot-screen.h"
#include <signal.h>
#include "image-update.h"

#define STICK "/media/xmp"
#define SESSION "/usr/lib/xmp/xmp-live-session"
#define BRIDGE "/usr/lib/xmp/xmp-bridge"
#define FALLBACK_MARKER STICK "/xmp/.fallback-tried"

/* A partition's sysfs path names its controller, e.g. .../ff0f0000.mmc/.../mmcblk0p1.
 * Unknown devices count as internal storage. */
static int on_internal_storage(const char *name) {
  char link[256], target[1024];
  snprintf(link, sizeof link, "/sys/class/block/%s", name);
  ssize_t n = readlink(link, target, sizeof target - 1);
  if (n < 0) return 1;
  target[n] = 0;
  return strstr(target, EMMC_CONTROLLER) != NULL || strstr(target, INTERNAL_SD_CONTROLLER) != NULL;
}

/* The stick must be the vfat mount the loader moved to /media/xmp, from a
 * device that is not internal storage. */
static int stick_is_the_usb_drive(void) {
  static char mounts[MAX_FILE];
  if (read_file("/proc/mounts", mounts, sizeof mounts) < 0) return 0;
  for (char *line = strtok(mounts, "\n"); line; line = strtok(NULL, "\n")) {
    char dev[128], dir[128], type[32];
    if (sscanf(line, "%127s %127s %31s", dev, dir, type) != 3) continue;
    if (strcmp(dir, STICK) != 0) continue;
    if (strcmp(type, "vfat") != 0 || strncmp(dev, "/dev/", 5) != 0) return 0;
    return strchr(dev + 5, '/') == NULL && !on_internal_storage(dev + 5);
  }
  return 0;
}

/* Ends a helper process: SIGTERM, then SIGKILL if it has not exited within
 * 2 s (a helper blocked in a restarted read would otherwise hold up power-off). */
static void stop_child(pid_t pid) {
  kill(pid, SIGTERM);
  for (int i = 0; i < 20; ++i) {
    if (waitpid(pid, NULL, WNOHANG) == pid) return;
    usleep(100000);
  }
  kill(pid, SIGKILL);
  waitpid(pid, NULL, 0);
}

int main(void) {
  /* The loader moved these; mounting again only matters when started another way. */
  mount("proc", "/proc", "proc", MS_NOSUID | MS_NODEV | MS_NOEXEC, NULL);
  mount("sysfs", "/sys", "sysfs", MS_NOSUID | MS_NODEV | MS_NOEXEC, NULL);
  mount("devtmpfs", "/dev", "devtmpfs", MS_NOSUID, NULL);
  printf(XMP_TAG " init begin\n");
  fflush(stdout);
  char compatible[1024];
  const int compatible_bytes = read_file("/proc/device-tree/compatible", compatible, sizeof compatible);
#ifdef XMP_SESSION_EMULATOR
  const int emulator = 1;
#else
  const int emulator = 0;
#endif
  if (compatible_bytes <= 0 ||
      !xmp_boot_board_allowed(compatible, (size_t)compatible_bytes, emulator)) {
    printf(XMP_TAG " refused unsupported/protected board before framebuffer access\n");
    fflush(stdout);
    for (;;) pause();
  }
  if (show_boot_screen()) printf(XMP_TAG " boot screen: Emerald Current\n");
  else {
    printf(XMP_TAG " boot screen unavailable; using emerald fallback\n");
    show(7, 17, 13);
  }
  fflush(stdout);

  if (!stick_is_the_usb_drive()) halt_showing("the XMP stick is not mounted at " STICK, 200, 0, 0);
  if (mount(NULL, STICK, NULL, MS_REMOUNT | MS_NOSUID | MS_NODEV | MS_NOEXEC, NULL) != 0)
    halt_showing("could not make the XMP stick writable", 200, 0, 0);
  mkdir(STICK "/xmp/logs", 0755);

  struct stat st;
#ifdef XMP_SESSION_EMULATOR
  /* Emulator image only: the Live twin presents the Live's controller and
   * touchscreen as USB gadgets before the session starts. */
  pid_t twin = -1;
  if (stat("/usr/lib/xmp/xmp-live-twin", &st) == 0) {
    twin = fork();
    if (twin == 0) {
      execl("/usr/lib/xmp/xmp-live-twin", "xmp-live-twin", "--script", STICK "/xmp/twin-script.txt", "--out",
            STICK "/xmp/twin", (char *)NULL);
      _exit(127);
    }
    for (int i = 0; i < 300 && stat("/tmp/xmp-twin-ready", &st) != 0; i++) usleep(100000);
  }
#define BRIDGE_UDC "dummy_udc.2"
#else
#define BRIDGE_UDC "none"
#endif

  /* The control bridge (AGENTS.md authorizations 3 and 4) runs alongside every
   * session and survives session restarts. */
  pid_t bridge = -1;
  if (stat(BRIDGE, &st) == 0) {
    bridge = fork();
    if (bridge == 0) {
      execl(BRIDGE, "xmp-bridge", "--udc", BRIDGE_UDC, "--stick", STICK, (char *)NULL);
      _exit(127);
    }
  }

  int status = 0;
  for (;;) {
    char log[160];
    int number = 1;
    for (; number < 1000; number++) {
      snprintf(log, sizeof log, STICK "/xmp/logs/session-%03d.txt", number);
      if (stat(log, &st) != 0) break;
    }
    if (number >= 1000) snprintf(log, sizeof log, STICK "/xmp/logs/session-latest.txt");
    printf(XMP_TAG " log %s\n", log);
    fflush(stdout);
    pid_t child = fork();
    if (child == 0) {
      execl(SESSION, SESSION, "--log", log, "--conf", STICK "/xmp/session.conf", "--pattern",
            STICK "/xmp/pattern.txt", (char *)NULL);
      _exit(127);
    }
    for (;;) {
      pid_t done = wait(&status);
      if (done == child) break;
      if (done == bridge) bridge = -1; /* the bridge ended (no USB controller); the session goes on */
      if (done < 0 && errno == ECHILD) break;
    }
    const int code = WIFEXITED(status) ? WEXITSTATUS(status) : -1;
    /* Fallback is reset only by a verified image promotion, never by elapsed time. */
    if (code == 10) {
      printf(XMP_TAG " restarting the session\n");
      continue;
    }
    break;
  }
  const int code = WIFEXITED(status) ? WEXITSTATUS(status) : -1;
#ifdef XMP_SESSION_EMULATOR
  if (twin > 0) stop_child(twin);
#endif
  if (bridge > 0) stop_child(bridge);
  sync();
  if (code == 0 || code == 11) {
    umount2(STICK, 0);
    sync();
    if (code == 11) {
      /* Restart the unit (U-Boot, XMP's boot script, the stick loader) to boot a pushed image. */
      printf(XMP_TAG " restarting the unit to start the new system image\n");
      fflush(stdout);
      reboot(RB_AUTOBOOT);
    }
    power_off("session ended");
  }
  /* A failed session falls back once to the previous system image, if there is one. */
  if (stat(STICK "/xmp/system.img.previous", &st) == 0 && stat(FALLBACK_MARKER, &st) != 0) {
    int dir = open(STICK "/xmp", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    int restored = dir >= 0 && xmp_fallback_image(dir) == 0;
    if (dir >= 0 && close(dir)) restored = 0;
    if (!restored || umount2(STICK, 0)) {
      halt_showing("image restore failed; recover USB stick on Mac", 200, 0, 0);
      return 1;
    }
    printf(XMP_TAG " session failed (status %d); restarting with the previous system image\n", status);
    fflush(stdout);
    reboot(RB_AUTOBOOT);
  }
  char why[80];
  snprintf(why, sizeof why, "session failed (status %d)", status);
  halt_showing(why, 200, 0, 0);
  return 1;
}
