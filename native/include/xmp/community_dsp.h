#ifndef XMP_COMMUNITY_DSP_H
#define XMP_COMMUNITY_DSP_H
#include <math.h>
#include <stdint.h>
#include <string.h>
/* Declarative-v1 reference port. Fixed storage, no I/O, allocation or locks. */
#define XMP_PARITY_RATE 48000u
#define XMP_PARITY_VOICES 32u
typedef struct {uint32_t active,id,note;double velocity,phase,low,pressure,pitch,timbre;int release;} xmp_parity_voice;
typedef struct {uint32_t source;double gain,cutoff,low;xmp_parity_voice voices[XMP_PARITY_VOICES];} xmp_parity_dsp;
static inline void xmp_parity_init(xmp_parity_dsp* s,uint32_t source,double gain,double cutoff){memset(s,0,sizeof(*s));s->source=source;s->gain=gain;s->cutoff=cutoff;}
static inline xmp_parity_voice* xmp_parity_find(xmp_parity_dsp* s,uint32_t id){uint32_t i;for(i=0;i<XMP_PARITY_VOICES;i++)if(s->voices[i].active&&s->voices[i].id==id)return &s->voices[i];return 0;}
static inline uint32_t xmp_parity_event(xmp_parity_dsp* s,uint32_t op,uint32_t id,uint32_t arg,double value){
 uint32_t i;xmp_parity_voice* v=xmp_parity_find(s,id);
 if(op==1){if(v)return 0;for(i=0;i<XMP_PARITY_VOICES;i++)if(!s->voices[i].active){v=&s->voices[i];memset(v,0,sizeof(*v));v->active=1;v->id=id;v->note=arg;v->velocity=value;v->pressure=1;v->timbre=1;v->release=-1;return 1;}return 0;}
 if(op==2){if(!v)return 0;if(v->release<0)v->release=240;return 1;}
 if(op==3){if(!v)return 0;if(arg==1)v->pressure=value;else if(arg==2)v->pitch=value;else v->timbre=value;return 1;}
 if(op==4){if(arg==1)s->gain=value;else s->cutoff=value;return 1;}
 if(op==5){s->low=0;for(i=0;i<XMP_PARITY_VOICES;i++)if(s->voices[i].active&&s->voices[i].release<0)s->voices[i].release=240;return 1;}
 return 0;
}
static inline float xmp_parity_process(xmp_parity_dsp* s,float input){
 const double pi=3.14159265358979323846;double mixed=0;uint32_t i;
 if(s->source==2){s->low+=(1-exp(-2*pi*fmin(s->cutoff,21600)/48000))*((isfinite(input)?input:0)-s->low);mixed=s->low*s->gain;}
 else for(i=0;i<XMP_PARITY_VOICES;i++){
  xmp_parity_voice* v=&s->voices[i];double oscillator;if(!v->active)continue;
  oscillator=s->source==0?sin(v->phase*pi*2):1-4*fabs(v->phase-.5);
  v->phase=fmod(v->phase+fmin(.45,440*pow(2,((double)v->note+v->pitch-69)/12)/48000),1);
  v->low+=(1-exp(-2*pi*fmin(s->cutoff*(.1+.9*v->timbre),21600)/48000))*(oscillator-v->low);
  mixed+=v->low*s->gain*v->velocity*v->pressure*(v->release>=0?(double)v->release/240:1);
  if(v->release>=0&&--v->release<=0)v->active=0;
 }
 return (float)fmax(-1,fmin(1,isfinite(mixed)?mixed:0));
}
static inline uint32_t xmp_parity_active(const xmp_parity_dsp* s){uint32_t i,n=0;for(i=0;i<XMP_PARITY_VOICES;i++)n+=s->voices[i].active?1:0;return n;}
void xmp_native_init(xmp_parity_dsp*,uint32_t,double,double);
uint32_t xmp_native_event(xmp_parity_dsp*,uint32_t,uint32_t,uint32_t,double);
float xmp_native_process(xmp_parity_dsp*,float);
uint32_t xmp_native_active(const xmp_parity_dsp*);
#endif
