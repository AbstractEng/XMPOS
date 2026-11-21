/* Bounded file-only conformance host. No device, audio backend or module loader. */
#define _DARWIN_C_SOURCE
#define _POSIX_C_SOURCE 200809L
#include "community_dsp.h"
#include <stdio.h>
#include <stdlib.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
typedef struct {uint32_t frame,op,id,arg;double value;uint32_t accepted;} event;
static int valid=1;
static uint32_t get32(FILE* f){uint32_t v=0;int i;for(i=0;i<4;i++){int c=fgetc(f);if(c==EOF){valid=0;return 0;}v|=(uint32_t)c<<(8*i);}return v;}
static double get64(FILE* f){uint64_t bits=(uint64_t)get32(f),hi=(uint64_t)get32(f);double v;bits|=hi<<32;memcpy(&v,&bits,8);if(!isfinite(v))valid=0;return v;}
static void put32(FILE* f,uint32_t n){int i;for(i=0;i<4;i++)fputc((n>>(8*i))&255,f);}
static void put64(FILE* f,double v){uint64_t b;memcpy(&b,&v,8);put32(f,(uint32_t)b);put32(f,(uint32_t)(b>>32));}
static int basename_ok(const char* s){size_t i,n=strlen(s);if(!n||n>100||!strcmp(s,".")||!strcmp(s,".."))return 0;for(i=0;i<n;i++)if(!((s[i]>='a'&&s[i]<='z')||(s[i]>='A'&&s[i]<='Z')||(s[i]>='0'&&s[i]<='9')||s[i]=='-'||s[i]=='_'||s[i]=='.'))return 0;return 1;}
int main(int argc,char** argv){
 FILE *in,*out;struct stat info;char magic[4];uint32_t rate,frames,source,count,i,next=0,frame,active;double gain,cutoff;event events[256];float* pcm;xmp_parity_dsp dsp;int fd;
 if(argc!=3||!basename_ok(argv[1])||!basename_ok(argv[2]))return 2;
 if(lstat(argv[1],&info)||!S_ISREG(info.st_mode)||info.st_size>6184)return 3;
 in=fopen(argv[1],"rb");if(!in)return 3;
 if(fread(magic,1,4,in)!=4||memcmp(magic,"XMPD",4)||get32(in)!=1){fclose(in);return 4;}
 rate=get32(in);frames=get32(in);source=get32(in);count=get32(in);gain=get64(in);cutoff=get64(in);
 if(rate!=48000||frames<480||frames>48000||source>2||count>256||gain<0||gain>1||cutoff<20||cutoff>20000)valid=0;
 if(!valid){fclose(in);return 4;}
 for(i=0;i<count;i++){
  event* e=&events[i];e->frame=get32(in);e->op=get32(in);e->id=get32(in);e->arg=get32(in);e->value=get64(in);e->accepted=0;
  if(e->frame>=frames||(i&&e->frame<events[i-1].frame)||e->op<1||e->op>5)valid=0;
  if(e->op<=3&&(source==2||e->id<1||e->id>0x7fffffff))valid=0;
  if(e->op==1&&(e->arg>127||e->value<0||e->value>1))valid=0;
  if(e->op==2&&(e->arg||e->value))valid=0;
  if(e->op==3&&(e->arg<1||e->arg>3||(e->arg==2?(e->value < -48||e->value>48):(e->value<0||e->value>1))))valid=0;
  if(e->op==4&&(e->id||e->arg<1||e->arg>2||(e->arg==1?(e->value<0||e->value>1):(e->value<20||e->value>20000))))valid=0;
  if(e->op==5&&(e->id||e->arg||e->value))valid=0;
 }
 if(fgetc(in)!=EOF)valid=0;
 fclose(in);
 if(!valid)return 4;
 pcm=(float*)calloc(frames,sizeof(float));if(!pcm)return 5;
 xmp_native_init(&dsp,source,gain,cutoff);
 for(frame=0;frame<frames;frame++){
  while(next<count&&events[next].frame==frame){event* e=&events[next++];e->accepted=xmp_native_event(&dsp,e->op,e->id,e->arg,e->value);e->frame=frame;}
  pcm[frame]=xmp_native_process(&dsp,source==2&&frame==0?.5f:0);
 }
 active=xmp_native_active(&dsp);
 fd=open(argv[2],O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW,0600);if(fd<0){free(pcm);return 6;}out=fdopen(fd,"wb");if(!out){close(fd);free(pcm);return 6;}
 fwrite("XMPR",1,4,out);put32(out,1);put32(out,rate);put32(out,frames);put32(out,count);put32(out,active);
 for(i=0;i<count;i++){event* e=&events[i];put32(out,e->frame);put32(out,e->op);put32(out,e->id);put32(out,e->arg);put64(out,e->value);put32(out,e->accepted);}
 for(i=0;i<frames;i++){uint32_t bits;memcpy(&bits,&pcm[i],4);put32(out,bits);}free(pcm);
 if(ferror(out)){fclose(out);return 7;}return fclose(out)?7:0;
}
