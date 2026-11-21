#include "xmp/community.h"
#include <csignal>
#include <cstring>
#include <iostream>
#include <sys/resource.h>
#include <unistd.h>
// Only this locally compiled test fixture has a fatal injection callback.
static void fault(void*,const float*,float*,uint32_t){::kill(::getpid(),SIGKILL);}
int main(int argc,char** argv){
 if(argc!=2||std::strcmp(argv[1],"--inject-trusted-dsp-fault")!=0)return 2;
 const rlimit limit={0,0};setrlimit(RLIMIT_CORE,&limit);
 xmp_sdk_plugin_v1 module={1,3,nullptr,fault};
 std::cout<<"{\"ready\":true,\"trustedNativeInHost\":true,\"faultInjection\":\"SIGKILL inside DSP callback\"}\n"<<std::flush;
 float output=0;module.process(module.state,nullptr,&output,1);return 1;
}
