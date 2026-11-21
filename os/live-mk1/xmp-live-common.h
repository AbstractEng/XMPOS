/* Shared by the XMP probe and the XMP loader for the MPC Live Mk1 (both run as
 * PID 1 from an initramfs under Akai's kernel). Define XMP_TAG before including.
 * Internal storage (eMMC ff0f0000, internal SD ff0c0000) is never a candidate. */
#pragma once
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <linux/fb.h>
#include <linux/input.h>
#include <poll.h>
#include <sys/reboot.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define MAX_FILE 65536
#define EMMC_CONTROLLER "ff0f0000"
#define INTERNAL_SD_CONTROLLER "ff0c0000"

static char path_buffer[4096];

static inline int read_file(const char *path, char *out, size_t size) {
  int fd = open(path, O_RDONLY | O_CLOEXEC);
  if (fd < 0) return -1;
  ssize_t total = 0, got;
  while ((size_t)total < size - 1 && (got = read(fd, out + total, size - 1 - (size_t)total)) > 0) total += got;
  close(fd);
  out[total] = 0;
  return (int)total;
}

/* Whole-device sysfs path, e.g. /sys/block/mmcblk0 -> .../ff0f0000.mmc/...
 * The internal eMMC and the internal SD card are both protected. */
static inline int on_emmc(const char *block) {
  char link[1024], target[1024];
  snprintf(link, sizeof link, "/sys/block/%s", block);
  ssize_t n = readlink(link, target, sizeof target - 1);
  if (n < 0) return 1; /* unknown devices are treated as protected */
  target[n] = 0;
  return strstr(target, EMMC_CONTROLLER) != NULL || strstr(target, INTERNAL_SD_CONTROLLER) != NULL;
}

/* FAT volume label from the boot sector of a partition (FAT32 at 0x47, FAT16 at 0x2B). */
static inline int fat_label_is(const char *dev, const char *label) {
  unsigned char sector[512];
  int fd = open(dev, O_RDONLY | O_CLOEXEC);
  if (fd < 0) return 0;
  ssize_t n = read(fd, sector, sizeof sector);
  close(fd);
  if (n != 512 || sector[510] != 0x55 || sector[511] != 0xAA) return 0;
  /* The label field is 11 bytes, padded with spaces: compare it exactly. */
  char want[11];
  size_t len = strlen(label);
  if (len > sizeof want) return 0;
  memset(want, ' ', sizeof want);
  memcpy(want, label, len);
  return memcmp(sector + 0x47, want, sizeof want) == 0 || memcmp(sector + 0x2B, want, sizeof want) == 0;
}

/* Find /dev/<part> with this FAT label on a block device that is not internal storage. */
static inline int find_fat_partition(const char *label, char *out, size_t size) {
  DIR *blocks = opendir("/sys/block");
  if (!blocks) return 0;
  struct dirent *b;
  int found = 0;
  while (!found && (b = readdir(blocks))) {
    if (b->d_name[0] == '.' || strncmp(b->d_name, "loop", 4) == 0 || strncmp(b->d_name, "ram", 3) == 0) continue;
    if (on_emmc(b->d_name)) {
      printf(XMP_TAG " skip protected block device %s\n", b->d_name);
      continue;
    }
    char dir[512];
    snprintf(dir, sizeof dir, "/sys/block/%s", b->d_name);
    DIR *parts = opendir(dir);
    if (!parts) continue;
    struct dirent *p;
    while ((p = readdir(parts))) {
      if (strncmp(p->d_name, b->d_name, strlen(b->d_name)) != 0) continue;
      char dev[300];
      snprintf(dev, sizeof dev, "/dev/%s", p->d_name);
      if (fat_label_is(dev, label)) {
        snprintf(out, size, "%s", dev);
        found = 1;
        break;
      }
    }
    closedir(parts);
  }
  closedir(blocks);
  return found;
}

/* ---- visible status: screen colour via /dev/fb0, plus the board LEDs ---- */
static inline void write_text(const char *path, const char *value) {
  int fd = open(path, O_WRONLY | O_CLOEXEC);
  if (fd < 0) return;
  ssize_t ignored = write(fd, value, strlen(value));
  (void)ignored;
  close(fd);
}

static inline void led(const char *name, const char *trigger, int on) {
  char path[160];
  snprintf(path, sizeof path, "/sys/class/leds/%s/trigger", name);
  write_text(path, trigger);
  if (strcmp(trigger, "none") == 0) {
    snprintf(path, sizeof path, "/sys/class/leds/%s/brightness", name);
    write_text(path, on ? "1" : "0");
  } else if (strcmp(trigger, "timer") == 0) {
    snprintf(path, sizeof path, "/sys/class/leds/%s/delay_on", name);
    write_text(path, "100");
    snprintf(path, sizeof path, "/sys/class/leds/%s/delay_off", name);
    write_text(path, "100");
  }
}

static inline void show(unsigned red, unsigned green, unsigned blue) {
  static int waited;
  int fd = -1;
  /* The first call gives the display driver up to 15 s to bring up the panel. */
  for (int attempt = 0; (fd = open("/dev/fb0", O_RDWR | O_CLOEXEC)) < 0 && !waited && attempt < 30; attempt++)
    usleep(500000);
  waited = 1;
  if (fd < 0) return;
  struct fb_var_screeninfo var;
  struct fb_fix_screeninfo fix;
  if (ioctl(fd, FBIOGET_VSCREENINFO, &var) != 0 || ioctl(fd, FBIOGET_FSCREENINFO, &fix) != 0 ||
      (var.bits_per_pixel != 32 && var.bits_per_pixel != 16)) {
    close(fd);
    return;
  }
  size_t size = (size_t)fix.line_length * var.yres;
  unsigned char *fb = mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
  if (fb == MAP_FAILED) {
    close(fd);
    return;
  }
  for (unsigned y = 0; y < var.yres; y++) {
    unsigned char *row = fb + (size_t)y * fix.line_length;
    for (unsigned x = 0; x < var.xres; x++) {
      if (var.bits_per_pixel == 32) {
        unsigned value = (red >> (8 - var.red.length)) << var.red.offset |
                         (green >> (8 - var.green.length)) << var.green.offset |
                         (blue >> (8 - var.blue.length)) << var.blue.offset;
        memcpy(row + x * 4, &value, 4);
      } else {
        unsigned short value = (unsigned short)((red >> 3) << 11 | (green >> 2) << 5 | (blue >> 3));
        memcpy(row + x * 2, &value, 2);
      }
    }
  }
  munmap(fb, size);
  close(fd);
}

/* Final state: keep the result on screen and wait for the owner to power off. */
/* The Live's power button is a GPIO key (KEY_POWER) that only software acts on;
 * the PMIC (ACT8846) has no hold-to-switch-off. Akai's az01-pwrbtn does this in
 * the stock system, so the probe must too, or the unit (which has a battery)
 * can only be switched off by draining it. Power-off never restarts the unit,
 * so it cannot cause a boot loop. */
#define POWER_OFF_AFTER_SECONDS 600

static inline void power_off(const char *why) {
  printf(XMP_TAG " powering off (%s)\n", why);
  fflush(stdout);
  sync();
  reboot(RB_POWER_OFF);
}

static inline void halt_showing(const char *outcome, unsigned r, unsigned g, unsigned b) {
  show(r, g, b);
  printf(XMP_TAG " %s; halted (press the power button to switch off)\n", outcome);
  fflush(stdout);
  sync();
  struct pollfd keys[16];
  int count = 0;
  DIR *dir = opendir("/dev/input");
  struct dirent *e;
  while (dir && count < 16 && (e = readdir(dir))) {
    if (strncmp(e->d_name, "event", 5) != 0) continue;
    snprintf(path_buffer, sizeof path_buffer, "/dev/input/%s", e->d_name);
    int fd = open(path_buffer, O_RDONLY | O_NONBLOCK | O_CLOEXEC);
    if (fd >= 0) keys[count++] = (struct pollfd){.fd = fd, .events = POLLIN};
  }
  if (dir) closedir(dir);
  time_t deadline = time(NULL) + POWER_OFF_AFTER_SECONDS;
  for (;;) {
    int left = (int)(deadline - time(NULL));
    if (left <= 0) power_off("timeout");
    if (poll(keys, (nfds_t)count, left * 1000) <= 0) continue;
    for (int i = 0; i < count; i++) {
      struct input_event event;
      while (read(keys[i].fd, &event, sizeof event) == (ssize_t)sizeof event)
        if (event.type == EV_KEY && event.code == KEY_POWER && event.value == 1) power_off("power button");
    }
  }
}

