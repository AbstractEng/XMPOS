"""Run the actual production push/SHA/JSON bodies with local frames and files."""
from pathlib import Path
import json
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
HEAD = r'''
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
static char stick[256],reply[2048];
static unsigned char *incoming;
static size_t incoming_size,incoming_at;
static const char *mode;
static int syncs, closes, renames, statuses;
static int read_exact(void*p,size_t n,int timeout) {
 (void)timeout;if(n>incoming_size-incoming_at)return -1;
 memcpy(p,incoming+incoming_at,n);incoming_at+=n;return 0;
}
static int send_json(const char*fmt,...) {
 va_list a;va_start(a,fmt);vsnprintf(reply,sizeof reply,fmt,a);va_end(a);return 0;
}
static void say(const char*fmt,...) {(void)fmt;}
static int session_request(const char*a,char*b,size_t n,int t) {
 (void)a;(void)t;statuses++;
 snprintf(b,n,"{\"playing\":false,\"recording\":false,\"saveState\":\"%s\"}",
 !strcmp(mode,"unsaved")||(!strcmp(mode,"changed-during-transfer")&&statuses>1)?"unsaved":"saved");return 0;
}
static int fault_sync(int fd) {
 if(!strcmp(mode,"sync")&&++syncs==1){errno=EIO;return -1;}return fsync(fd);
}
static int fault_close(int fd) {
 int result=close(fd);if(!strcmp(mode,"close")&&++closes==1){errno=EIO;return -1;}return result;
}
static int fault_rename(int a,const char*b,int c,const char*d) {
 renames++;if((!strcmp(mode,"rename-backup")&&renames==1)||(!strcmp(mode,"rename-active")&&renames==2)){errno=EIO;return -1;}
 return renameat(a,b,c,d);
}
#define fsync fault_sync
#define close fault_close
#define renameat fault_rename
#include "image-update.h"
'''
TAIL = r'''
#undef fsync
#undef close
#undef renameat
static void image(const char*p,char tag) {
 int fd=open(p,O_CREAT|O_WRONLY,0644);assert(fd>=0);
 assert(ftruncate(fd,XMP_OWNER_IMAGE_BYTES)==0);assert(write(fd,&tag,1)==1);close(fd);
}
static char tag(const char*p) {char b=0;int fd=open(p,O_RDONLY);if(fd<0)return 0;assert(read(fd,&b,1)==1);close(fd);return b;}
int main(int argc,char**argv) {
 assert(argc==3);assert(strlen(argv[1])<sizeof stick);strcpy(stick,argv[1]);mode=argv[2];
 char directory[300],active[320],previous[320];snprintf(directory,sizeof directory,"%s/xmp",stick);assert(mkdir(directory,0700)==0);
 snprintf(active,sizeof active,"%s/system.img",directory);snprintf(previous,sizeof previous,"%s/system.img.previous",directory);
 image(active,'A');image(previous,'P');
 size_t size=XMP_OWNER_IMAGE_BYTES;unsigned char *payload=calloc(1,size);assert(payload);
 payload[0]='B';payload[1080]=0x53;payload[1081]=0xef;payload[1048]=2;payload[1113]=1;memcpy(payload+1144,"xmpsys",6);
 if(!strcmp(mode,"non-image"))memset(payload,0,size);
 sha256 h;char digest[65];sha_init(&h);sha_update(&h,payload,size);sha_hex(&h,digest);
 if(!strcmp(mode,"hash"))memset(digest,'0',64);
 incoming=malloc(size+4);assert(incoming);incoming_size=size+4;
 incoming[0]=size>>24;incoming[1]=size>>16;incoming[2]=size>>8;incoming[3]=size;memcpy(incoming+4,payload,size);
 if(!strcmp(mode,"truncated"))incoming_size=100;
 int sparse=!strcmp(mode,"bad-sparse")||!strcmp(mode,"valid-sparse");
 if(sparse) {
   /* One full data record; invalid case uses an unsupported record kind. */
   free(incoming);incoming_size=size+9;incoming=malloc(incoming_size);assert(incoming);
   size_t frame_size=size+5;incoming[0]=frame_size>>24;incoming[1]=frame_size>>16;incoming[2]=frame_size>>8;incoming[3]=frame_size;
   incoming[4]=!strcmp(mode,"bad-sparse")?2:1;incoming[5]=size>>24;incoming[6]=size>>16;incoming[7]=size>>8;incoming[8]=size;
   memcpy(incoming+9,payload,size);
 }
 char request[1024];snprintf(request,sizeof request,
 "{\"size\":%zu,\"sha256\":\"%s\",\"sparse\":%d,\"profile\":\"%s\",\"target\":\"%s\",\"mpcOsVersion\":\"%s\",\"sourceHash\":\"%064d\"}",
 !strcmp(mode,"size")?size+1:size,digest,sparse,!strcmp(mode,"profile")?"legacy":"xmp-owner-image-v1",
 !strcmp(mode,"force")?"inmusic,ada2":"inmusic,acv8",!strcmp(mode,"os")?"3.10.0":"3.10.1",0);
 push_image(request);
 int accepted=!strcmp(mode,"valid")||!strcmp(mode,"valid-sparse");
 assert(tag(active));assert(strstr(reply,accepted?"\"installed\":true":"\"ok\":false"));
 assert(tag(active)==(accepted?'B':'A'));
 if(!accepted)assert(tag(active)=='A');else assert(tag(previous)=='A');
 printf("%s\n",reply);free(payload);free(incoming);return 0;
}
'''


class BridgePushTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='xmp-push-code-')
        source = (ROOT / 'os/live-mk1/xmp-bridge.c').read_text()
        shared = source[source.index('/* ---- SHA-256'):source.index('/* ---- serial link ---- */')]
        push = source[source.index('static void push_image('):source.index('static void record(')]
        path = Path(cls.temp.name) / 'push.c'
        path.write_text(HEAD + shared + push + TAIL)
        cls.binary = path.with_suffix('')
        subprocess.run(['cc', '-std=gnu11', '-O2', '-Wall', '-Wextra', '-Werror', '-Wno-unused-function',
                        '-I' + str(ROOT / 'os/live-mk1'), str(path), '-o', str(cls.binary)], check=True)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def test_production_push_positive_negative_and_storage_faults(self):
        for mode in ('valid', 'valid-sparse', 'non-image', 'hash', 'truncated', 'bad-sparse', 'size',
                     'profile', 'force', 'os', 'unsaved', 'changed-during-transfer', 'sync', 'close',
                     'rename-backup', 'rename-active'):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory(prefix='xmp-push-files-') as directory:
                result = subprocess.run([str(self.binary), directory, mode], capture_output=True,
                                        text=True, timeout=30)
                self.assertEqual(result.returncode, 0, result.stderr)
                reply = json.loads(result.stdout)
                self.assertEqual(reply['ok'], mode in ('valid', 'valid-sparse'))


if __name__ == '__main__':
    unittest.main()
