#include "xmp/community.h"
#include <array>
#include <cstdlib>
#include <iostream>
static void check(bool good){if(!good)std::exit(1);}
static void gain(void* state,const float* input,float* output,uint32_t frames){const float level=*static_cast<float*>(state);for(uint32_t i=0;i<frames;i++)output[i]=input[i]*level;}
int main(){
 const xmp_sdk_parameter_v1 parameter={"level",1,0,1,0.25f};check(xmp_sdk_parameter_valid(&parameter));
 std::array<xmp_sdk_voice_v1,XMP_SDK_VOICES> voices{};uint32_t granted=0;
 check(xmp_sdk_negotiate(2,1,31,31,&granted)&&granted==31);
 check(!xmp_sdk_negotiate(3,1,31,31,&granted)&&!xmp_sdk_negotiate(2,2,31,31,&granted)&&!xmp_sdk_negotiate(2,1,32,31,&granted));
 check(xmp_sdk_note_on(voices.data(),101,60,0.8f)&&xmp_sdk_note_on(voices.data(),102,64,0.7f));
 check(xmp_sdk_expression(voices.data(),31,101,XMP_CAP_PRESSURE,0.25f)&&xmp_sdk_expression(voices.data(),31,101,XMP_CAP_PITCH,12)&&xmp_sdk_expression(voices.data(),31,101,XMP_CAP_TIMBRE,0.4f));
 check(voices[0].pressure==0.25f&&voices[0].pitch==12&&voices[1].pressure==1&&voices[1].pitch==0&&voices[1].timbre==1);
 check(!xmp_sdk_expression(voices.data(),3,101,XMP_CAP_PRESSURE,0.5f)&&!xmp_sdk_expression(voices.data(),31,999,XMP_CAP_PITCH,1)&&!xmp_sdk_note_on(voices.data(),101,60,1));
 float level=0.5f; xmp_sdk_plugin_v1 module={1,3,&level,gain};const float input[]={0.5f,-0.5f};float output[2]={};module.process(module.state,input,output,2);check(output[0]==0.25f&&output[1]==-0.25f);
 std::cout<<"{\"apiVersion\":2,\"dspAbi\":1,\"first\":[101,0.25,12,0.4],\"second\":[102,1,0,1],\"gainOutput\":[0.25,-0.25],\"dynamicLoader\":false}\n";
}
