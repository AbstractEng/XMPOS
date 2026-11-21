#include "boot-screen-format.h"
#include <stdio.h>
#include <stdlib.h>

#define CHECK(x) do { if (!(x)) { fprintf(stderr, "boot screen check failed: %s:%d: %s\n", __FILE__, __LINE__, #x); return 1; } } while (0)

int main(int argc, char **argv) {
  CHECK(argc == 2 || argc == 3);
  FILE *source = fopen(argv[1], "rb");
  CHECK(source);
  unsigned char *art = malloc(XMP_BOOT_BYTES);
  CHECK(art);
  CHECK(fread(art, 1, XMP_BOOT_BYTES, source) == XMP_BOOT_BYTES);
  CHECK(fgetc(source) == EOF);
  fclose(source);
  CHECK(xmp_boot_valid(art, XMP_BOOT_BYTES));
  CHECK(!xmp_boot_valid(art, XMP_BOOT_BYTES - 1));
  CHECK(!xmp_boot_valid(art, XMP_BOOT_BYTES + 1));
  art[8] ^= 1;
  CHECK(!xmp_boot_valid(art, XMP_BOOT_BYTES));
  art[8] ^= 1;
  const char live[] = "inmusic,acv8\0rockchip,rk3288";
  const char force[] = "inmusic,acv8\0inmusic,Force";
  const char ada2[] = "inmusic,acv8\0inmusic,ada2";
  const char virt[] = "linux,dummy-virt";
  CHECK(xmp_boot_board_allowed(live, sizeof live, 0));
  CHECK(!xmp_boot_board_allowed(live, 12, 0)); /* truncated DT value */
  CHECK(!xmp_boot_board_allowed(force, sizeof force, 1));
  CHECK(!xmp_boot_board_allowed(ada2, sizeof ada2, 1));
  CHECK(!xmp_boot_board_allowed(virt, sizeof virt, 0));
  CHECK(xmp_boot_board_allowed(virt, sizeof virt, 1));
  CHECK(!xmp_boot_board_allowed("inmusic,acv8-other", 18, 0));
  CHECK(!xmp_boot_board_allowed("", 0, 1));
  CHECK(!xmp_boot_board_allowed(live, 1024, 1));

  FILE *preview = argc == 3 ? fopen(argv[2], "wb") : NULL;
  if (argc == 3) CHECK(preview);
  if (preview) fprintf(preview, "P6\n1280 800\n255\n");
  for (int portrait = 0; portrait < 2; ++portrait) {
    for (int rgb565 = 0; rgb565 < 2; ++rgb565) {
      struct xmp_boot_surface s = {
        portrait ? 800 : 1280, portrait ? 1280 : 800, 3, 2, 0,
        rgb565 ? 16 : 32, rgb565 ? 11 : 16, rgb565 ? 5 : 8, 0,
        rgb565 ? 5 : 8, rgb565 ? 6 : 8, rgb565 ? 5 : 8
      };
      const unsigned int pixel_bytes = s.bpp / 8;
      s.stride = (s.width + 7) * pixel_bytes;
      const size_t size = (s.height + 4) * s.stride;
      unsigned char *fb = malloc(size);
      CHECK(fb);
      memset(fb, 0xa5, size);
      CHECK(xmp_boot_blit(art, XMP_BOOT_BYTES, fb, size, &s));
      /* Every pixel must round-trip through the actual panel rotation. */
      for (unsigned int y = 0; y < 800; ++y) for (unsigned int x = 0; x < 1280; ++x) {
        const unsigned int fx = portrait ? y : x, fy = portrait ? 1279 - x : y;
        const unsigned char *p = fb + (s.yoffset + fy) * s.stride + (s.xoffset + fx) * pixel_bytes;
        const unsigned char *rgb = art + 16 + (y * 1280 + x) * 3;
        if (!rgb565) {
          CHECK(p[0] == rgb[2] && p[1] == rgb[1] && p[2] == rgb[0] && p[3] == 0);
          if (portrait && preview) {
            const unsigned char restored[] = {p[2], p[1], p[0]};
            CHECK(fwrite(restored, 1, 3, preview) == 3);
          }
        } else {
          const unsigned int packed = p[0] | ((unsigned int)p[1] << 8);
          CHECK(packed == ((unsigned int)(rgb[0] >> 3) << 11 |
                          (unsigned int)(rgb[1] >> 2) << 5 | (rgb[2] >> 3)));
        }
      }
      /* Panning offsets and stride padding must remain untouched. */
      for (unsigned int y = 0; y < s.height + 4; ++y) for (unsigned int b = 0; b < s.stride; ++b)
        if (y < s.yoffset || y >= s.yoffset + s.height || b < s.xoffset * pixel_bytes ||
            b >= (s.xoffset + s.width) * pixel_bytes) CHECK(fb[y * s.stride + b] == 0xa5);
      CHECK(!xmp_boot_blit(art, XMP_BOOT_BYTES, fb, 1, &s));
      const struct xmp_boot_surface saved = s;
      s.xoffset = UINT32_MAX;
      CHECK(!xmp_boot_blit(art, XMP_BOOT_BYTES, fb, size, &s));
      s = saved;
      s.yoffset = UINT32_MAX;
      CHECK(!xmp_boot_blit(art, XMP_BOOT_BYTES, fb, size, &s));
      s = saved;
      s.stride = 1;
      CHECK(!xmp_boot_blit(art, XMP_BOOT_BYTES, fb, size, &s));
      s = saved;
      s.bpp = 24;
      CHECK(!xmp_boot_blit(art, XMP_BOOT_BYTES, fb, size, &s));
      s = saved;
      s.red_length = 0;
      CHECK(!xmp_boot_blit(art, XMP_BOOT_BYTES, fb, size, &s));
      s = saved;
      s.red_offset = s.green_offset;
      CHECK(!xmp_boot_blit(art, XMP_BOOT_BYTES, fb, size, &s));
      free(fb);
    }
  }
  if (preview) fclose(preview);
  unsigned char sentinel[8];
  memset(sentinel, 0xa5, sizeof sentinel);
  struct xmp_boot_surface bad = {0};
  CHECK(!xmp_boot_blit(art, XMP_BOOT_BYTES, sentinel, sizeof sentinel, &bad));
  CHECK(sentinel[0] == 0xa5 && sentinel[7] == 0xa5);
  free(art);
  puts("Emerald Current: full-pixel panel rotation, RGB565/XRGB8888, bounds and protected-board checks passed");
  return 0;
}
