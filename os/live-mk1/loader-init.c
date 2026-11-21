/* XMP stick loader for the MPC Live Mk1: PID 1 in a small initramfs, started by
 * XMP's two-part boot.scr.uimg under Akai's own kernel.
 *
 * - If a FAT drive labelled XMP (or XMPPROBE) holds xmp/system.img, it starts
 *   that XMP system: the image is loop-mounted read-only with a RAM overlay on
 *   top, and the drive itself is moved to /media/xmp for the system to use.
 * - Otherwise it hands over to Akai's system. It mounts exactly the partition
 *   the kernel command line names as root= (PARTUUID), read-only and without
 *   journal replay (ro,noload), and runs Akai's /sbin/init, as a stock boot
 *   would (AGENTS.md, "Stick loader handover").
 *
 * It never writes to internal storage, and the internal eMMC and SD card are
 * never stick candidates. A failure shows red on the screen; the power button
 * then switches the unit off (and it switches off by itself after 10 minutes).
 */
#define XMP_TAG "XMP-LOADER"
#include "xmp-live-common.h"

#include <linux/loop.h>

#define STICK "/stick"
#define LOWER "/lower"
#define RW "/rw"
#define NEWROOT "/newroot"
#define STICK_WAIT_HALF_SECONDS 16 /* 8 s: the USB stick enumerates in a few seconds */
#define ROOT_WAIT_HALF_SECONDS 20

static int contains_word(const char *text, const char *word) { return strstr(text, word) != NULL; }

/* Board check: the Live, or QEMU's virt board for the emulator tests. */
static int board(int *qemu) {
  char compatible[512] = {0};
  int n = read_file("/proc/device-tree/compatible", compatible, sizeof compatible);
  for (int i = 0; i < n; i++)
    if (!compatible[i]) compatible[i] = ' ';
  *qemu = contains_word(compatible, "linux,dummy-virt");
  int live = contains_word(compatible, "inmusic,acv8");
  if (contains_word(compatible, "force") || contains_word(compatible, "ada2")) return 0;
  return live || *qemu;
}

/* Moves /proc, /sys and /dev into the new root and executes its /sbin/init. */
static void switch_root(const char *why) {
  const char *mounts[] = {"/proc", "/sys", "/dev"};
  for (size_t i = 0; i < 3; i++) {
    char target[64];
    snprintf(target, sizeof target, NEWROOT "%s", mounts[i]);
    if (mount(mounts[i], target, NULL, MS_MOVE, NULL) != 0)
      printf(XMP_TAG " cannot move %s (errno %d)\n", mounts[i], errno);
  }
  printf(XMP_TAG " %s\n", why);
  fflush(stdout);
  if (chdir(NEWROOT) != 0 || mount(".", "/", NULL, MS_MOVE, NULL) != 0 || chroot(".") != 0 || chdir("/") != 0) {
    printf(XMP_TAG " switch_root failed (errno %d)\n", errno);
    return;
  }
  execl("/sbin/init", "/sbin/init", (char *)NULL);
  printf(XMP_TAG " /sbin/init failed (errno %d)\n", errno);
}

/* Read-only loop device for a file; returns the /dev/loopN path in out and an
 * open descriptor (or -1). Keep it open until the mount holds the device:
 * LO_FLAGS_AUTOCLEAR detaches the file as soon as the last descriptor closes. */
static int loop_attach(const char *file, char *out, size_t size) {
  int control = open("/dev/loop-control", O_RDWR | O_CLOEXEC);
  if (control < 0) return -1;
  int number = ioctl(control, LOOP_CTL_GET_FREE);
  close(control);
  if (number < 0) return -1;
  snprintf(out, size, "/dev/loop%d", number);
  int loop = open(out, O_RDONLY | O_CLOEXEC);
  int backing = open(file, O_RDONLY | O_CLOEXEC);
  int ok = loop >= 0 && backing >= 0 && ioctl(loop, LOOP_SET_FD, backing) == 0;
  if (ok) {
    struct loop_info64 info;
    memset(&info, 0, sizeof info);
    info.lo_flags = LO_FLAGS_READ_ONLY | LO_FLAGS_AUTOCLEAR;
    ok = ioctl(loop, LOOP_SET_STATUS64, &info) == 0;
  }
  if (backing >= 0) close(backing);
  if (!ok && loop >= 0) {
    close(loop);
    loop = -1;
  }
  return ok ? loop : -1;
}

/* The XMP system on the stick; returns only on failure (stick unmounted again). */
static void start_xmp_system(const char *stick) {
  show(0, 0, 255);
  char loop[64];
  mkdir(LOWER, 0755);
  mkdir(RW, 0755);
  mkdir(NEWROOT, 0755);
  int held = loop_attach(STICK "/xmp/system.img", loop, sizeof loop);
  int mounted = held >= 0 && mount(loop, LOWER, "ext4", MS_RDONLY | MS_NOSUID | MS_NODEV, "noload") == 0;
  int error = errno;
  if (held >= 0) close(held); /* the mount now holds the loop device */
  if (!mounted) {
    printf(XMP_TAG " cannot mount xmp/system.img from %s (errno %d)\n", stick, error);
    umount(STICK);
    return;
  }
  struct stat init;
  if (lstat(LOWER "/sbin/init", &init) != 0 || mount("tmpfs", RW, "tmpfs", 0, "mode=0755") != 0 ||
      mkdir(RW "/upper", 0755) != 0 || mkdir(RW "/work", 0755) != 0 ||
      mount("overlay", NEWROOT, "overlay", 0, "lowerdir=" LOWER ",upperdir=" RW "/upper,workdir=" RW "/work") != 0) {
    printf(XMP_TAG " XMP system image has no /sbin/init or the overlay failed (errno %d)\n", errno);
    umount(LOWER);
    umount(STICK);
    return;
  }
  mkdir(NEWROOT "/media", 0755);
  mkdir(NEWROOT "/media/xmp", 0755);
  if (mount(STICK, NEWROOT "/media/xmp", NULL, MS_MOVE, NULL) != 0)
    printf(XMP_TAG " stick stays at " STICK " (errno %d)\n", errno);
  printf(XMP_TAG " system image %s on %s\n", loop, stick);
  switch_root("starting the XMP system from the stick");
}

/* root=PARTUUID=<uuid> from the kernel command line. */
static int root_partuuid(char *out, size_t size) {
  char cmdline[2048] = {0};
  if (read_file("/proc/cmdline", cmdline, sizeof cmdline) <= 0) return 0;
  const char *at = strstr(cmdline, "root=PARTUUID=");
  if (!at) return 0;
  at += strlen("root=PARTUUID=");
  size_t n = strcspn(at, " \n");
  if (n == 0 || n >= size) return 0;
  memcpy(out, at, n);
  out[n] = 0;
  for (size_t i = 0; i < n; i++)
    if (out[i] >= 'A' && out[i] <= 'Z') out[i] = (char)(out[i] - 'A' + 'a');
  return 1;
}

/* The partition whose uevent says PARTUUID=<uuid>; on the Live it must be on the eMMC. */
static int find_root(const char *uuid, int qemu, char *out, size_t size) {
  DIR *dir = opendir("/sys/class/block");
  if (!dir) return 0;
  struct dirent *e;
  int found = 0;
  char want[160];
  snprintf(want, sizeof want, "PARTUUID=%s\n", uuid);
  while (!found && (e = readdir(dir))) {
    if (e->d_name[0] == '.') continue;
    char uevent[1024] = {0}, link[1024] = {0};
    snprintf(path_buffer, sizeof path_buffer, "/sys/class/block/%s/uevent", e->d_name);
    if (read_file(path_buffer, uevent, sizeof uevent) <= 0) continue;
    char *line = strstr(uevent, "PARTUUID=");
    if (!line) continue;
    for (char *c = line + 9; *c && *c != '\n'; c++)
      if (*c >= 'A' && *c <= 'Z') *c = (char)(*c - 'A' + 'a');
    if (strncmp(line, want, strlen(want)) != 0) continue;
    snprintf(path_buffer, sizeof path_buffer, "/sys/class/block/%s", e->d_name);
    ssize_t n = readlink(path_buffer, link, sizeof link - 1);
    if (n < 0) continue;
    link[n] = 0;
    if (!qemu && !strstr(link, EMMC_CONTROLLER)) {
      printf(XMP_TAG " root partition %s is not on the eMMC; refusing\n", e->d_name);
      continue;
    }
    snprintf(out, size, "/dev/%s", e->d_name);
    found = 1;
  }
  closedir(dir);
  return found;
}

static void hand_over_to_stock(int qemu) {
  char uuid[128], device[300];
  if (!root_partuuid(uuid, sizeof uuid)) {
    printf(XMP_TAG " no root=PARTUUID= on the command line\n");
    return;
  }
  int found = 0;
  for (int attempt = 0; attempt < ROOT_WAIT_HALF_SECONDS && !(found = find_root(uuid, qemu, device, sizeof device));
       attempt++)
    usleep(500000);
  if (!found) {
    printf(XMP_TAG " root partition PARTUUID=%s not found\n", uuid);
    return;
  }
  mkdir(NEWROOT, 0755);
  /* Read-only, no journal replay: nothing is written to the eMMC. */
  if (mount(device, NEWROOT, "ext4", MS_RDONLY, "noload") != 0) {
    printf(XMP_TAG " cannot mount %s read-only (errno %d)\n", device, errno);
    return;
  }
  struct stat init;
  if (lstat(NEWROOT "/sbin/init", &init) != 0) {
    printf(XMP_TAG " %s has no /sbin/init\n", device);
    umount(NEWROOT);
    return;
  }
  printf(XMP_TAG " root %s mounted read-only\n", device);
  switch_root("handing over to Akai's system");
}

int main(void) {
  mount("proc", "/proc", "proc", 0, NULL);
  mount("sysfs", "/sys", "sysfs", 0, NULL);
  mount("devtmpfs", "/dev", "devtmpfs", 0, NULL);
  printf(XMP_TAG " begin\n");
  int qemu = 0;
  if (!board(&qemu)) halt_showing("not an MPC Live Mk1; refusing", 255, 0, 0);

  char stick[300] = {0};
  for (int attempt = 0; attempt < STICK_WAIT_HALF_SECONDS; attempt++) {
    if (find_fat_partition("XMP", stick, sizeof stick) || find_fat_partition("XMPPROBE", stick, sizeof stick)) break;
    stick[0] = 0;
    usleep(500000);
  }
  if (stick[0]) {
    mkdir(STICK, 0755);
    if (mount(stick, STICK, "vfat", MS_RDONLY | MS_NOSUID | MS_NODEV | MS_NOEXEC, "utf8=1") == 0) {
      if (access(STICK "/xmp/system.img", R_OK) == 0) start_xmp_system(stick);
      else {
        printf(XMP_TAG " %s has no xmp/system.img\n", stick);
        umount(STICK);
      }
    }
  } else {
    printf(XMP_TAG " no XMP stick\n");
  }
  hand_over_to_stock(qemu);
  halt_showing("could not start any system", 255, 0, 0);
  return 0;
}
