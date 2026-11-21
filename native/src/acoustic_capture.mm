// Explicit built-in HAL streams. Never query a default device or enumerate USB devices.
#import <AVFoundation/AVFoundation.h>
#import <Foundation/Foundation.h>
#include <AudioToolbox/AudioToolbox.h>
#include <CoreAudio/CoreAudio.h>
#include "xmp/acoustic_policy.hpp"
#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstring>
#include <fstream>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <thread>
#include <vector>

namespace {
constexpr unsigned maximum_frames = 4096;
constexpr double capture_seconds = 6.0;
void check(OSStatus status, const char* operation) {
  if (status != noErr) throw std::runtime_error(std::string(operation) + " (OSStatus " + std::to_string(status) + ")");
}
template<class T> T property(AudioObjectID id, AudioObjectPropertySelector selector, AudioObjectPropertyScope scope = kAudioObjectPropertyScopeGlobal) {
  T value{}; UInt32 size = sizeof(value);
  AudioObjectPropertyAddress address{selector,scope,kAudioObjectPropertyElementMain};
  check(AudioObjectGetPropertyData(id,&address,0,nullptr,&size,&value),"Read built-in audio metadata");
  return value;
}
std::string text_property(AudioObjectID id, AudioObjectPropertySelector selector) {
  const auto text = property<CFStringRef>(id,selector);
  if (!text) throw std::runtime_error("Missing built-in identity");
  std::array<char,512> bytes{};
  const bool copied = CFStringGetCString(text,bytes.data(),bytes.size(),kCFStringEncodingUTF8);
  CFRelease(text);
  if (!copied) throw std::runtime_error("Invalid built-in identity");
  return bytes.data();
}
unsigned channels(AudioObjectID id, AudioObjectPropertyScope scope) {
  AudioObjectPropertyAddress address{kAudioDevicePropertyStreamConfiguration,scope,kAudioObjectPropertyElementMain};
  UInt32 size = 0; check(AudioObjectGetPropertyDataSize(id,&address,0,nullptr,&size),"Read channel metadata size");
  if (size < sizeof(AudioBufferList) || size > 65536) throw std::runtime_error("Invalid channel metadata");
  std::vector<unsigned char> memory(size);
  auto* list = reinterpret_cast<AudioBufferList*>(memory.data());
  check(AudioObjectGetPropertyData(id,&address,0,nullptr,&size,list),"Read channel metadata");
  unsigned total = 0;
  for (UInt32 i=0;i<list->mNumberBuffers;++i) total += list->mBuffers[i].mNumberChannels;
  return total;
}
xmp::AcousticDevice builtin(bool input) {
  const auto requested = input ? CFSTR("BuiltInMicrophoneDevice") : CFSTR("BuiltInSpeakerDevice");
  AudioDeviceID id = 0;
  AudioObjectPropertyAddress address{kAudioHardwarePropertyTranslateUIDToDevice,kAudioObjectPropertyScopeGlobal,kAudioObjectPropertyElementMain};
  UInt32 size = sizeof(id);
  // Direct lookup of these two fixed built-in UIDs; no default or list-position fallback.
  check(AudioObjectGetPropertyData(kAudioObjectSystemObject,&address,sizeof(requested),&requested,&size,&id),"Resolve built-in UID");
  if (!id) throw std::runtime_error(input ? "Built-in MacBook microphone unavailable" : "Built-in MacBook speakers unavailable");
  xmp::AcousticDevice result;
  result.id=id;
  result.built_in = property<UInt32>(id,kAudioDevicePropertyTransportType) == kAudioDeviceTransportTypeBuiltIn;
  // Refuse a non-built-in transport before inspecting or opening its streams.
  if (!result.built_in) throw std::runtime_error("Built-in UID resolved to an external transport; refused");
  result.uid=text_property(id,kAudioDevicePropertyDeviceUID);
  result.name=text_property(id,kAudioObjectPropertyName);
  result.alive=property<UInt32>(id,kAudioDevicePropertyDeviceIsAlive) == 1;
  result.rate=property<Float64>(id,kAudioDevicePropertyNominalSampleRate);
  if(input) result.input_channels=channels(id,kAudioDevicePropertyScopeInput);
  else result.output_channels=channels(id,kAudioDevicePropertyScopeOutput);
  if(!xmp::acoustic_device_allowed(result,input)) throw std::runtime_error("Built-in MacBook identity/capability check failed");
  return result;
}
NSDictionary* describe(const xmp::AcousticDevice& device) {
  return @{ @"id":@(device.id), @"uid":@(device.uid.c_str()), @"name":@(device.name.c_str()),
    @"builtIn":@(device.built_in), @"alive":@(device.alive), @"sampleRate":@(device.rate),
    @"inputChannels":@(device.input_channels), @"outputChannels":@(device.output_channels) };
}
NSString* permission() {
  switch([AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio]) {
    case AVAuthorizationStatusAuthorized:return @"authorized";
    case AVAuthorizationStatusDenied:return @"denied";
    case AVAuthorizationStatusRestricted:return @"restricted";
    default:return @"not-determined";
  }
}
void require_permission() {
  if([permission() isEqualToString:@"not-determined"]) {
    auto done = std::make_shared<std::atomic<bool>>(false);
    [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio completionHandler:^(BOOL){done->store(true);}];
    const auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(45);
    while(!done->load() && std::chrono::steady_clock::now()<deadline)
      [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
  }
  if(![permission() isEqualToString:@"authorized"]) throw std::runtime_error("Microphone permission unavailable; no audio stream opened");
}
void json_write(NSDictionary* value, NSString* path) {
  NSError* error=nil;
  NSData* bytes=[NSJSONSerialization dataWithJSONObject:value options:NSJSONWritingPrettyPrinted error:&error];
  if(!bytes || ![bytes writeToFile:path options:NSDataWritingAtomic error:&error]) throw std::runtime_error("Cannot write acoustic evidence");
}
void print_json(NSDictionary* value) {
  const auto data=[NSJSONSerialization dataWithJSONObject:value options:0 error:nil];
  std::cout.write(static_cast<const char*>(data.bytes),static_cast<std::streamsize>(data.length));std::cout<<'\n';
}
std::uint32_t le32(const unsigned char* p) { return p[0] | (std::uint32_t(p[1])<<8) | (std::uint32_t(p[2])<<16) | (std::uint32_t(p[3])<<24); }
std::vector<float> reference(NSString* directory, double rate) {
  const auto path=[directory stringByAppendingPathComponent:@"reference.wav"];
  NSDictionary* attributes=[[NSFileManager defaultManager] attributesOfItemAtPath:path error:nil];
  if(!attributes || [attributes fileSize]>2000000) throw std::runtime_error("Bounded XMP reference WAV required");
  NSData* data=[NSData dataWithContentsOfFile:path];
  const auto* p=static_cast<const unsigned char*>(data.bytes);
  if(data.length<44 || std::memcmp(p,"RIFF",4) || std::memcmp(p+8,"WAVEfmt ",8) || le32(p+16)!=16 || p[20]!=1 || p[22]!=2 || le32(p+24)!=48000 || p[34]!=16 || std::memcmp(p+36,"data",4) || le32(p+40)!=data.length-44 || (data.length-44)%4)
    throw std::runtime_error("Expected original stereo 48 kHz PCM16 reference WAV");
  const auto frames=(data.length-44)/4;
  if(frames!=192000) throw std::runtime_error("Expected four-second reference");
  const auto count=static_cast<std::size_t>(std::llround(frames*rate/48000));
  std::vector<float> output(count);
  const auto value=[&](std::size_t i){const auto raw=static_cast<std::int16_t>(p[44+i*4] | (std::uint16_t(p[45+i*4])<<8));return raw/32768.0f;};
  for(std::size_t i=0;i<count;++i){const double position=i*48000/rate;const auto left=std::min(frames-1,static_cast<std::size_t>(position));const auto right=std::min(frames-1,left+1);output[i]=value(left)+(value(right)-value(left))*static_cast<float>(position-left);if(std::abs(output[i])>0.251f)throw std::runtime_error("Reference exceeds acoustic level limit");}
  return output;
}
struct Stream {
  AudioUnit unit=nullptr;bool running=false,input=false;double rate=0;
  unsigned device_id=0,channel_count=0;std::size_t target_frames=0;std::atomic<float> meter{0};
  std::vector<float> samples;
  std::array<std::array<float,maximum_frames>,8> scratch{};
  struct { UInt32 count=0; AudioBuffer buffers[8]{}; } buffers;
  std::atomic<std::size_t> cursor{0};std::atomic<unsigned> calls{0},errors{0},discontinuities{0};
  std::atomic<std::uint64_t> first_host_time{0};
  double next_sample=0;bool clock_seen=false;
  ~Stream(){if(unit){if(running)AudioOutputUnitStop(unit);AudioUnitUninitialize(unit);AudioComponentInstanceDispose(unit);}}
  void timestamp(const AudioTimeStamp* time,unsigned frames) {
    if(time->mFlags&kAudioTimeStampHostTimeValid){std::uint64_t zero=0;first_host_time.compare_exchange_strong(zero,time->mHostTime);}
    if(time->mFlags&kAudioTimeStampSampleTimeValid){if(clock_seen&&std::abs(time->mSampleTime-next_sample)>1)++discontinuities;clock_seen=true;next_sample=time->mSampleTime+frames;}
  }
  static OSStatus output_callback(void* context,AudioUnitRenderActionFlags*,const AudioTimeStamp* time,UInt32,UInt32 frames,AudioBufferList* data) {
    auto& self=*static_cast<Stream*>(context);++self.calls;self.timestamp(time,frames);
    const auto offset=self.cursor.load(std::memory_order_relaxed);
    if(frames>maximum_frames){++self.errors;for(UInt32 b=0;b<data->mNumberBuffers;++b)std::memset(data->mBuffers[b].mData,0,data->mBuffers[b].mDataByteSize);return noErr;}
    for(UInt32 b=0;b<data->mNumberBuffers;++b){auto& buffer=data->mBuffers[b];auto* target=static_cast<float*>(buffer.mData);const auto size=static_cast<std::size_t>(frames)*buffer.mNumberChannels;if(!target||buffer.mDataByteSize<size*sizeof(float)){++self.errors;continue;}for(UInt32 i=0;i<frames;++i){const float value=offset+i<self.samples.size()?self.samples[offset+i]:0;for(UInt32 ch=0;ch<buffer.mNumberChannels;++ch)target[i*buffer.mNumberChannels+ch]=value;}}
    self.cursor.store(offset+frames,std::memory_order_release);return noErr;
  }
  static OSStatus input_callback(void* context,AudioUnitRenderActionFlags* flags,const AudioTimeStamp* time,UInt32,UInt32 frames,AudioBufferList*) {
    auto& self=*static_cast<Stream*>(context);++self.calls;self.timestamp(time,frames);
    if(frames>maximum_frames){++self.errors;return noErr;}
    for(unsigned ch=0;ch<self.channel_count;++ch)self.buffers.buffers[ch].mDataByteSize=frames*sizeof(float);
    const auto status=AudioUnitRender(self.unit,flags,time,1,frames,reinterpret_cast<AudioBufferList*>(&self.buffers));
    if(status!=noErr){++self.errors;return noErr;}
    const auto offset=self.cursor.load(std::memory_order_relaxed);
    const auto available=offset<self.samples.size()?self.samples.size()-offset:0;
    const auto count=std::min<std::size_t>(available,frames);
    float peak=0;for(unsigned i=0;i<frames;++i)peak=std::max(peak,std::abs(self.scratch[0][i]));self.meter.store(peak);
    // Explicit first hardware microphone channel; never monitor input to output.
    if(count)std::memcpy(self.samples.data()+offset,self.scratch[0].data(),count*sizeof(float));
    self.cursor.store(offset+count,std::memory_order_release);return noErr;
  }
  void prepare(const xmp::AcousticDevice& device,bool is_input) {
    input=is_input;device_id=device.id;rate=device.rate;channel_count=input?device.input_channels:2;
    AudioComponentDescription desc{kAudioUnitType_Output,kAudioUnitSubType_HALOutput,kAudioUnitManufacturer_Apple,0,0};
    const auto component=AudioComponentFindNext(nullptr,&desc);if(!component)throw std::runtime_error("Apple HAL unavailable");
    check(AudioComponentInstanceNew(component,&unit),"Create HAL unit");
    UInt32 yes=1,no=0;
    check(AudioUnitSetProperty(unit,kAudioOutputUnitProperty_EnableIO,kAudioUnitScope_Input,1,input?&yes:&no,sizeof(yes)),"Configure HAL input");
    check(AudioUnitSetProperty(unit,kAudioOutputUnitProperty_EnableIO,kAudioUnitScope_Output,0,input?&no:&yes,sizeof(yes)),"Configure HAL output");
    check(AudioUnitSetProperty(unit,kAudioOutputUnitProperty_CurrentDevice,kAudioUnitScope_Global,0,&device_id,sizeof(device_id)),"Select exact built-in device");
    AudioStreamBasicDescription format{};format.mSampleRate=rate;format.mFormatID=kAudioFormatLinearPCM;format.mFormatFlags=kAudioFormatFlagsNativeFloatPacked|kAudioFormatFlagIsNonInterleaved;format.mBytesPerPacket=4;format.mFramesPerPacket=1;format.mBytesPerFrame=4;format.mChannelsPerFrame=channel_count;format.mBitsPerChannel=32;
    check(AudioUnitSetProperty(unit,kAudioUnitProperty_StreamFormat,input?kAudioUnitScope_Output:kAudioUnitScope_Input,input?1:0,&format,sizeof(format)),"Configure client PCM");
    UInt32 maximum=maximum_frames;check(AudioUnitSetProperty(unit,kAudioUnitProperty_MaximumFramesPerSlice,kAudioUnitScope_Global,0,&maximum,sizeof(maximum)),"Bound callback frames");
    if(input){samples.resize(target_frames?target_frames:static_cast<std::size_t>(capture_seconds*rate));buffers.count=channel_count;for(unsigned ch=0;ch<channel_count;++ch)buffers.buffers[ch]={1,maximum_frames*sizeof(float),scratch[ch].data()};}
    AURenderCallbackStruct callback{input?input_callback:output_callback,this};
    check(AudioUnitSetProperty(unit,input?kAudioOutputUnitProperty_SetInputCallback:kAudioUnitProperty_SetRenderCallback,input?kAudioUnitScope_Global:kAudioUnitScope_Input,0,&callback,sizeof(callback)),"Install bounded HAL callback");
    const auto actual=builtin(input);if(actual.id!=device.id||actual.uid!=device.uid||actual.rate!=device.rate)throw std::runtime_error("Built-in identity changed before initialization");
    check(AudioUnitInitialize(unit),"Initialize selected built-in stream");
  }
  void start(){const auto actual=builtin(input);if(actual.id!=device_id||actual.rate!=rate)throw std::runtime_error("Built-in identity changed before start");check(AudioOutputUnitStart(unit),"Start selected built-in stream");running=true;}
  void stop(){if(running){check(AudioOutputUnitStop(unit),"Stop built-in stream");running=false;}}
};
void put16(std::ostream& out,std::uint16_t n){out.put(n&255);out.put((n>>8)&255);}
void put32(std::ostream& out,std::uint32_t n){put16(out,n&65535);put16(out,n>>16);}
void write_capture(NSString* directory,const Stream& stream) {
  std::ofstream out([[directory stringByAppendingPathComponent:@"capture.wav"] fileSystemRepresentation],std::ios::binary);
  const auto frames=static_cast<std::uint32_t>(std::min(stream.cursor.load(),stream.samples.size()));
  out.write("RIFF",4);put32(out,36+frames*2);out.write("WAVEfmt ",8);put32(out,16);put16(out,1);put16(out,1);put32(out,static_cast<unsigned>(stream.rate));put32(out,static_cast<unsigned>(stream.rate)*2);put16(out,2);put16(out,16);out.write("data",4);put32(out,frames*2);
  for(unsigned i=0;i<frames;++i){const auto value=stream.samples[i];if(!std::isfinite(value))throw std::runtime_error("Non-finite microphone sample");put16(out,static_cast<std::int16_t>(std::lround(std::clamp(value,-1.0f,1.0f)*32767)));}
  out.close();if(!out)throw std::runtime_error("Capture write failed");
}
}
int main(int argc,char** argv){@autoreleasepool {
  NSString* directory=nil;
  NSMutableDictionary* report=[@{@"version":@1,@"physicalAudioQualified":@NO,@"formalLoopbackQualified":@NO,@"protectedDeviceOperations":@0,@"outputStreamsStarted":@0,@"inputStreamsStarted":@0} mutableCopy];
  try {
    const bool inspect=argc==2&&std::string(argv[1])=="--inspect";
    const bool capture=argc==3&&std::string(argv[1])=="--capture";
    const bool record=argc==3&&std::string(argv[1])=="--record";
    if(!inspect&&!capture&&!record)throw std::runtime_error("Use --inspect, or --capture with an owned acoustic session directory; no device flags");
    if(capture||record){directory=[NSString stringWithUTF8String:argv[2]];BOOL is_directory=NO;if(![[NSFileManager defaultManager] fileExistsAtPath:directory isDirectory:&is_directory]||!is_directory)throw std::runtime_error("Acoustic session directory required");}
    if(record){
      const auto input=builtin(true);report[@"input"]=describe(input);require_permission();
      const auto path=[directory stringByAppendingPathComponent:@"record.json"];
      NSDictionary* attributes=[[NSFileManager defaultManager] attributesOfItemAtPath:path error:nil];
      if(!attributes||[attributes fileSize]>512)throw std::runtime_error("Bounded recording plan required");
      NSDictionary* plan=[NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:path] options:0 error:nil];
      if(![plan isKindOfClass:[NSDictionary class]]||![plan[@"frames"] isKindOfClass:[NSNumber class]])throw std::runtime_error("Invalid recording plan");
      const double frames=[plan[@"frames"] doubleValue];
      if(!std::isfinite(frames)||std::floor(frames)!=frames||frames<1||frames>480000||frames/input.rate>10)throw std::runtime_error("Recording frame budget exceeded");
      auto stream=std::make_unique<Stream>();stream->target_frames=static_cast<std::size_t>(frames);stream->prepare(input,true);stream->start();report[@"inputStreamsStarted"]=@1;
      const auto deadline=std::chrono::steady_clock::now()+std::chrono::milliseconds(static_cast<int>(frames/input.rate*1000)+3000);
      while(stream->cursor.load()<stream->samples.size()&&!stream->errors.load()&&!stream->discontinuities.load()&&std::chrono::steady_clock::now()<deadline){
        json_write(@{@"peak":@(stream->meter.load()),@"frames":@(stream->cursor.load()),@"targetFrames":@(stream->target_frames)},[directory stringByAppendingPathComponent:@"meter.json"]);
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
      }
      stream->stop();report[@"streamsStopped"]=@YES;
      const auto final_input=builtin(true);if(final_input.id!=input.id||final_input.rate!=input.rate)throw std::runtime_error("Recording input identity changed");
      const bool complete=stream->cursor.load()==stream->samples.size()&&!stream->errors.load()&&!stream->discontinuities.load();
      if(stream->cursor.load())write_capture(directory,*stream);
      report[@"outcome"]=complete?@"recorded":@"interrupted";report[@"inputFrames"]=@(stream->cursor.load());report[@"inputCallbacks"]=@(stream->calls.load());report[@"callbackErrors"]=@(stream->errors.load());report[@"timestampDiscontinuities"]=@(stream->discontinuities.load());report[@"microphonePermission"]=permission();
      if(!complete)report[@"reason"]=@"Input loss or capture deadline; partial WAV retained if any frames arrived";
      json_write(report,[directory stringByAppendingPathComponent:@"device-capture.json"]);print_json(report);return complete?0:2;
    }
    const auto output=builtin(false),input=builtin(true);
    report[@"output"]=describe(output);report[@"input"]=describe(input);report[@"microphonePermission"]=permission();
    if(inspect){report[@"outcome"]=@"inspected";print_json(report);return 0;}
    require_permission();report[@"microphonePermission"]=permission();
    auto output_stream=std::make_unique<Stream>(),input_stream=std::make_unique<Stream>();
    output_stream->samples=reference(directory,output.rate);
    input_stream->prepare(input,true);output_stream->prepare(output,false);
    input_stream->start();report[@"inputStreamsStarted"]=@1;
    const auto wait_start=std::chrono::steady_clock::now();
    while(input_stream->cursor.load()<static_cast<std::size_t>(input.rate*0.5)&&std::chrono::steady_clock::now()-wait_start<std::chrono::seconds(3))std::this_thread::sleep_for(std::chrono::milliseconds(10));
    if(input_stream->cursor.load()<input.rate*0.5)throw std::runtime_error("Microphone did not deliver frames; playback not started");
    output_stream->start();report[@"outputStreamsStarted"]=@1;
    const auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(7);
    while(input_stream->cursor.load()<input_stream->samples.size()&&std::chrono::steady_clock::now()<deadline)std::this_thread::sleep_for(std::chrono::milliseconds(10));
    output_stream->stop();input_stream->stop();report[@"streamsStopped"]=@YES;
    const auto final_input=builtin(true),final_output=builtin(false);
    if(final_input.id!=input.id||final_output.id!=output.id||final_input.rate!=input.rate||final_output.rate!=output.rate)throw std::runtime_error("Built-in identity or rate changed during capture");
    write_capture(directory,*input_stream);
    report[@"inputFrames"]=@(input_stream->cursor.load());report[@"outputFrames"]=@(output_stream->cursor.load());report[@"inputCallbacks"]=@(input_stream->calls.load());report[@"outputCallbacks"]=@(output_stream->calls.load());
    report[@"callbackErrors"]=@(input_stream->errors.load()+output_stream->errors.load());report[@"timestampDiscontinuities"]=@(input_stream->discontinuities.load()+output_stream->discontinuities.load());
    report[@"inputChannel"]=@0;report[@"captureSeconds"]=@(capture_seconds);report[@"outcome"]=@"captured";
    if(input_stream->cursor.load()!=input_stream->samples.size()||input_stream->errors.load()||output_stream->errors.load())throw std::runtime_error("Incomplete capture or HAL callback error");
    json_write(report,[directory stringByAppendingPathComponent:@"device-capture.json"]);print_json(report);return 0;
  }catch(const std::exception& error){report[@"outcome"]=@"inconclusive";report[@"reason"]=@(error.what());report[@"microphonePermission"]=permission();if(directory){try{json_write(report,[directory stringByAppendingPathComponent:@"device-capture.json"]);}catch(...){}}print_json(report);return 2;}
}}
