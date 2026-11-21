#include "xmp/audio_backend.hpp"
#include <algorithm>
#include <array>
#include <atomic>
#include <cctype>
#include <cstring>
#ifdef __APPLE__
#include <AudioToolbox/AudioToolbox.h>
#include <CoreAudio/CoreAudio.h>
#endif
#ifdef XMP_HAS_ALSA
#include <alsa/asoundlib.h>
#endif
namespace xmp {
bool safe_builtin_selection(const std::string& name,bool built_in,std::uint32_t rate,std::uint32_t frames) noexcept {
 std::string lower=name;std::transform(lower.begin(),lower.end(),lower.begin(),[](unsigned char c){return static_cast<char>(std::tolower(c));});
 return built_in&&rate==kRate&&frames==kBlock&&!lower.empty()&&lower.find("akai")==std::string::npos&&lower.find("force")==std::string::npos&&lower.find("mpc")==std::string::npos&&lower.find("inmusic")==std::string::npos;
}
struct HostAudioBackend::Impl {
 Engine* engine=nullptr;std::atomic<bool> lost{false};bool running=false;const char* state="closed";
#ifdef __APPLE__
 AudioUnit unit=nullptr;AudioDeviceID device=0;bool listening=false;
 static OSStatus render(void* context,AudioUnitRenderActionFlags*,const AudioTimeStamp*,UInt32,UInt32 frames,AudioBufferList* buffers){auto& self=*static_cast<Impl*>(context);if(frames>4096||buffers->mNumberBuffers!=2||self.lost.load()){for(UInt32 i=0;i<buffers->mNumberBuffers;++i)std::memset(buffers->mBuffers[i].mData,0,buffers->mBuffers[i].mDataByteSize);return noErr;}self.engine->render(static_cast<float*>(buffers->mBuffers[0].mData),static_cast<float*>(buffers->mBuffers[1].mData),frames);return noErr;}
 static OSStatus changed(AudioObjectID,UInt32,const AudioObjectPropertyAddress*,void* context){static_cast<Impl*>(context)->lost.store(true);return noErr;}
#endif
#ifdef XMP_HAS_ALSA
 snd_pcm_t* pcm=nullptr;std::array<float,256> left{},right{};std::array<float,512> interleaved{};
#endif
};
HostAudioBackend::HostAudioBackend():impl_(std::make_unique<Impl>()){}
HostAudioBackend::~HostAudioBackend(){stop();
#ifdef __APPLE__
 if(impl_->listening){AudioObjectPropertyAddress alive{kAudioDevicePropertyDeviceIsAlive,kAudioObjectPropertyScopeGlobal,kAudioObjectPropertyElementMain};AudioObjectRemovePropertyListener(impl_->device,&alive,Impl::changed,impl_.get());AudioObjectPropertyAddress rate{kAudioDevicePropertyNominalSampleRate,kAudioObjectPropertyScopeGlobal,kAudioObjectPropertyElementMain};AudioObjectRemovePropertyListener(impl_->device,&rate,Impl::changed,impl_.get());}if(impl_->unit){AudioUnitUninitialize(impl_->unit);AudioComponentInstanceDispose(impl_->unit);}
#endif
#ifdef XMP_HAS_ALSA
 if(impl_->pcm)snd_pcm_close(impl_->pcm);
#endif
}
bool HostAudioBackend::open_builtin(Engine& engine,std::uint32_t device_id,const std::string& name,std::uint32_t rate,std::uint32_t frames){
 if(!safe_builtin_selection(name,true,rate,frames)||device_id==0){impl_->state="selection-rejected";return false;}
#ifdef __APPLE__
 if(impl_->unit)return false;
 UInt32 transport=0,size=sizeof(transport);AudioObjectPropertyAddress property{kAudioDevicePropertyTransportType,kAudioObjectPropertyScopeGlobal,kAudioObjectPropertyElementMain};
 if(AudioObjectGetPropertyData(device_id,&property,0,nullptr,&size,&transport)!=noErr||transport!=kAudioDeviceTransportTypeBuiltIn){impl_->state="non-builtin-rejected";return false;}
 CFStringRef actual_name=nullptr;size=sizeof(actual_name);property.mSelector=kAudioObjectPropertyName;
 if(AudioObjectGetPropertyData(device_id,&property,0,nullptr,&size,&actual_name)!=noErr||!actual_name)return false;
 std::array<char,256> text{};const bool copied=CFStringGetCString(actual_name,text.data(),text.size(),kCFStringEncodingUTF8);CFRelease(actual_name);if(!copied||name!=text.data()||!safe_builtin_selection(text.data(),true,rate,frames)){impl_->state="identity-mismatch";return false;}
 Float64 actual_rate=0;property.mSelector=kAudioDevicePropertyNominalSampleRate;size=sizeof(actual_rate);if(AudioObjectGetPropertyData(device_id,&property,0,nullptr,&size,&actual_rate)!=noErr||actual_rate!=rate){impl_->state="sample-rate-mismatch";return false;}
 UInt32 actual_frames=0;property.mSelector=kAudioDevicePropertyBufferFrameSize;size=sizeof(actual_frames);if(AudioObjectGetPropertyData(device_id,&property,0,nullptr,&size,&actual_frames)!=noErr||actual_frames!=frames){impl_->state="buffer-size-mismatch";return false;}
 AudioComponentDescription description{kAudioUnitType_Output,kAudioUnitSubType_HALOutput,kAudioUnitManufacturer_Apple,0,0};const auto component=AudioComponentFindNext(nullptr,&description);if(!component||AudioComponentInstanceNew(component,&impl_->unit)!=noErr)return false;
 impl_->engine=&engine;impl_->device=device_id;
 if(AudioUnitSetProperty(impl_->unit,kAudioOutputUnitProperty_CurrentDevice,kAudioUnitScope_Global,0,&device_id,sizeof(device_id))!=noErr)return false;
 AudioStreamBasicDescription format{};format.mSampleRate=rate;format.mFormatID=kAudioFormatLinearPCM;format.mFormatFlags=kAudioFormatFlagsNativeFloatPacked|kAudioFormatFlagIsNonInterleaved;format.mBytesPerPacket=4;format.mFramesPerPacket=1;format.mBytesPerFrame=4;format.mChannelsPerFrame=2;format.mBitsPerChannel=32;
 if(AudioUnitSetProperty(impl_->unit,kAudioUnitProperty_StreamFormat,kAudioUnitScope_Input,0,&format,sizeof(format))!=noErr)return false;
 UInt32 maximum=4096;if(AudioUnitSetProperty(impl_->unit,kAudioUnitProperty_MaximumFramesPerSlice,kAudioUnitScope_Global,0,&maximum,sizeof(maximum))!=noErr)return false;
 AURenderCallbackStruct callback{Impl::render,impl_.get()};if(AudioUnitSetProperty(impl_->unit,kAudioUnitProperty_SetRenderCallback,kAudioUnitScope_Input,0,&callback,sizeof(callback))!=noErr||AudioUnitInitialize(impl_->unit)!=noErr)return false;
 AudioObjectPropertyAddress alive{kAudioDevicePropertyDeviceIsAlive,kAudioObjectPropertyScopeGlobal,kAudioObjectPropertyElementMain};if(AudioObjectAddPropertyListener(device_id,&alive,Impl::changed,impl_.get())!=noErr)return false;
 AudioObjectPropertyAddress changed_rate{kAudioDevicePropertyNominalSampleRate,kAudioObjectPropertyScopeGlobal,kAudioObjectPropertyElementMain};if(AudioObjectAddPropertyListener(device_id,&changed_rate,Impl::changed,impl_.get())!=noErr){AudioObjectRemovePropertyListener(device_id,&alive,Impl::changed,impl_.get());return false;}impl_->listening=true;impl_->state="prepared-builtin";return true;
#else
 (void)engine;impl_->state="CoreAudio-unavailable";return false;
#endif
}
bool HostAudioBackend::open_linux_null(Engine& engine,std::uint32_t rate,std::uint32_t frames){
 if(rate!=kRate||frames!=kBlock){impl_->state="profile-mismatch";return false;}
#ifdef XMP_HAS_ALSA
 if(impl_->pcm)return false;
 if(snd_pcm_open(&impl_->pcm,"null",SND_PCM_STREAM_PLAYBACK,SND_PCM_NONBLOCK)<0)return false;
 snd_pcm_hw_params_t* params;snd_pcm_hw_params_alloca(&params);snd_pcm_uframes_t period=frames,buffer=frames*2;int direction=0;
 if(snd_pcm_hw_params_any(impl_->pcm,params)<0||snd_pcm_hw_params_set_access(impl_->pcm,params,SND_PCM_ACCESS_RW_INTERLEAVED)<0||snd_pcm_hw_params_set_format(impl_->pcm,params,SND_PCM_FORMAT_FLOAT_LE)<0||snd_pcm_hw_params_set_channels(impl_->pcm,params,2)<0||snd_pcm_hw_params_set_rate(impl_->pcm,params,rate,0)<0||snd_pcm_hw_params_set_period_size_near(impl_->pcm,params,&period,&direction)<0||snd_pcm_hw_params_set_buffer_size_near(impl_->pcm,params,&buffer)<0||period!=frames||snd_pcm_hw_params(impl_->pcm,params)<0){snd_pcm_close(impl_->pcm);impl_->pcm=nullptr;return false;}
 impl_->engine=&engine;impl_->state="prepared-alsa-null";return true;
#else
 (void)engine;impl_->state="ALSA-unavailable";return false;
#endif
}
bool HostAudioBackend::start(){
#ifdef __APPLE__
 if(impl_->unit&&!impl_->lost.load()&&AudioOutputUnitStart(impl_->unit)==noErr){impl_->running=true;impl_->state="running-builtin";return true;}
#endif
#ifdef XMP_HAS_ALSA
 if(impl_->pcm&&!impl_->lost.load()&&snd_pcm_prepare(impl_->pcm)==0){impl_->running=true;impl_->state="running-alsa-null";return true;}
#endif
 return false;
}
void HostAudioBackend::stop(){
#ifdef __APPLE__
 if(impl_->unit&&impl_->running)AudioOutputUnitStop(impl_->unit);
#endif
#ifdef XMP_HAS_ALSA
 if(impl_->pcm&&impl_->running)snd_pcm_drop(impl_->pcm);
#endif
 impl_->running=false;
}
bool HostAudioBackend::poll_lost(){if(!impl_->lost.load())return false;stop();if(impl_->engine){impl_->engine->critical.push({Op::backend_lost,0,0,0,0,0});std::array<float,1> silence{};impl_->engine->render(silence.data(),silence.data(),0);}impl_->state="lost-requires-new-negotiation";return true;}
bool HostAudioBackend::pump_linux_null(){
#ifdef XMP_HAS_ALSA
 if(!impl_->running||!impl_->pcm)return false;impl_->engine->render(impl_->left.data(),impl_->right.data(),256);for(std::size_t i=0;i<256;++i){impl_->interleaved[i*2]=impl_->left[i];impl_->interleaved[i*2+1]=impl_->right[i];}const auto count=snd_pcm_writei(impl_->pcm,impl_->interleaved.data(),256);if(count!=256){impl_->lost.store(true);poll_lost();return false;}return true;
#else
 return false;
#endif
}
const char* HostAudioBackend::status() const noexcept{return impl_->state;}
}
