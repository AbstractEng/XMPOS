/* Fixed-size original XMP artwork. No decoder, scaling or allocation at boot.
 * This portable renderer is also exercised against host memory in native tests. */
#pragma once
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#define XMP_BOOT_WIDTH 1280u
#define XMP_BOOT_HEIGHT 800u
#define XMP_BOOT_BYTES (16u + XMP_BOOT_WIDTH * XMP_BOOT_HEIGHT * 3u)

struct xmp_boot_surface {
  uint32_t width, height, xoffset, yoffset, stride, bpp;
  uint32_t red_offset, green_offset, blue_offset;
  uint32_t red_length, green_length, blue_length;
};

static inline uint32_t xmp_boot_u32(const unsigned char *p) {
  return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

static inline int xmp_boot_valid(const unsigned char *art, size_t bytes) {
  return bytes == XMP_BOOT_BYTES && memcmp(art, "XMPBOOT1", 8) == 0 &&
         xmp_boot_u32(art + 8) == XMP_BOOT_WIDTH && xmp_boot_u32(art + 12) == XMP_BOOT_HEIGHT;
}

static inline int xmp_boot_board_allowed(const char *compatible, size_t bytes, int emulator) {
  char board[1024];
  if (!bytes || bytes >= sizeof board - 1 || compatible[bytes - 1] != 0) return 0;
  for (size_t i = 0; i < bytes; ++i) {
    const unsigned char c = (unsigned char)compatible[i];
    board[i] = c == 0 ? ' ' : (char)(c >= 'A' && c <= 'Z' ? c + ('a' - 'A') : c);
  }
  board[bytes] = 0;
  if (strstr(board, "force") || strstr(board, "ada2")) return 0;
  /* Match complete DT compatible strings, rather than a board-name prefix. */
  int live = 0, virt = 0;
  for (size_t i = 0; i < bytes;) {
    size_t end = i;
    while (end < bytes && compatible[end]) ++end;
    if (end - i == 12 && memcmp(compatible + i, "inmusic,acv8", 12) == 0) live = 1;
    if (end - i == 16 && memcmp(compatible + i, "linux,dummy-virt", 16) == 0) virt = 1;
    i = end + 1;
  }
  return live || (emulator && virt);
}

static inline int xmp_boot_blit(const unsigned char *art, size_t bytes, unsigned char *fb,
                                size_t fb_bytes, const struct xmp_boot_surface *s) {
  if (!xmp_boot_valid(art, bytes) || !fb || !s) return 0;
  const int portrait = s->width == XMP_BOOT_HEIGHT && s->height == XMP_BOOT_WIDTH;
  if (!portrait && !(s->width == XMP_BOOT_WIDTH && s->height == XMP_BOOT_HEIGHT)) return 0;
  if (s->bpp != 16 && s->bpp != 32) return 0;
  const uint32_t offsets[] = {s->red_offset, s->green_offset, s->blue_offset};
  const uint32_t lengths[] = {s->red_length, s->green_length, s->blue_length};
  uint32_t masks = 0;
  for (unsigned int i = 0; i < 3; ++i) {
    if (!lengths[i] || lengths[i] > 8 || offsets[i] >= s->bpp || lengths[i] > s->bpp - offsets[i]) return 0;
    const uint32_t mask = ((1u << lengths[i]) - 1u) << offsets[i];
    if (masks & mask) return 0;
    masks |= mask;
  }
  const uint32_t pixel_bytes = s->bpp / 8;
  const uint64_t row_bytes = ((uint64_t)s->xoffset + s->width) * pixel_bytes;
  const uint64_t last_row = (uint64_t)s->yoffset + s->height - 1;
  if (!s->stride || row_bytes > s->stride || row_bytes > fb_bytes ||
      last_row > (fb_bytes - row_bytes) / s->stride) return 0;
  for (uint32_t y = 0; y < XMP_BOOT_HEIGHT; ++y) {
    for (uint32_t x = 0; x < XMP_BOOT_WIDTH; ++x) {
      const unsigned char *rgb = art + 16 + (y * XMP_BOOT_WIDTH + x) * 3;
      uint32_t pixel = 0;
      for (unsigned int c = 0; c < 3; ++c)
        pixel |= ((uint32_t)rgb[c] >> (8 - lengths[c])) << offsets[c];
      const uint32_t fx = portrait ? y : x;
      const uint32_t fy = portrait ? XMP_BOOT_WIDTH - 1 - x : y;
      unsigned char *out = fb + ((size_t)s->yoffset + fy) * s->stride +
                           ((size_t)s->xoffset + fx) * pixel_bytes;
      for (uint32_t b = 0; b < pixel_bytes; ++b) out[b] = (unsigned char)(pixel >> (8 * b));
    }
  }
  return 1;
}
