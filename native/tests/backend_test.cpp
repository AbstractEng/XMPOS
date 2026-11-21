#include "xmp/audio_backend.hpp"
#include <iostream>
#include <cstdlib>
static void check(bool value){if(!value)std::exit(1);}
int main(){
 for(const auto* name:{"Akai Force","AKAI MPC Live","inMusic instrument","USB DAC"})check(!xmp::safe_builtin_selection(name,false,48000,256));
 check(!xmp::safe_builtin_selection("Akai Force",true,48000,256));check(!xmp::safe_builtin_selection("Mac speakers",true,44100,256));check(!xmp::safe_builtin_selection("Mac speakers",true,48000,512));check(xmp::safe_builtin_selection("Mac speakers",true,48000,256));
 xmp::HostAudioBackend backend;check(std::string(backend.status())=="closed");
 std::cout<<"{\"policyCases\":8,\"openedEndpoints\":0,\"defaultSelection\":false}\n";
}
