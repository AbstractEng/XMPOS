/* Included after xmp-live-common.h. Artwork lives in the read-only XMP image,
 * never on internal storage. Rendering finishes before controls/audio start. */
#pragma once
#include "boot-screen-format.h"

static inline int show_boot_screen(void) {
  int art_fd = open("/usr/share/xmp/boot-screen.rgb", O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (art_fd < 0) return 0;
  struct stat st;
  if (fstat(art_fd, &st) != 0 || !S_ISREG(st.st_mode) || st.st_size != XMP_BOOT_BYTES) {
    close(art_fd);
    return 0;
  }
  unsigned char *art = mmap(NULL, XMP_BOOT_BYTES, PROT_READ, MAP_PRIVATE, art_fd, 0);
  close(art_fd);
  if (art == MAP_FAILED) return 0;
  int fd = -1, ok = 0;
  if (!xmp_boot_valid(art, XMP_BOOT_BYTES)) goto done;
  for (int i = 0; i < 30; ++i) {
    fd = open("/dev/fb0", O_RDWR | O_CLOEXEC);
    if (fd >= 0) break;
    usleep(500000);
  }
  if (fd < 0) goto done;
  struct fb_var_screeninfo v;
  struct fb_fix_screeninfo f;
  if (ioctl(fd, FBIOGET_VSCREENINFO, &v) || ioctl(fd, FBIOGET_FSCREENINFO, &f) ||
      f.type != FB_TYPE_PACKED_PIXELS || f.visual != FB_VISUAL_TRUECOLOR ||
      v.nonstd || v.grayscale || (uint64_t)v.xoffset + v.xres > v.xres_virtual ||
      (uint64_t)v.yoffset + v.yres > v.yres_virtual ||
      v.red.msb_right || v.green.msb_right || v.blue.msb_right || !f.smem_len ||
      f.smem_len > 64u * 1024u * 1024u) goto done;
  const struct xmp_boot_surface surface = {
    v.xres, v.yres, v.xoffset, v.yoffset, f.line_length, v.bits_per_pixel,
    v.red.offset, v.green.offset, v.blue.offset,
    v.red.length, v.green.length, v.blue.length
  };
  unsigned char *fb = mmap(NULL, f.smem_len, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
  if (fb == MAP_FAILED) goto done;
  ok = xmp_boot_blit(art, XMP_BOOT_BYTES, fb, f.smem_len, &surface);
  munmap(fb, f.smem_len);
done:
  if (fd >= 0) close(fd);
  munmap(art, XMP_BOOT_BYTES);
  return ok;
}
