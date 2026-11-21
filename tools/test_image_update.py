"""Execute the shared production transaction code with local file faults.

Every metadata syscall position and representative data-copy positions fail once.
No USB, daemon, mounts or reboot.
"""
from pathlib import Path
import json
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
HARNESS = r'''
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
static const char *operation;
static int at, count, counts[6];
static int fail(const char *name, int index) {
  counts[index]++;
  if (strcmp(operation, name)) return 0;
  if (++count != at) return 0;
  errno = EIO; return 1;
}
static int fault_openat(int d,const char*p,int f,...) {
  if(fail("open",0))return -1;
  return openat(d,p,f,0644);
}
static int fault_renameat(int a,const char*b,int c,const char*d) {
  return fail("rename",1)?-1:renameat(a,b,c,d);
}
static int fault_fsync(int fd) { return fail("sync",2)?-1:fsync(fd); }
static int fault_close(int fd) { int bad=fail("close",3);int result=close(fd);return bad?-1:result; }
static ssize_t fault_read(int fd,void*p,size_t n) {return fail("read",4)?-1:read(fd,p,n);}
static ssize_t fault_write(int fd,const void*p,size_t n) {
  if(fail("write",5))return -1;
  /* Exercise partial writes in every successful copy. */
  return write(fd,p,n>8192?8192:n);
}
#define openat fault_openat
#define renameat fault_renameat
#define fsync fault_fsync
#define close fault_close
#define read fault_read
#define write fault_write
#include "image-update.h"
#undef openat
#undef renameat
#undef fsync
#undef close
#undef read
#undef write
static void image(int dir,const char *name,char tag) {
 int fd=openat(dir,name,O_CREAT|O_RDWR|O_TRUNC,0644);assert(fd>=0);
 assert(ftruncate(fd,XMP_OWNER_IMAGE_BYTES)==0);assert(write(fd,&tag,1)==1);assert(close(fd)==0);
}
static char tag(int dir,const char *name) {
 char b=0;int fd=openat(dir,name,O_RDONLY|O_NOFOLLOW);if(fd<0)return 0;
 assert(read(fd,&b,1)==1);assert(xmp_image_regular(fd));close(fd);return b;
}
int main(int argc,char **argv) {
 assert(argc==5);int dir=open(argv[1],O_RDONLY|O_DIRECTORY);assert(dir>=0);
 image(dir,"system.img",'A');image(dir,"system.img.previous",'P');image(dir,"system.img.new",'B');
 operation=argv[3];at=atoi(argv[4]);int fallback=!strcmp(argv[2],"fallback");
 int result=fallback?xmp_fallback_image(dir):xmp_promote_image(dir);
 char active=tag(dir,"system.img"),previous=tag(dir,"system.img.previous");
 assert(active); /* No failure may leave the active name absent. */
 if(result==0) {
   assert(active==(fallback?'P':'B'));assert(previous==(fallback?'P':'A'));
 } else {
   assert(active=='A'||(!fallback&&active=='B')||(fallback&&active=='P'));
   assert(previous=='P'||(!fallback&&previous=='A'));
 }
 int measured[6];memcpy(measured,counts,sizeof counts);
 if(fallback && faccessat(dir,".fallback-tried",F_OK,0)==0) { operation="none";assert(xmp_fallback_image(dir)<0); }
 printf("{\"result\":%d,\"active\":\"%c\",\"previous\":\"%c\",\"counts\":[%d,%d,%d,%d,%d,%d]}\n",
 result,active,previous,measured[0],measured[1],measured[2],measured[3],measured[4],measured[5]);
 close(dir);return 0;
}
'''


class ImageTransactionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='xmp-update-code-')
        source = Path(cls.temp.name) / 'test.c'
        source.write_text(HARNESS)
        cls.binary = source.with_suffix('')
        subprocess.run(['cc', '-std=gnu11', '-Wall', '-Wextra', '-Werror',
                        '-I' + str(ROOT / 'os/live-mk1'), str(source), '-o', str(cls.binary)], check=True)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def run_case(self, mode, operation='none', at=0):
        with tempfile.TemporaryDirectory(prefix='xmp-update-files-') as directory:
            result = subprocess.run([str(self.binary), directory, mode, operation, str(at)],
                                    capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout)

    def test_promotion_every_io_failure_retains_active_and_recoverable_previous(self):
        self.check_faults('promotion')

    def test_fallback_every_io_failure_is_bounded_and_never_consumes_previous(self):
        self.check_faults('fallback')

    def check_faults(self, mode):
        normal = self.run_case(mode)
        self.assertEqual(normal['result'], 0)
        for operation, count in zip(('open', 'rename', 'sync', 'close', 'read', 'write'), normal['counts']):
            # Read/write loops: first, middle and final positions exercise each
            # transition without thousands of redundant 32 MiB copy runs.
            positions = range(1, count + 1) if count < 20 else (1, count // 2, count)
            for at in positions:
                with self.subTest(mode=mode, operation=operation, at=at):
                    self.assertLess(self.run_case(mode, operation, at)['result'], 0)


if __name__ == '__main__':
    unittest.main()
