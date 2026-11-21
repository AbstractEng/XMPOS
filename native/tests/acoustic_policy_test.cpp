#include "xmp/acoustic_policy.hpp"
#include <cassert>
#include <iostream>
int main() {
  const xmp::AcousticDevice speaker{1,"BuiltInSpeakerDevice","MacBook Pro Speakers",true,true,0,2,48000};
  const xmp::AcousticDevice microphone{2,"BuiltInMicrophoneDevice","MacBook Pro Microphone",true,true,1,0,48000};
  assert(xmp::acoustic_device_allowed(speaker,false));
  assert(xmp::acoustic_device_allowed(microphone,true));
  assert(!xmp::acoustic_device_allowed(speaker,true));
  assert(!xmp::acoustic_device_allowed(microphone,false));
  auto invalid = speaker;
  for(const auto* name : {"Akai Force", "AKAI MPC Live", "inMusic output", "MacBook Pro Headphones", "BlackHole"}) {
    invalid.name = name; assert(!xmp::acoustic_device_allowed(invalid,false));
  }
  invalid = speaker; invalid.built_in = false; assert(!xmp::acoustic_device_allowed(invalid,false));
  invalid = speaker; invalid.alive = false; assert(!xmp::acoustic_device_allowed(invalid,false));
  invalid = speaker; invalid.uid = "BuiltInHeadphoneDevice"; assert(!xmp::acoustic_device_allowed(invalid,false));
  invalid = speaker; invalid.output_channels = 0; assert(!xmp::acoustic_device_allowed(invalid,false));
  invalid = speaker; invalid.rate = NAN; assert(!xmp::acoustic_device_allowed(invalid,false));
  std::cout << "Built-in-only policy: protected, external, headphones, wrong role and missing devices rejected\n";
}
