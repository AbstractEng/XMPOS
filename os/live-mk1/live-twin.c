/* XMP Live twin: emulator-only stand-in for the MPC Live Mk1's internal USB
 * devices, so the unmodified Live session binary can be tested in QEMU.
 * It is in system-emulator.img only, never in the Live's system.img.
 *
 * Through the kernel's virtual USB host (dummy_hcd, emulator kernel only) it
 * creates two configfs USB gadgets that the session sees as real devices:
 *   - a two-port USB MIDI device with the controller's USB ID (09e8:003b) and
 *     product name "MPC Live Controller"
 *   - an HID touchscreen (tip switch, X 0..1280 and Y 0..720, the ranges the
 *     Live's ILI2116 reports)
 * On the gadget side it plays a controller script (pad bytes and touches),
 * and records every byte the session sends to the controller. Manufacturer
 * strings say "XMP emulator".
 *
 * The audio card is not a gadget: dummy_hcd has no isochronous endpoints, so
 * no USB audio gadget can bind. QEMU's own usb-audio device stands in for it
 * instead, with the Live card's USB ID and name (XMP's QEMU patch
 * os/live-mk1/qemu-usb-audio-ids.patch), recording to a WAV on the Mac.
 *
 * Usage: xmp-live-twin --script FILE --out DIR   (prints "XMP-TWIN ready") */
#include <alsa/asoundlib.h>
#include <dirent.h>
#include <linux/usbdevice_fs.h>
#include <sys/ioctl.h>
#include <termios.h>
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <signal.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#define GADGETS "/sys/kernel/config/usb_gadget"
static volatile sig_atomic_t stopping = 0;
static void on_term(int s) {
  (void)s;
  stopping = 1;
}
static char out_dir[256];
static FILE *twin_log;

static double now_s(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return (double)t.tv_sec + (double)t.tv_nsec / 1e9;
}
static double t0;

static void say(const char *fmt, ...) {
  char line[512];
  va_list a;
  va_start(a, fmt);
  vsnprintf(line, sizeof line, fmt, a);
  va_end(a);
  printf("XMP-TWIN %s\n", line);
  fflush(stdout);
  if (twin_log) {
    fprintf(twin_log, "%9.3f %s\n", now_s() - t0, line);
    fflush(twin_log);
  }
}

static int put(const char *path, const char *value) {
  int fd = open(path, O_WRONLY | O_CLOEXEC);
  if (fd < 0) return -1;
  ssize_t n = write(fd, value, strlen(value));
  close(fd);
  return n == (ssize_t)strlen(value) ? 0 : -1;
}
static int put_bytes(const char *path, const unsigned char *bytes, size_t size) {
  int fd = open(path, O_WRONLY | O_CLOEXEC);
  if (fd < 0) return -1;
  ssize_t n = write(fd, bytes, size);
  close(fd);
  return n == (ssize_t)size ? 0 : -1;
}

/* One gadget with one function, bound to dummy_udc.<udc>. */
static int make_gadget(const char *name, const char *vid, const char *pid, const char *product, const char *function,
                       const char *const *attrs, const unsigned char *report, size_t report_size, int udc) {
  char g[256], p[384];
  snprintf(g, sizeof g, GADGETS "/%s", name);
  mkdir(g, 0755);
  snprintf(p, sizeof p, "%s/idVendor", g), put(p, vid);
  snprintf(p, sizeof p, "%s/idProduct", g), put(p, pid);
  snprintf(p, sizeof p, "%s/bcdUSB", g), put(p, "0x0200");
  snprintf(p, sizeof p, "%s/strings/0x409", g), mkdir(p, 0755);
  snprintf(p, sizeof p, "%s/strings/0x409/manufacturer", g), put(p, "XMP emulator");
  snprintf(p, sizeof p, "%s/strings/0x409/product", g), put(p, product);
  snprintf(p, sizeof p, "%s/strings/0x409/serialnumber", g), put(p, "twin");
  snprintf(p, sizeof p, "%s/functions/%s", g, function);
  if (mkdir(p, 0755) != 0 && errno != EEXIST) {
    say("cannot create function %s (errno %d)", function, errno);
    return -1;
  }
  for (int i = 0; attrs && attrs[i]; i += 2) {
    snprintf(p, sizeof p, "%s/functions/%s/%s", g, function, attrs[i]);
    if (put(p, attrs[i + 1]) != 0) say("attribute %s=%s refused", attrs[i], attrs[i + 1]);
  }
  if (report) {
    snprintf(p, sizeof p, "%s/functions/%s/report_desc", g, function);
    put_bytes(p, report, report_size);
  }
  snprintf(p, sizeof p, "%s/configs/c.1", g), mkdir(p, 0755);
  snprintf(p, sizeof p, "%s/configs/c.1/MaxPower", g), put(p, "100");
  char target[384], link[384];
  snprintf(target, sizeof target, "%s/functions/%s", g, function);
  snprintf(link, sizeof link, "%s/configs/c.1/%s", g, function);
  symlink(target, link);
  char udc_name[32];
  snprintf(udc_name, sizeof udc_name, "dummy_udc.%d", udc);
  snprintf(p, sizeof p, "%s/UDC", g);
  if (put(p, udc_name) != 0) {
    say("cannot bind %s to %s (errno %d)", name, udc_name, errno);
    return -1;
  }
  say("gadget %s %s:%s \"%s\" on %s", name, vid + 2, pid + 2, product, udc_name);
  return 0;
}

/* Card index whose /proc/asound/cardN/id equals id, or -1. */
static int card_with_id(const char *id) {
  for (int c = 0; c < 16; c++) {
    char path[64], text[64] = {0};
    snprintf(path, sizeof path, "/proc/asound/card%d/id", c);
    FILE *f = fopen(path, "r");
    if (!f) continue;
    if (fgets(text, sizeof text, f)) text[strcspn(text, "\n")] = 0;
    fclose(f);
    if (strcmp(text, id) == 0) return c;
  }
  return -1;
}

/* ---- script: "<s> <hex>..." to port 0, "<s> p1 <hex>..." to port 1, "<s> touch <x> <y>" ---- */
struct entry {
  double at;
  int port, touch, x, y, size;
  unsigned char bytes[64];
  char wait[64]; /* "<s> wait <path>": block until the file exists, then count time from there */
};
static struct entry script[512];
static int script_size;

static int load_script(const char *path) {
  FILE *f = fopen(path, "r");
  if (!f) return 0;
  char line[512];
  while (fgets(line, sizeof line, f) && script_size < 512) {
    if (line[0] == '#' || line[0] == '\n') continue;
    struct entry e = {0};
    char *p = line, *end;
    e.at = strtod(p, &end);
    if (end == p || e.at < 0 || e.at > 600) continue;
    p = end;
    while (*p == ' ') p++;
    if (strncmp(p, "wait /tmp/", 10) == 0) {
      if (sscanf(p + 5, "%63s", e.wait) != 1) continue;
      script[script_size++] = e;
      continue;
    }
    if (strncmp(p, "touch ", 6) == 0) {
      e.touch = sscanf(p + 6, "%d %d", &e.x, &e.y) == 2 && e.x >= 0 && e.x <= 1280 && e.y >= 0 && e.y <= 720;
      if (!e.touch) continue;
    } else {
      if (strncmp(p, "p1 ", 3) == 0) e.port = 1, p += 3;
      unsigned v;
      int used;
      while (e.size < 64 && sscanf(p, "%2x%n", &v, &used) == 1) {
        e.bytes[e.size++] = (unsigned char)v;
        p += used;
        while (*p == ' ') p++;
      }
      if (!e.size) continue;
    }
    script[script_size++] = e;
  }
  fclose(f);
  return script_size;
}

/* ---- MIDI: play the script to the session, record what the session sends ---- */
static snd_rawmidi_t *midi_in[2], *midi_out[2];
static pthread_mutex_t midi_lock = PTHREAD_MUTEX_INITIALIZER; /* writes come from two threads */

/* Answers the universal identity request like the Live's controller does (on
 * both ports, same layout), with a made-up serial the session must not log. */
static const unsigned char identity_reply[] = {0xF0, 0x7E, 0x00, 0x06, 0x02, 0x47, 0x3B, 0x00, 0x19, 0x00, 0x01,
                                               0x01, 0x01, 0x7F, 0x00, 0x00, 0x00, 0x00, 'T',  'W',  'I',  'N',
                                               'S',  'E',  'R',  'I',  'A',  'L',  '0',  '0',  '0',  '1',  '0',
                                               '0',  0xF7};

static void *midi_reader(void *arg) {
  (void)arg;
  unsigned char window[2][6] = {{0}};
  int first_bytes_logged[2] = {0, 0}, read_error_logged[2] = {0, 0};
  char path[320];
  snprintf(path, sizeof path, "%s/controller-received.txt", out_dir);
  FILE *f = fopen(path, "w");
  while (!stopping) {
    for (int port = 0; port < 2; port++) {
      unsigned char b[256];
      ssize_t n = midi_in[port] ? snd_rawmidi_read(midi_in[port], b, sizeof b) : 0;
      if (n < 0 && n != -EAGAIN && !read_error_logged[port]) {
        read_error_logged[port] = 1;
        say("controller port %d: read error %d", port, (int)n);
      }
      if (n > 0 && !first_bytes_logged[port]) {
        first_bytes_logged[port] = 1;
        say("controller port %d: received the session's first bytes", port);
      }
      if (n > 0 && f) {
        fprintf(f, "%.3f port %d:", now_s() - t0, port);
        for (ssize_t i = 0; i < n; i++) fprintf(f, " %02X", b[i]);
        fputc('\n', f);
        fflush(f);
      }
      for (ssize_t i = 0; i < n; i++) {
        memmove(window[port], window[port] + 1, 5);
        window[port][5] = b[i];
        const unsigned char *w = window[port];
        if (w[0] == 0xF0 && w[1] == 0x7E && w[3] == 0x06 && w[4] == 0x01 && w[5] == 0xF7)
          for (int q = 0; q < 2; q++)
            if (midi_out[q]) {
              pthread_mutex_lock(&midi_lock);
              snd_rawmidi_write(midi_out[q], identity_reply, sizeof identity_reply);
              snd_rawmidi_drain(midi_out[q]);
              pthread_mutex_unlock(&midi_lock);
            }
      }
    }
    usleep(2000);
  }
  if (f) fclose(f);
  return NULL;
}

static void touch_report(int fd, int tip, int x, int y) {
  unsigned char r[5] = {(unsigned char)(tip ? 1 : 0), (unsigned char)(x & 255), (unsigned char)(x >> 8),
                        (unsigned char)(y & 255), (unsigned char)(y >> 8)};
  if (write(fd, r, sizeof r) != (ssize_t)sizeof r) say("touch report not accepted (errno %d)", errno);
}

static void *script_player(void *arg) {
  (void)arg;
  int touch_fd = -1;
  for (int i = 0; i < 50 && touch_fd < 0; i++) {
    touch_fd = open("/dev/hidg0", O_RDWR | O_CLOEXEC);
    if (touch_fd < 0) usleep(100000);
  }
  for (int i = 0; i < script_size && !stopping; i++) {
    while (!stopping && now_s() - t0 < script[i].at) usleep(1000);
    const struct entry *e = &script[i];
    if (e->wait[0]) {
      struct stat st;
      for (int w = 0; w < 9000 && !stopping && stat(e->wait, &st) != 0; w++) usleep(100000);
      say("script: %s %s", e->wait, stat(e->wait, &st) == 0 ? "appeared" : "never appeared");
      t0 = now_s() - e->at; /* later entries count from here */
      continue;
    }
    if (e->touch) {
      if (touch_fd >= 0) {
        touch_report(touch_fd, 1, e->x, e->y);
        usleep(40000);
        touch_report(touch_fd, 0, e->x, e->y);
      }
    } else if (midi_out[e->port]) {
      say("script: sent %d bytes to port %d (%02X %02X %02X)", e->size, e->port, e->bytes[0], e->size > 1 ? e->bytes[1] : 0,
          e->size > 2 ? e->bytes[2] : 0);
      pthread_mutex_lock(&midi_lock);
      snd_rawmidi_write(midi_out[e->port], e->bytes, (size_t)e->size);
      snd_rawmidi_drain(midi_out[e->port]);
      pthread_mutex_unlock(&midi_lock);
    }
  }
  for (int i = 0; i < 200 && !stopping; i++) usleep(10000); /* let the last notes sound */
  say("script done (%d entries)", script_size);
  if (touch_fd >= 0) close(touch_fd);
  return NULL;
}

/* ---- bridge relay: the bridge's USB serial (1209:0001) <-> /dev/hvc0 ----
 * In the emulator the bridge gadget is on a dummy UDC, so its host side is in
 * the guest. The twin drives its CDC data interface through usbfs and copies
 * bytes to the virtio console that QEMU connects to a socket on the Mac. */
static int bridge_usb = -1, hvc = -1, ep_in = -1, ep_out = -1;

static int read_hex_file(const char *path) {
  char text[16] = {0};
  FILE *f = fopen(path, "r");
  if (!f) return -1;
  if (!fgets(text, sizeof text, f)) text[0] = 0;
  fclose(f);
  return (int)strtol(text, NULL, 16);
}

static int find_bridge_device(void) {
  DIR *d = opendir("/sys/bus/usb/devices");
  struct dirent *e;
  int found = -1;
  while (d && (e = readdir(d)) && found < 0) {
    char p[320];
    snprintf(p, sizeof p, "/sys/bus/usb/devices/%s/idVendor", e->d_name);
    if (read_hex_file(p) != 0x1209) continue;
    snprintf(p, sizeof p, "/sys/bus/usb/devices/%s/idProduct", e->d_name);
    if (read_hex_file(p) != 0x0001) continue;
    int bus, dev;
    snprintf(p, sizeof p, "/sys/bus/usb/devices/%s/busnum", e->d_name);
    FILE *f = fopen(p, "r");
    if (!f || fscanf(f, "%d", &bus) != 1) {
      if (f) fclose(f);
      continue;
    }
    fclose(f);
    snprintf(p, sizeof p, "/sys/bus/usb/devices/%s/devnum", e->d_name);
    f = fopen(p, "r");
    if (!f || fscanf(f, "%d", &dev) != 1) {
      if (f) fclose(f);
      continue;
    }
    fclose(f);
    snprintf(p, sizeof p, "/dev/bus/usb/%03d/%03d", bus, dev);
    found = open(p, O_RDWR | O_CLOEXEC);
  }
  if (d) closedir(d);
  return found;
}

/* Finds the bulk endpoints of the CDC data interface (class 0x0A) and claims it. */
static int claim_data_interface(int fd) {
  unsigned char desc[1024];
  ssize_t n = read(fd, desc, sizeof desc); /* device + configuration descriptors */
  int iface = -1, data_iface = -1;
  for (ssize_t i = 0; i + 1 < n && desc[i] > 0; i += desc[i]) {
    if (desc[i + 1] == 4) iface = desc[i + 5] == 0x0A ? desc[i + 2] : -1;
    if (desc[i + 1] == 5 && iface >= 0 && (desc[i + 3] & 3) == 2) {
      data_iface = iface;
      if (desc[i + 2] & 0x80) ep_in = desc[i + 2];
      else ep_out = desc[i + 2];
    }
  }
  if (data_iface < 0 || ep_in < 0 || ep_out < 0) return -1;
  unsigned int claim = 0;
  ioctl(fd, USBDEVFS_CLAIMINTERFACE, &claim); /* control interface, for the line state */
  claim = (unsigned)data_iface;
  if (ioctl(fd, USBDEVFS_CLAIMINTERFACE, &claim) != 0) return -1;
  struct usbdevfs_ctrltransfer dtr = {.bRequestType = 0x21, .bRequest = 0x22, .wValue = 3, .wIndex = 0,
                                      .wLength = 0, .timeout = 1000, .data = NULL};
  ioctl(fd, USBDEVFS_CONTROL, &dtr); /* SET_CONTROL_LINE_STATE: DTR | RTS */
  return 0;
}

static void *relay_usb_to_console(void *arg) {
  (void)arg;
  static unsigned char buffer[16384];
  while (!stopping) {
    struct usbdevfs_bulktransfer t = {.ep = (unsigned)ep_in, .len = sizeof buffer, .timeout = 200, .data = buffer};
    int n = ioctl(bridge_usb, USBDEVFS_BULK, &t);
    if (n > 0) {
      for (int done = 0; done < n;) {
        ssize_t w = write(hvc, buffer + done, (size_t)(n - done));
        if (w <= 0) break;
        done += (int)w;
      }
    } else if (n < 0 && errno != ETIMEDOUT) {
      usleep(10000);
    }
  }
  return NULL;
}

static void *relay_console_to_usb(void *arg) {
  (void)arg;
  static unsigned char buffer[16384];
  while (!stopping) {
    ssize_t n = read(hvc, buffer, sizeof buffer);
    if (n <= 0) {
      usleep(10000);
      continue;
    }
    for (ssize_t done = 0; done < n;) {
      size_t chunk = (size_t)(n - done) < 4096 ? (size_t)(n - done) : 4096;
      struct usbdevfs_bulktransfer t = {.ep = (unsigned)ep_out, .len = (unsigned)chunk, .timeout = 5000,
                                        .data = buffer + done};
      int w = ioctl(bridge_usb, USBDEVFS_BULK, &t);
      if (w <= 0) break;
      done += w;
    }
  }
  return NULL;
}

static void *bridge_relay(void *arg) {
  (void)arg;
  for (int i = 0; i < 600 && !stopping && (hvc = open("/dev/hvc0", O_RDWR | O_NOCTTY | O_CLOEXEC)) < 0; i++)
    usleep(100000);
  if (hvc < 0) return NULL; /* no virtio console: this run does not test the bridge */
  struct termios tio;
  if (tcgetattr(hvc, &tio) == 0) {
    cfmakeraw(&tio);
    tcsetattr(hvc, TCSANOW, &tio);
  }
  for (int i = 0; i < 600 && !stopping && bridge_usb < 0; i++) {
    bridge_usb = find_bridge_device();
    if (bridge_usb < 0) usleep(100000);
  }
  if (bridge_usb < 0 || claim_data_interface(bridge_usb) != 0) {
    say("bridge relay: no XMP bridge device");
    return NULL;
  }
  say("bridge relay: 1209:0001 endpoints %02x/%02x <-> /dev/hvc0", ep_in, ep_out);
  pthread_t a, b;
  pthread_create(&a, NULL, relay_usb_to_console, NULL);
  pthread_create(&b, NULL, relay_console_to_usb, NULL);
  pthread_join(a, NULL);
  pthread_join(b, NULL);
  return NULL;
}

int main(int argc, char **argv) {
  const char *script_path = NULL, *out = NULL;
  for (int i = 1; i + 1 < argc; i += 2) {
    if (strcmp(argv[i], "--script") == 0) script_path = argv[i + 1];
    else if (strcmp(argv[i], "--out") == 0) out = argv[i + 1];
  }
  if (!out) return 2;
  t0 = now_s();
  snprintf(out_dir, sizeof out_dir, "%s", out);
  mkdir(out_dir, 0755);
  char log_path[320];
  snprintf(log_path, sizeof log_path, "%s/twin-log.txt", out_dir);
  twin_log = fopen(log_path, "w");
  signal(SIGTERM, on_term);
  mount("configfs", "/sys/kernel/config", "configfs", 0, NULL);

  static const char *const midi_attrs[] = {"in_ports", "2", "out_ports", "2", "id", "TwinCtrl", NULL};
  static const char *const touch_attrs[] = {"protocol", "0", "subclass", "0", "report_length", "5", NULL};
  /* Single-touch digitizer: tip switch, 7 bits padding, X 0..1280, Y 0..720. */
  static const unsigned char touch_desc[] = {
      0x05, 0x0D, 0x09, 0x04, 0xA1, 0x01, 0x09, 0x22, 0xA1, 0x02, 0x09, 0x42, 0x15, 0x00, 0x25, 0x01,
      0x75, 0x01, 0x95, 0x01, 0x81, 0x02, 0x95, 0x07, 0x81, 0x03, 0x05, 0x01, 0x09, 0x30, 0x15, 0x00,
      0x26, 0x00, 0x05, 0x75, 0x10, 0x95, 0x01, 0x81, 0x02, 0x09, 0x31, 0x26, 0xD0, 0x02, 0x81, 0x02,
      0xC0, 0xC0};
  int ok = make_gadget("controller", "0x09e8", "0x003b", "MPC Live Controller", "midi.usb0", midi_attrs, NULL, 0, 0) == 0;
  ok = make_gadget("touch", "0x1d6b", "0x0104", "XMP twin touchscreen", "hid.usb0", touch_attrs, touch_desc,
                   sizeof touch_desc, 1) == 0 && ok;
  if (!ok) {
    say("gadget setup failed");
    return 1;
  }

  /* Gadget-side card: f_midi (id TwinCtrl). */
  int midi_card = -1;
  for (int i = 0; i < 100 && midi_card < 0; i++) {
    midi_card = card_with_id("TwinCtrl");
    if (midi_card < 0) usleep(100000);
  }
  say("gadget-side cards: controller %d", midi_card);
  if (midi_card >= 0) {
    for (int port = 0; port < 2; port++) {
      char name[32];
      snprintf(name, sizeof name, "hw:%d,0,%d", midi_card, port);
      if (snd_rawmidi_open(&midi_in[port], &midi_out[port], name, SND_RAWMIDI_NONBLOCK) < 0)
        say("cannot open %s", name);
      else
        snd_rawmidi_nonblock(midi_out[port], 0);
    }
  }
  if (script_path) say("script: %d entries", load_script(script_path));

  pthread_t reader, player, relay;
  pthread_create(&reader, NULL, midi_reader, NULL);
  pthread_create(&relay, NULL, bridge_relay, NULL);
  pthread_detach(relay);
  /* Host side ready: both USB-audio cards bound. */
  for (int i = 0; i < 100; i++) {
    FILE *f = fopen("/proc/asound/cards", "r");
    char text[4096] = {0};
    if (f) {
      size_t n = fread(text, 1, sizeof text - 1, f);
      text[n] = 0;
      fclose(f);
    }
    if (strstr(text, "MPC Live Controller") && strstr(text, "MPC Live Audio")) break;
    usleep(100000);
  }
  t0 = now_s(); /* script times count from the moment the session is started */
  say("ready");
  FILE *ready = fopen("/tmp/xmp-twin-ready", "w");
  if (ready) fclose(ready);
  pthread_create(&player, NULL, script_player, NULL);

  /* A sleep loop, not pause(): a SIGTERM landing between the check and pause()
   * would otherwise never wake it, and the init waits for the twin. */
  while (!stopping) usleep(100000);
  pthread_join(player, NULL);
  pthread_join(reader, NULL);
  for (int port = 0; port < 2; port++) {
    if (midi_in[port]) snd_rawmidi_close(midi_in[port]);
    if (midi_out[port]) snd_rawmidi_close(midi_out[port]);
  }
  /* The kernel's own byte counters for the gadget-side MIDI ports. */
  if (midi_card >= 0) {
    char path[64], text[1024] = {0};
    snprintf(path, sizeof path, "/proc/asound/card%d/midi0", midi_card);
    FILE *m = fopen(path, "r");
    if (m) {
      size_t n = fread(text, 1, sizeof text - 1, m);
      text[n] = 0;
      fclose(m);
      for (char *line = strtok(text, "\n"); line; line = strtok(NULL, "\n")) say("midi0: %s", line);
    }
  }
  say("stopped");
  if (twin_log) fclose(twin_log);
  sync();
  return 0;
}
