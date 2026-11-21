#ifndef XMP_COMMUNITY_H
#define XMP_COMMUNITY_H
#include <stdint.h>
#include <math.h>
#include <string.h>
#ifdef __cplusplus
extern "C" {
#endif
/* Versioned musical event/descriptor ABI. No dynamic binary loader is provided. */
#define XMP_MODULE_API_VERSION 2u
#define XMP_MODULE_DSP_ABI 1u
#define XMP_CAP_NOTES 1u
#define XMP_CAP_VELOCITY 2u
#define XMP_CAP_PRESSURE 4u
#define XMP_CAP_PITCH 8u
#define XMP_CAP_TIMBRE 16u
#define XMP_CAP_KNOWN 31u
#define XMP_SDK_VOICES 32u
typedef struct {char id[33];uint32_t unit;float min,max,default_value;} xmp_sdk_parameter_v1;
/* unit 1: linear, 2: Hz, 3: semitones; fixed owned metadata, no callback allocation. */
static inline int xmp_sdk_parameter_valid(const xmp_sdk_parameter_v1* p){
 uint32_t i;int ended=0;
 if(!p||p->unit<1||p->unit>3||!isfinite(p->min)||!isfinite(p->max)||!isfinite(p->default_value)||p->min>=p->max||p->min < -20000||p->max>20000||p->default_value<p->min||p->default_value>p->max||p->id[0]<'a'||p->id[0]>'z')return 0;
 for(i=0;i<33;i++){const char c=p->id[i];if(!c){ended=1;break;}if(!((c>='a'&&c<='z')||(c>='0'&&c<='9')||c=='-'))return 0;}
 return ended&&strcmp(p->id,"constructor")!=0&&strcmp(p->id,"prototype")!=0;
}
typedef struct {uint32_t id;float note,velocity,pressure,pitch,timbre;uint32_t active;} xmp_sdk_voice_v1;
typedef struct {uint32_t abi_version,capabilities;void* state;void (*process)(void*,const float*,float*,uint32_t); } xmp_sdk_plugin_v1;
static inline int xmp_sdk_negotiate(uint32_t api,uint32_t abi,uint32_t requested,uint32_t provided,uint32_t* granted){
 if(!granted||api!=XMP_MODULE_API_VERSION||abi!=XMP_MODULE_DSP_ABI||(requested&~XMP_CAP_KNOWN)||(requested&~provided))return 0;
 *granted=requested;return 1;
}
static inline int xmp_sdk_note_on(xmp_sdk_voice_v1* voices,uint32_t id,float note,float velocity){
 uint32_t i,slot=XMP_SDK_VOICES;
 if(!voices||id==0||id>0x7fffffffu||!isfinite(note)||note<0||note>127||!isfinite(velocity)||velocity<0||velocity>1)return 0;
 for(i=0;i<XMP_SDK_VOICES;i++){if(voices[i].active&&voices[i].id==id)return 0;if(!voices[i].active&&slot==XMP_SDK_VOICES)slot=i;}
 if(slot==XMP_SDK_VOICES)return 0;
 {xmp_sdk_voice_v1 next={id,note,velocity,1,0,1,1};voices[slot]=next;}return 1;
}
static inline int xmp_sdk_expression(xmp_sdk_voice_v1* voices,uint32_t capabilities,uint32_t id,uint32_t dimension,float value){
 uint32_t i;
 if(!voices||!(capabilities&dimension)||!isfinite(value))return 0;
 if(dimension==XMP_CAP_PITCH){if(value < -48||value>48)return 0;}
 else if(dimension!=XMP_CAP_PRESSURE&&dimension!=XMP_CAP_TIMBRE)return 0;
 else if(value<0||value>1)return 0;
 for(i=0;i<XMP_SDK_VOICES;i++)if(voices[i].active&&voices[i].id==id){if(dimension==XMP_CAP_PITCH)voices[i].pitch=value;else if(dimension==XMP_CAP_PRESSURE)voices[i].pressure=value;else voices[i].timbre=value;return 1;}
 return 0;
}
#ifdef __cplusplus
}
#endif
#endif
