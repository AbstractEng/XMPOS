/* USB-stick image transactions. No hard links (the stick is FAT). Every
 * replacement is atomic; the running image is never renamed out of the way.
 * Used outside the audio callback by the bridge and session init. */
#ifndef XMP_IMAGE_UPDATE_H
#define XMP_IMAGE_UPDATE_H
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define XMP_OWNER_IMAGE_BYTES (32u * 1024 * 1024)

static inline int xmp_write_all(int fd, const void *data, size_t size) {
  const unsigned char *p = data;
  while (size) {
    ssize_t n = write(fd, p, size);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) return -1;
    p += n;
    size -= (size_t)n;
  }
  return 0;
}

static inline int xmp_image_regular(int fd) {
  struct stat st;
  return fstat(fd, &st) == 0 && S_ISREG(st.st_mode) && st.st_size == XMP_OWNER_IMAGE_BYTES;
}

/* This is an additional device-side envelope check. The Mac audits the entire
 * filesystem, ELF dependencies, release marker and pinned owner runtime. */
static inline int xmp_image_envelope(int fd) {
  unsigned char sb[256];
  return xmp_image_regular(fd) && pread(fd, sb, sizeof sb, 1024) == sizeof sb &&
         sb[56] == 0x53 && sb[57] == 0xef && sb[24] == 2 &&
         sb[25] == 0 && sb[26] == 0 && sb[27] == 0 &&
         sb[88] == 0 && sb[89] == 1 &&
         memcmp(sb + 120, "xmpsys\0", 7) == 0;
}

static inline int xmp_copy_image(int dir, const char *from, const char *to) {
  int in = openat(dir, from, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (in < 0) return -1;
  int out = -1, failed = !xmp_image_regular(in);
  if (!failed) out = openat(dir, to, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0644);
  if (out < 0) failed = 1;
  unsigned char buffer[65536];
  size_t left = XMP_OWNER_IMAGE_BYTES;
  while (!failed && left) {
    ssize_t n = read(in, buffer, left < sizeof buffer ? left : sizeof buffer);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0 || xmp_write_all(out, buffer, (size_t)n)) failed = 1;
    else left -= (size_t)n;
  }
  if (out >= 0) {
    if (fsync(out)) failed = 1;
    if (close(out)) failed = 1;
  }
  if (close(in)) failed = 1;
  if (failed) unlinkat(dir, to, 0);
  return failed ? -1 : 0;
}

static inline int xmp_remove_temp(int dir, const char *name) {
  return unlinkat(dir, name, 0) == 0 || errno == ENOENT ? 0 : -1;
}

static inline int xmp_restore_image(int dir) {
  const char *temp = "system.img.restore";
  if (xmp_remove_temp(dir, temp) || xmp_copy_image(dir, "system.img.previous", temp)) return -1;
  if (renameat(dir, temp, dir, "system.img") || fsync(dir)) return -1;
  return 0;
}

/* A failure is never reported as installed. Before promotion the active file
 * stays intact. After promotion, a failed durability check triggers a checked
 * rollback; previous remains available even if that rollback also fails. */
static inline int xmp_promote_image(int dir) {
  const char *temp = "system.img.previous.new";
  if (xmp_remove_temp(dir, temp) || xmp_copy_image(dir, "system.img", temp)) return -1;
  if (renameat(dir, temp, dir, "system.img.previous") || fsync(dir)) return -1;
  if (renameat(dir, "system.img.new", dir, "system.img")) return -1;
  if (fsync(dir)) {
    xmp_restore_image(dir);
    return -1;
  }
  /* Only a newly verified update starts another automatic fallback trial. */
  if (xmp_remove_temp(dir, ".fallback-tried") || fsync(dir)) return -1;
  return 0;
}

/* Returns success only after a durable restore. The previous image is copied,
 * never consumed. A persistent marker prevents repeated fallback boot loops. */
static inline int xmp_fallback_image(int dir) {
  int marker = openat(dir, ".fallback-tried", O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0644);
  if (marker < 0) return -1;
  int failed = fsync(marker) != 0;
  if (close(marker)) failed = 1;
  if (fsync(dir)) failed = 1;
  if (failed) return -1;
  return xmp_restore_image(dir);
}
#endif
