/* XMP control bridge on the MPC Live Mk1 (AGENTS.md, authorizations 3 and 4).
 * Started by the session init in the XMP session image on the owner's stick.
 *
 * Talks over the USB-to-USB null-modem cable (an FTDI FT232R at each end,
 * 0403:6001) plugged into one of the Live's USB-A ports (authorization 3's
 * link amendment: in standalone mode the Live's USB-B port does not reach a
 * computer). A USB CDC-ACM gadget (1209:0001) is available only for
 * private emulator testing; this ID is not allocated for public distribution.
 * Production disables the gadget and uses the FTDI cable. It opens only a
 * serial port whose USB device is exactly that cable, and exactly one, never
 * the Live's internal controller or audio card (Akai's 09e8:*). It answers a fixed set of commands from
 * `npm run live:bridge` on the Mac. Frames are a 4-byte big-endian length and
 * a payload; requests are small JSON objects. Nothing received is executed:
 * there is no shell and no command line. Writes go to the stick only.
 *
 * Commands: hello, status, log, screenshot, input, record, push-image,
 * restart, reboot, power-off.
 *
 * Usage: xmp-bridge --udc none|dummy_udc.2 --stick /media/xmp */
#include <dirent.h>
#include <limits.h>
#include <pthread.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/fb.h>
#include <poll.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/mount.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <termios.h>
#include <time.h>
#include <unistd.h>

#include "image-update.h"

#define PROTOCOL 1
#define MAX_REQUEST (64 * 1024)
#define MAX_IMAGE (256u * 1024 * 1024)
#define GADGET "/sys/kernel/config/usb_gadget/xmpbridge"
#define SESSION_SOCKET "/tmp/xmp-session.sock"
#define AKAI_VENDOR 0x09e8 /* refused: the Live's own controller and audio card, and the Force */
#define CABLE_VENDOR 0x0403
#define CABLE_PRODUCT 0x6001

static char stick[64] = "/media/xmp";
static FILE *bridge_log;

static void say(const char *fmt, ...) {
  char line[512];
  va_list a;
  va_start(a, fmt);
  vsnprintf(line, sizeof line, fmt, a);
  va_end(a);
  printf("XMP-BRIDGE %s\n", line);
  fflush(stdout);
  if (bridge_log) {
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    fprintf(bridge_log, "%9.3f %s\n", (double)t.tv_sec + t.tv_nsec / 1e9, line);
    fflush(bridge_log);
    fsync(fileno(bridge_log));
  }
}

/* ---- SHA-256 (FIPS 180-4) ---- */
typedef struct {
  uint32_t h[8];
  uint64_t bytes;
  uint8_t block[64];
  size_t used;
} sha256;
static const uint32_t K[64] = {
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
    0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
    0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
    0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
    0xc67178f2};
#define ROR(x, n) (((x) >> (n)) | ((x) << (32 - (n))))
static void sha_block(sha256 *s, const uint8_t *p) {
  uint32_t w[64], a[8];
  for (int i = 0; i < 16; i++) w[i] = (uint32_t)p[i * 4] << 24 | p[i * 4 + 1] << 16 | p[i * 4 + 2] << 8 | p[i * 4 + 3];
  for (int i = 16; i < 64; i++) {
    uint32_t s0 = ROR(w[i - 15], 7) ^ ROR(w[i - 15], 18) ^ (w[i - 15] >> 3);
    uint32_t s1 = ROR(w[i - 2], 17) ^ ROR(w[i - 2], 19) ^ (w[i - 2] >> 10);
    w[i] = w[i - 16] + s0 + w[i - 7] + s1;
  }
  memcpy(a, s->h, sizeof a);
  for (int i = 0; i < 64; i++) {
    uint32_t t1 = a[7] + (ROR(a[4], 6) ^ ROR(a[4], 11) ^ ROR(a[4], 25)) + ((a[4] & a[5]) ^ (~a[4] & a[6])) + K[i] + w[i];
    uint32_t t2 = (ROR(a[0], 2) ^ ROR(a[0], 13) ^ ROR(a[0], 22)) + ((a[0] & a[1]) ^ (a[0] & a[2]) ^ (a[1] & a[2]));
    memmove(a + 1, a, 7 * sizeof a[0]);
    a[4] += t1;
    a[0] = t1 + t2;
  }
  for (int i = 0; i < 8; i++) s->h[i] += a[i];
}
static void sha_init(sha256 *s) {
  static const uint32_t h0[8] = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                                 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
  memcpy(s->h, h0, sizeof h0);
  s->bytes = 0;
  s->used = 0;
}
static void sha_update(sha256 *s, const uint8_t *p, size_t n) {
  s->bytes += n;
  while (n) {
    size_t take = 64 - s->used < n ? 64 - s->used : n;
    memcpy(s->block + s->used, p, take);
    s->used += take, p += take, n -= take;
    if (s->used == 64) sha_block(s, s->block), s->used = 0;
  }
}
static void sha_hex(sha256 *s, char out[65]) {
  uint64_t bits = s->bytes * 8;
  uint8_t pad = 0x80, zero = 0, len[8];
  sha_update(s, &pad, 1);
  while (s->used != 56) sha_update(s, &zero, 1);
  for (int i = 0; i < 8; i++) len[i] = (uint8_t)(bits >> (56 - 8 * i));
  sha_update(s, len, 8);
  for (int i = 0; i < 8; i++) sprintf(out + i * 8, "%08x", s->h[i]);
}

/* Fingerprints are computed outside audio processing, from fixed XMP-root paths
 * only. The read-only session filesystem cannot change until the next boot. */
static void executable_hash(const char *path, char out[65]) {
  out[0] = 0;
  int fd = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  struct stat st;
  if (fd < 0) return;
  if (fstat(fd, &st) != 0 || !S_ISREG(st.st_mode) || st.st_size < 1 || st.st_size > 32 * 1024 * 1024) {
    close(fd);
    return;
  }
  sha256 hash;
  sha_init(&hash);
  uint8_t block[32768];
  off_t total = 0;
  for (;;) {
    ssize_t got = read(fd, block, sizeof block);
    if (got < 0 && errno == EINTR) continue;
    if (got < 0 || total + got > st.st_size) { close(fd); return; }
    if (!got) break;
    sha_update(&hash, block, (size_t)got);
    total += got;
  }
  close(fd);
  if (total == st.st_size) sha_hex(&hash, out);
}

/* ---- minimal JSON field reading (flat objects of strings and numbers) ---- */
static int json_string(const char *json, const char *key, char *out, size_t size) {
  char pattern[64];
  snprintf(pattern, sizeof pattern, "\"%s\":\"", key);
  const char *at = strstr(json, pattern);
  if (!at) return 0;
  at += strlen(pattern);
  size_t n = 0;
  while (at[n] && at[n] != '"' && n + 1 < size) {
    if (at[n] == '\\') return 0; /* no escapes in bridge requests */
    out[n] = at[n];
    n++;
  }
  if (at[n] != '"') return 0;
  out[n] = 0;
  return 1;
}
static long long json_number(const char *json, const char *key, long long fallback) {
  char pattern[64];
  snprintf(pattern, sizeof pattern, "\"%s\":", key);
  const char *at = strstr(json, pattern);
  if (!at) return fallback;
  char *end;
  long long v = strtoll(at + strlen(pattern), &end, 10);
  return end == at + strlen(pattern) ? fallback : v;
}

/* ---- serial link ---- */
static int link_fd = -1;
static int link_is_cable = 0;
static void write_state(const char *state);
static char link_path[300];

/* ---- the FTDI null-modem cable (0403:6001) ---- */
/* The USB vendor and product of the device a tty belongs to, read from sysfs
 * (the tty's port, then its interface, then the device). Read-only. */
static int tty_usb_id(const char *tty, unsigned *vendor, unsigned *product) {
  char path[PATH_MAX], real[PATH_MAX];
  snprintf(path, sizeof path, "/sys/class/tty/%s/device", tty);
  if (!realpath(path, real)) return -1;
  for (int up = 0; up < 4; up++) {
    char file[PATH_MAX + 16];
    snprintf(file, sizeof file, "%s/idVendor", real);
    FILE *v = fopen(file, "r");
    if (v) {
      snprintf(file, sizeof file, "%s/idProduct", real);
      FILE *d = fopen(file, "r");
      int ok = d && fscanf(v, "%x", vendor) == 1 && fscanf(d, "%x", product) == 1;
      fclose(v);
      if (d) fclose(d);
      return ok ? 0 : -1;
    }
    char *slash = strrchr(real, '/');
    if (!slash || slash == real) return -1;
    *slash = 0;
  }
  return -1;
}
/* How many FTDI cables (0403:6001) are attached; the path of the last one. */
static int find_cable(char *out, size_t size) {
  int found = 0;
  DIR *d = opendir("/sys/class/tty");
  if (!d) return 0;
  struct dirent *e;
  while ((e = readdir(d))) {
    if (strncmp(e->d_name, "ttyUSB", 6) != 0) continue;
    unsigned vendor = 0, product = 0;
    if (tty_usb_id(e->d_name, &vendor, &product) != 0) continue;
    if (vendor == AKAI_VENDOR) continue; /* never an Akai device */
    if (vendor == CABLE_VENDOR && product == CABLE_PRODUCT) {
      found++;
      snprintf(out, size, "/dev/%s", e->d_name);
    }
  }
  closedir(d);
  return found;
}
/* The cable's port: raw, 921600 baud, 8N1, hardware flow control (the cable
 * crosses RTS and CTS), so an image of tens of megabytes moves in minutes. */
static int open_cable(const char *path) {
  int fd = open(path, O_RDWR | O_NOCTTY | O_CLOEXEC);
  if (fd < 0) return -1;
  struct termios tio;
  if (tcgetattr(fd, &tio) != 0) return close(fd), -1;
  cfmakeraw(&tio);
  cfsetispeed(&tio, B921600);
  cfsetospeed(&tio, B921600);
  tio.c_cflag |= CLOCAL | CREAD | CRTSCTS;
  tio.c_cflag &= ~(CSTOPB | PARENB);
  if (tcsetattr(fd, TCSANOW, &tio) != 0) return close(fd), -1;
  tcflush(fd, TCIOFLUSH);
  return fd;
}
static int read_exact(void *buffer, size_t size, int timeout_ms) {
  uint8_t *p = buffer;
  while (size) {
    struct pollfd pfd = {.fd = link_fd, .events = POLLIN};
    int r = poll(&pfd, 1, timeout_ms);
    if (r <= 0) return -1;
    ssize_t n = read(link_fd, p, size);
    if (n <= 0) {
      if (n < 0 && (errno == EAGAIN || errno == EINTR)) continue;
      return -1;
    }
    p += n, size -= (size_t)n;
  }
  return 0;
}
static int write_all(const void *buffer, size_t size) {
  const uint8_t *p = buffer;
  while (size) {
    ssize_t n = write(link_fd, p, size);
    if (n < 0) {
      if (errno == EAGAIN || errno == EINTR) {
        struct pollfd pfd = {.fd = link_fd, .events = POLLOUT};
        poll(&pfd, 1, 1000);
        continue;
      }
      return -1;
    }
    p += n, size -= (size_t)n;
  }
  return 0;
}
static int send_frame(const void *payload, size_t size) {
  uint8_t header[4] = {(uint8_t)(size >> 24), (uint8_t)(size >> 16), (uint8_t)(size >> 8), (uint8_t)size};
  return write_all(header, 4) || write_all(payload, size) ? -1 : 0;
}
static int send_json(const char *fmt, ...) {
  char text[2048];
  va_list a;
  va_start(a, fmt);
  int n = vsnprintf(text, sizeof text, fmt, a);
  va_end(a);
  return send_frame(text, (size_t)(n < (int)sizeof text ? n : (int)sizeof text - 1));
}
static int send_file(const char *path, size_t limit) {
  int fd = open(path, O_RDONLY | O_CLOEXEC);
  if (fd < 0) return send_frame("", 0);
  struct stat st;
  fstat(fd, &st);
  size_t size = (size_t)st.st_size < limit ? (size_t)st.st_size : limit;
  uint8_t header[4] = {(uint8_t)(size >> 24), (uint8_t)(size >> 16), (uint8_t)(size >> 8), (uint8_t)size};
  if (write_all(header, 4)) return close(fd), -1;
  static uint8_t chunk[65536];
  size_t left = size;
  while (left) {
    ssize_t n = read(fd, chunk, left < sizeof chunk ? left : sizeof chunk);
    if (n <= 0) memset(chunk, 0, sizeof chunk), n = (ssize_t)(left < sizeof chunk ? left : sizeof chunk);
    if (write_all(chunk, (size_t)n)) return close(fd), -1;
    left -= (size_t)n;
  }
  close(fd);
  return 0;
}

/* ---- the session's control socket ---- */
static int session_request(const char *line, char *reply, size_t size, int timeout_ms) {
  int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  struct sockaddr_un a = {.sun_family = AF_UNIX};
  snprintf(a.sun_path, sizeof a.sun_path, SESSION_SOCKET);
  if (fd < 0 || connect(fd, (struct sockaddr *)&a, sizeof a) != 0) {
    if (fd >= 0) close(fd);
    snprintf(reply, size, "error: session not running");
    return -1;
  }
  char out[300];
  int n = snprintf(out, sizeof out, "%s\n", line);
  if (write(fd, out, (size_t)n) != n) {
    close(fd);
    return -1;
  }
  size_t got = 0;
  while (got + 1 < size) {
    struct pollfd pfd = {.fd = fd, .events = POLLIN};
    if (poll(&pfd, 1, timeout_ms) <= 0) break;
    ssize_t r = read(fd, reply + got, size - 1 - got);
    if (r <= 0) break;
    got += (size_t)r;
    if (memchr(reply, '\n', got)) break;
  }
  reply[got] = 0;
  reply[strcspn(reply, "\n")] = 0;
  close(fd);
  return got ? 0 : -1;
}

/* ---- gadget ---- */
static int put(const char *path, const char *value) {
  int fd = open(path, O_WRONLY | O_CLOEXEC);
  if (fd < 0) return -1;
  ssize_t n = write(fd, value, strlen(value));
  close(fd);
  return n == (ssize_t)strlen(value) ? 0 : -1;
}
static int pick_udc(const char *wanted, char *out, size_t size) {
  if (strcmp(wanted, "auto") != 0) return snprintf(out, size, "%s", wanted), 1;
  DIR *d = opendir("/sys/class/udc");
  struct dirent *e;
  int found = 0;
  char list[512] = "";
  while (d && (e = readdir(d))) {
    if (e->d_name[0] == '.') continue;
    strncat(list, e->d_name, sizeof list - strlen(list) - 2);
    strncat(list, " ", sizeof list - strlen(list) - 1);
    if (!found && strncmp(e->d_name, "dummy_udc", 9) != 0) found = snprintf(out, size, "%s", e->d_name) > 0;
  }
  if (d) closedir(d);
  say("USB device controllers: %s", list[0] ? list : "(none)");
  return found;
}
static int make_gadget(const char *udc) {
  mount("configfs", "/sys/kernel/config", "configfs", 0, NULL);
  mkdir(GADGET, 0755);
  put(GADGET "/idVendor", "0x1209");
  put(GADGET "/idProduct", "0x0001");
  put(GADGET "/bcdUSB", "0x0200");
  mkdir(GADGET "/strings/0x409", 0755);
  put(GADGET "/strings/0x409/manufacturer", "XMP");
  put(GADGET "/strings/0x409/product", "XMP bridge");
  put(GADGET "/strings/0x409/serialnumber", "xmp-live-mk1");
  mkdir(GADGET "/functions/acm.usb0", 0755);
  mkdir(GADGET "/configs/c.1", 0755);
  put(GADGET "/configs/c.1/MaxPower", "100");
  symlink(GADGET "/functions/acm.usb0", GADGET "/configs/c.1/acm.usb0");
  if (put(GADGET "/UDC", udc) != 0) {
    say("cannot bind the bridge gadget to %s (errno %d)", udc, errno);
    return -1;
  }
  say("gadget 1209:0001 \"XMP bridge\" (serial) on %s", udc);
  return 0;
}

/* ---- USB connection state: logged for diagnosis, and shown on screen ----
 * The session draws a fifth status light from /tmp/xmp-bridge-state:
 * "off" grey, "ready" amber (bound, no computer yet), "connected" green. */
static char udc_name[64];
static void write_state(const char *state) {
  FILE *f = fopen("/tmp/xmp-bridge-state.new", "w");
  if (!f) return;
  fprintf(f, "%s\n", state);
  fclose(f);
  rename("/tmp/xmp-bridge-state.new", "/tmp/xmp-bridge-state");
}
static void read_line(const char *path, char *out, size_t size) {
  out[0] = 0;
  FILE *f = fopen(path, "r");
  if (!f) return;
  if (fgets(out, (int)size, f)) out[strcspn(out, "\n")] = 0;
  fclose(f);
}
/* The dwc2 registers that decide whether the port connects as a device:
 * GOTGCTL (session valid, ID status), GUSBCFG (forced mode), GINTSTS (current
 * mode), DCTL (soft disconnect). Read from debugfs; nothing is written. */
static void log_dwc2(const char *when) {
  char path[256], line[256], found[512] = "";
  snprintf(path, sizeof path, "/sys/kernel/debug/%s/regdump", udc_name);
  FILE *f = fopen(path, "r");
  while (f && fgets(line, sizeof line, f)) {
    if (strncmp(line, "GOTGCTL", 7) == 0 || strncmp(line, "GUSBCFG", 7) == 0 || strncmp(line, "GINTSTS", 7) == 0 ||
        strncmp(line, "DCTL ", 5) == 0 || strncmp(line, "DSTS", 4) == 0) {
      line[strcspn(line, "\n")] = 0;
      strncat(found, line, sizeof found - strlen(found) - 3);
      strncat(found, "; ", sizeof found - strlen(found) - 1);
    }
  }
  if (f) fclose(f);
  char mode[64];
  snprintf(path, sizeof path, "/sys/kernel/debug/%s/dr_mode", udc_name);
  read_line(path, mode, sizeof mode);
  say("dwc2 %s: dr_mode %s; %s", when, mode[0] ? mode : "?", found[0] ? found : "(no regdump)");
}
static void *watch_connection(void *arg) {
  (void)arg;
  char path[256], state[64], speed[64], last[64] = "";
  snprintf(path, sizeof path, "/sys/class/udc/%s/state", udc_name);
  for (int tick = 0;; tick++) {
    read_line(path, state, sizeof state);
    if (strcmp(state, last) != 0) {
      char speed_path[256];
      snprintf(speed_path, sizeof speed_path, "/sys/class/udc/%s/current_speed", udc_name);
      read_line(speed_path, speed, sizeof speed);
      say("USB port state: %s (speed %s)", state[0] ? state : "?", speed[0] ? speed : "?");
      snprintf(last, sizeof last, "%s", state);
      write_state(strcmp(state, "configured") == 0 ? "connected" : "ready");
      log_dwc2("now");
    }
    /* Not attached after 5 s: try the standard soft disconnect and reconnect once. */
    if (tick == 5 && strcmp(state, "configured") != 0) {
      char soft[256];
      snprintf(soft, sizeof soft, "/sys/class/udc/%s/soft_connect", udc_name);
      int a = put(soft, "disconnect");
      usleep(300000);
      int b = put(soft, "connect");
      say("soft reconnect tried (%s/%s)", a == 0 ? "ok" : "refused", b == 0 ? "ok" : "refused");
      last[0] = 0; /* log the state again */
    }
    sleep(1);
  }
  return NULL;
}

/* ---- commands ---- */
static int newest_session_log(char *out, size_t size) {
  char dir[128];
  snprintf(dir, sizeof dir, "%s/xmp/logs", stick);
  DIR *d = opendir(dir);
  struct dirent *e;
  int best = 0;
  while (d && (e = readdir(d))) {
    int n;
    if (sscanf(e->d_name, "session-%d.txt", &n) == 1 && n > best) best = n;
  }
  if (d) closedir(d);
  if (!best) return 0;
  snprintf(out, size, "%s/session-%03d.txt", dir, best);
  return 1;
}

/* The framebuffer, raw (4 bytes a pixel) or, when the Mac asks ("rle":1),
 * run-length encoded: runs of [count, 2 bytes big-endian][the pixel, 4 bytes].
 * The interface is flat colours, so 4 MB (45 s over the cable) becomes a few
 * hundred kilobytes. */
static void screenshot(int rle) {
  int fd = open("/dev/fb0", O_RDONLY | O_CLOEXEC);
  struct fb_var_screeninfo v;
  struct fb_fix_screeninfo f;
  if (fd < 0 || ioctl(fd, FBIOGET_VSCREENINFO, &v) || ioctl(fd, FBIOGET_FSCREENINFO, &f) || v.bits_per_pixel != 32) {
    if (fd >= 0) close(fd);
    send_json("{\"ok\":false,\"error\":\"no 32-bit framebuffer\"}");
    return;
  }
  uint8_t *m = mmap(NULL, f.smem_len, PROT_READ, MAP_SHARED, fd, 0);
  if (m == MAP_FAILED) {
    close(fd);
    send_json("{\"ok\":false,\"error\":\"cannot map the framebuffer\"}");
    return;
  }
  size_t row = (size_t)v.xres * 4, size = row * v.yres;
  /* Worst case (no two neighbours alike): 6 bytes a pixel. */
  uint8_t *packed = rle ? malloc(size / 4 * 6 + 6) : NULL;
  send_json("{\"ok\":true,\"width\":%u,\"height\":%u,\"red\":%u,\"green\":%u,\"blue\":%u%s}", v.xres, v.yres,
            v.red.offset, v.green.offset, v.blue.offset, packed ? ",\"encoding\":\"rle\"" : "");
  if (packed) {
    size_t n = 0;
    uint32_t run = 0;
    uint8_t pixel[4] = {0, 0, 0, 0};
    for (unsigned y = 0; y < v.yres; y++) {
      const uint8_t *line = m + (size_t)(y + v.yoffset) * f.line_length + (size_t)v.xoffset * 4;
      for (unsigned x = 0; x < v.xres; x++) {
        const uint8_t *p = line + (size_t)x * 4;
        if (run && run < 65535 && memcmp(p, pixel, 4) == 0) {
          run++;
          continue;
        }
        if (run) {
          packed[n++] = (uint8_t)(run >> 8), packed[n++] = (uint8_t)run;
          memcpy(packed + n, pixel, 4), n += 4;
        }
        memcpy(pixel, p, 4), run = 1;
      }
    }
    if (run) {
      packed[n++] = (uint8_t)(run >> 8), packed[n++] = (uint8_t)run;
      memcpy(packed + n, pixel, 4), n += 4;
    }
    uint8_t header[4] = {(uint8_t)(n >> 24), (uint8_t)(n >> 16), (uint8_t)(n >> 8), (uint8_t)n};
    write_all(header, 4);
    write_all(packed, n);
    free(packed);
  } else {
    uint8_t header[4] = {(uint8_t)(size >> 24), (uint8_t)(size >> 16), (uint8_t)(size >> 8), (uint8_t)size};
    write_all(header, 4);
    for (unsigned y = 0; y < v.yres; y++)
      write_all(m + (size_t)(y + v.yoffset) * f.line_length + (size_t)v.xoffset * 4, row);
  }
  munmap(m, f.smem_len);
  close(fd);
}

/* The image arrives whole, or, when the Mac asks ("sparse":1), without its
 * empty space: records of [kind, 1 byte][length, 4 bytes big-endian], kind 0 a
 * run of zero bytes and kind 1 that many bytes of data. The image is a mostly
 * empty 32 MiB owner-local filesystem image; zero runs reduce cable time. Either way the SHA-256 of the whole image is
 * checked before it replaces the one on the stick. */
static void push_image(const char *request) {
  char expected[65] = "", profile[64] = "", target[32] = "", os[16] = "";
  char source[65] = "", directory[256];
  long long size = json_number(request, "size", -1);
  int sparse = json_number(request, "sparse", 0) == 1;
  if (!json_string(request, "sha256", expected, sizeof expected) || strlen(expected) != 64 || strspn(expected, "0123456789abcdef") != 64 ||
      size != XMP_OWNER_IMAGE_BYTES ||
      !json_string(request, "profile", profile, sizeof profile) || strcmp(profile, "xmp-owner-image-v1") ||
      !json_string(request, "target", target, sizeof target) || strcmp(target, "inmusic,acv8") ||
      !json_string(request, "mpcOsVersion", os, sizeof os) || strcmp(os, "3.10.1") ||
      !json_string(request, "sourceHash", source, sizeof source) || strlen(source) != 64 ||
      strspn(source, "0123456789abcdef") != 64) {
    send_json("{\"ok\":false,\"error\":\"push-image requires a verified 32 MiB owner-local 3.10.1 image\"}");
    return;
  }
  char state[1024], save_state[32] = "";
  if (session_request("status", state, sizeof state, 3000) ||
      !strstr(state, "\"playing\":false") || !strstr(state, "\"recording\":false") ||
      !json_string(state, "saveState", save_state, sizeof save_state) || strcmp(save_state, "saved")) {
    send_json("{\"ok\":false,\"error\":\"Stop and wait for Saved on stick before updating\"}");
    return;
  }
  snprintf(directory, sizeof directory, "%s/xmp", stick);
  int dir = open(directory, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (dir < 0) {
    send_json("{\"ok\":false,\"error\":\"cannot open stick image directory\"}");
    return;
  }
  send_json("{\"ok\":true,\"ready\":true%s}", sparse ? ",\"sparse\":true" : "");
  uint8_t header[4];
  if (read_exact(header, 4, 10000)) {
    send_json("{\"ok\":false,\"error\":\"image frame size does not match\"}");
    close(dir);
    return;
  }
  /* What follows on the link: the image itself, or its records (never more
   * than the image plus a record's header for every 4 KiB). */
  long long framed = (long long)((uint32_t)header[0] << 24 | header[1] << 16 | header[2] << 8 | header[3]);
  if (sparse ? framed < 5 || framed > size + size / 4096 * 5 + 10 : framed != size) {
    send_json("{\"ok\":false,\"error\":\"image frame size does not match\"}");
    close(dir);
    return;
  }
  if (xmp_remove_temp(dir, "system.img.new")) {
    close(dir);
    send_json("{\"ok\":false,\"error\":\"cannot clear staged image\"}");
    return;
  }
  int fd = openat(dir, "system.img.new", O_RDWR | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0644);
  if (fd < 0) {
    send_json("{\"ok\":false,\"error\":\"cannot write to the stick\"}");
    close(dir);
    return;
  }
  sha256 s;
  sha_init(&s);
  static uint8_t chunk[65536];
  long long left = size;
  int failed = 0;
  while (!sparse && left > 0) {
    size_t take = left < (long long)sizeof chunk ? (size_t)left : sizeof chunk;
    if (read_exact(chunk, take, 10000)) {
      failed = 1;
      break;
    }
    sha_update(&s, chunk, take);
    if (xmp_write_all(fd, chunk, take)) failed = 1;
    left -= (long long)take;
  }
  /* Records: every byte of the frame is read even after a failure, so the
   * link stays in step for the next request. */
  int bad = 0;
  while (sparse && framed > 0 && !failed) {
    uint8_t record[5];
    if (framed < 5 || read_exact(record, 5, 10000)) {
      failed = 1;
      break;
    }
    framed -= 5;
    long long run = (long long)((uint32_t)record[1] << 24 | record[2] << 16 | record[3] << 8 | record[4]);
    if (record[0] > 1 || run <= 0 || run > left || (record[0] == 1 && run > framed)) bad = 1;
    if (bad) {
      /* Not an image: drain what is left of the frame, write nothing more. */
      while (framed > 0) {
        size_t take = framed < (long long)sizeof chunk ? (size_t)framed : sizeof chunk;
        if (read_exact(chunk, take, 10000)) break;
        framed -= (long long)take;
      }
      failed = 1;
      break;
    }
    while (run > 0) {
      size_t take = run < (long long)sizeof chunk ? (size_t)run : sizeof chunk;
      if (record[0] == 0) {
        memset(chunk, 0, take);
      } else if (read_exact(chunk, take, 10000)) {
        failed = 1;
        break;
      } else {
        framed -= (long long)take;
      }
      sha_update(&s, chunk, take);
      if (xmp_write_all(fd, chunk, take)) failed = 1;
      run -= (long long)take, left -= (long long)take;
    }
  }
  if (sparse && left != 0) failed = 1;
  if (!failed && !xmp_image_envelope(fd)) failed = 1;
  if (fsync(fd)) failed = 1;
  if (close(fd)) failed = 1;
  char actual[65];
  sha_hex(&s, actual);
  if (failed || strcmp(actual, expected) != 0) {
    unlinkat(dir, "system.img.new", 0);
    close(dir);
    say("push-image refused: transfer, filesystem, sync or SHA-256 failure");
    send_json("{\"ok\":false,\"error\":\"image verification or durable write failed\"}");
    return;
  }
  /* Physical controls can change state while a transfer is in progress. */
  if (session_request("status", state, sizeof state, 3000) ||
      !strstr(state, "\"playing\":false") || !strstr(state, "\"recording\":false") ||
      !json_string(state, "saveState", save_state, sizeof save_state) || strcmp(save_state, "saved")) {
    close(dir);
    send_json("{\"ok\":false,\"error\":\"session changed during transfer; image not promoted\"}");
    return;
  }
  int promoted = xmp_promote_image(dir) == 0;
  if (close(dir)) promoted = 0;
  if (!promoted) {
    say("push-image refused: promotion failed; previous image retained when backed up");
    send_json("{\"ok\":false,\"error\":\"image promotion failed; do not reboot; inspect stick on Mac\"}");
    return;
  }
  say("push-image: verified system.img (%lld bytes, sha256 %.16s...), previous kept", size, actual);
  send_json("{\"ok\":true,\"installed\":true,\"sha256\":\"%s\",\"previousKept\":true}", actual);
}

static void record(const char *request) {
  long long seconds = json_number(request, "seconds", 3);
  if (seconds < 1 || seconds > 10) {
    send_json("{\"ok\":false,\"error\":\"seconds must be 1..10\"}");
    return;
  }
  char line[32], reply[256], path[256];
  long long size = 0;
  snprintf(line, sizeof line, "tap %lld", seconds);
  if (session_request(line, reply, sizeof reply, (int)(seconds * 1000 + 5000)) ||
      sscanf(reply, "tap %191s %lld", path, &size) != 2 || strncmp(path, "/media/xmp/xmp/captures/", 24) != 0) {
    send_json("{\"ok\":false,\"error\":\"%s\"}", reply[0] ? "session refused the capture" : "no reply");
    return;
  }
  struct stat st;
  for (int i = 0; i < 200 && (stat(path, &st) != 0 || st.st_size != size); i++) usleep(100000);
  send_json("{\"ok\":true,\"bytes\":%lld}", size);
  send_file(path, (size_t)size);
}

static int handle(const char *request, int *authorized, const char *token) {
  char cmd[32] = "";
  json_string(request, "cmd", cmd, sizeof cmd);
  if (strcmp(cmd, "hello") == 0) {
    char given[160] = "", compatible[256] = "";
    json_string(request, "token", given, sizeof given);
    int fd = open("/proc/device-tree/compatible", O_RDONLY | O_CLOEXEC);
    ssize_t n = fd >= 0 ? read(fd, compatible, sizeof compatible - 1) : 0;
    if (fd >= 0) close(fd);
    for (ssize_t i = 0; i < n; i++)
      if (!compatible[i]) compatible[i] = ' ';
    *authorized = token[0] && strcmp(given, token) == 0;
    say("hello: %s", *authorized ? "accepted" : token[0] ? "wrong token" : "no token on the stick");
    return send_json("{\"ok\":%s,\"protocol\":%d,\"imageUpdateProfile\":\"xmp-owner-image-v1\",\"board\":\"%s\",\"error\":\"%s\"}", *authorized ? "true" : "false",
                     PROTOCOL, compatible, *authorized ? "" : token[0] ? "wrong token" : "no xmp/bridge.token on the stick");
  }
  if (!*authorized) return send_json("{\"ok\":false,\"error\":\"say hello with the stick's token first\"}");
  say("command %s", cmd);
  char reply[1024];
  if (strcmp(cmd, "status") == 0) {
    if (session_request("status", reply, sizeof reply, 3000)) return send_json("{\"ok\":false,\"error\":\"%s\"}", reply);
    static int fingerprinted = 0;
    static char session_hash[65], bridge_hash[65], libc_hash[65];
    if (!fingerprinted) {
      executable_hash("/usr/lib/xmp/xmp-live-session", session_hash);
      executable_hash("/usr/lib/xmp/xmp-bridge", bridge_hash);
      executable_hash("/lib/libc.so.6", libc_hash);
      fingerprinted = 1;
    }
    return send_json("{\"ok\":true,\"session\":%s,\"image\":{\"sessionSha256\":\"%s\",\"bridgeSha256\":\"%s\",\"libcSha256\":\"%s\"}}",
                     reply, session_hash, bridge_hash, libc_hash);
  }
  if (strcmp(cmd, "log") == 0) {
    char path[256];
    if (!newest_session_log(path, sizeof path)) return send_json("{\"ok\":false,\"error\":\"no session log\"}");
    send_json("{\"ok\":true,\"path\":\"%s\"}", path);
    return send_file(path, 4u * 1024 * 1024);
  }
  if (strcmp(cmd, "screenshot") == 0) return screenshot(json_number(request, "rle", 0) == 1), 0;
  if (strcmp(cmd, "input") == 0) {
    /* One input line: pad N V | button HH | control HH VV | touch X Y */
    char line[128];
    if (!json_string(request, "line", line, sizeof line) ||
        !(strncmp(line, "pad ", 4) == 0 || strncmp(line, "button ", 7) == 0 || strncmp(line, "control ", 8) == 0 ||
          strncmp(line, "touch ", 6) == 0))
      return send_json("{\"ok\":false,\"error\":\"input is pad, button, control or touch\"}");
    session_request(line, reply, sizeof reply, 3000);
    return send_json("{\"ok\":%s,\"reply\":\"%s\"}", strcmp(reply, "ok") == 0 ? "true" : "false", reply);
  }
  if (strcmp(cmd, "record") == 0) return record(request), 0;
  if (strcmp(cmd, "push-image") == 0) return push_image(request), 0;
  if (strcmp(cmd, "restart") == 0 || strcmp(cmd, "reboot") == 0 || strcmp(cmd, "power-off") == 0) {
    const char *how = strcmp(cmd, "restart") == 0 ? "quit restart" : strcmp(cmd, "reboot") == 0 ? "quit reboot" : "quit poweroff";
    send_json("{\"ok\":true,\"command\":\"%s\"}", cmd);
    session_request(how, reply, sizeof reply, 2000);
    return 0;
  }
  return send_json("{\"ok\":false,\"error\":\"unknown command\"}");
}

/* Waits for a link: exactly one FTDI cable (preferred), else the gadget's
 * serial port. More than one cable is refused. */
static void acquire_link(int gadget) {
  int warned = 0;
  for (;;) {
    char cable[300] = "";
    const int cables = find_cable(cable, sizeof cable);
    if (cables == 1) {
      link_fd = open_cable(cable);
      if (link_fd >= 0) {
        link_is_cable = 1;
        snprintf(link_path, sizeof link_path, "%s", cable);
        say("ready on %s (the FTDI cable, 921600 baud)", cable);
        write_state("connected");
        return;
      }
      if (!warned) say("the FTDI cable %s would not open (%s)", cable, strerror(errno)), warned = 1;
    } else if (cables > 1 && !warned) {
      say("%d FTDI cables attached: using none; connect one", cables);
      warned = 1;
    }
    if (gadget && cables != 1) {
      link_fd = open("/dev/ttyGS0", O_RDWR | O_NOCTTY | O_CLOEXEC | O_NONBLOCK);
      if (link_fd >= 0) {
        fcntl(link_fd, F_SETFL, fcntl(link_fd, F_GETFL) & ~O_NONBLOCK);
        struct termios tio;
        if (tcgetattr(link_fd, &tio) == 0) {
          cfmakeraw(&tio);
          tcsetattr(link_fd, TCSANOW, &tio);
        }
        snprintf(link_path, sizeof link_path, "/dev/ttyGS0");
        say("ready on /dev/ttyGS0 (the USB-B gadget)");
        return;
      }
    }
    usleep(500000);
  }
}

int main(int argc, char **argv) {
  const char *udc_arg = "none";
  for (int i = 1; i + 1 < argc; i += 2) {
    if (strcmp(argv[i], "--udc") == 0) udc_arg = argv[i + 1];
    else if (strcmp(argv[i], "--stick") == 0) snprintf(stick, sizeof stick, "%s", argv[i + 1]);
  }
  if (strcmp(udc_arg, "none") != 0 && strcmp(udc_arg, "dummy_udc.2") != 0) {
    fprintf(stderr, "USB gadget is private-test-only; production must use --udc none and FTDI\n");
    return 1;
  }
  char path[256];
  snprintf(path, sizeof path, "%s/xmp/logs/bridge.txt", stick);
  bridge_log = fopen(path, "a");
  char udc[64];
  write_state("off");
  if (strcmp(udc_arg, "none") != 0) mount("debugfs", "/sys/kernel/debug", "debugfs", 0, NULL);
  int gadget = 0;
  /* 1209:0001 is private-test-only. Production uses FTDI, never this gadget. */
  if (strcmp(udc_arg, "none") == 0 || !pick_udc(udc_arg, udc, sizeof udc)) {
    say("no USB device controller for the gadget; the FTDI cable only");
  } else {
    snprintf(udc_name, sizeof udc_name, "%s", udc);
    log_dwc2("before binding");
    if (make_gadget(udc) == 0) {
      gadget = 1;
      pthread_t watcher;
      pthread_create(&watcher, NULL, watch_connection, NULL);
      pthread_detach(watcher);
    } else {
      say("no gadget; the FTDI cable only");
    }
  }
  char token[160] = "";
  snprintf(path, sizeof path, "%s/xmp/bridge.token", stick);
  FILE *t = fopen(path, "r");
  if (t) {
    if (fgets(token, sizeof token, t)) token[strcspn(token, "\r\n")] = 0;
    fclose(t);
  }
  say("token %s", token[0] ? "present" : "missing (hello will be refused)");
  acquire_link(gadget);
  int authorized = 0;
  static char request[MAX_REQUEST + 1];
  for (;;) {
    uint8_t header[4];
    if (read_exact(header, 4, link_is_cable ? -1 : 1000)) {
      authorized = 0;
      char cable[300];
      if (!link_is_cable && find_cable(cable, sizeof cable) == 1) {
        /* A cable plugged in while on the gadget: the cable it is. */
        close(link_fd), link_fd = -1;
        acquire_link(gadget);
      } else if (link_is_cable && access(link_path, F_OK) != 0) {
        /* The cable came out: wait for it (or the gadget) again. */
        say("the FTDI cable %s is gone", link_path);
        close(link_fd), link_fd = -1, link_is_cable = 0;
        write_state("ready");
        acquire_link(gadget);
      } else {
        usleep(200000); /* host gone: wait for it to come back */
      }
      continue;
    }
    uint32_t size = (uint32_t)header[0] << 24 | header[1] << 16 | header[2] << 8 | header[3];
    if (size == 0 || size > MAX_REQUEST) {
      /* Out of step or oversized: drain what is there and refuse. */
      tcflush(link_fd, TCIFLUSH);
      send_json("{\"ok\":false,\"error\":\"request frames are 1..65536 bytes\"}");
      continue;
    }
    if (read_exact(request, size, 5000)) continue;
    request[size] = 0;
    handle(request, &authorized, token);
  }
}
