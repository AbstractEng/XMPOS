/* Stand-in /sbin/init for the stick loader's emulator test only (never on the
 * Live). Built twice: XMP_TEST_ROLE "stock" plays Akai's system on the
 * protected root disk, "xmp" plays an XMP system image on the stick. It
 * reports what the loader handed it, then powers the emulator off. */
#include <stdio.h>
#include <sys/reboot.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <unistd.h>

#ifndef XMP_TEST_ROLE
#error "define XMP_TEST_ROLE"
#endif

int main(void) {
  struct statvfs root;
  int root_ro = statvfs("/", &root) == 0 && (root.f_flag & ST_RDONLY);
  FILE *probe = fopen("/tmp-write-test", "w");
  int writable = probe != NULL;
  if (probe) fclose(probe);
  struct stat media;
  int stick = stat("/media/xmp/xmp/system.img", &media) == 0;
  printf("LOADER-TEST %s pid=%d root_ro=%d root_writable=%d stick=%d proc=%d\n", XMP_TEST_ROLE, (int)getpid(),
         root_ro, writable, stick, access("/proc/cmdline", R_OK) == 0);
  fflush(stdout);
  sync();
  reboot(RB_POWER_OFF);
  return 0;
}
