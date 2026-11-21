#include "community_dsp.h"
#include <assert.h>
int main(void){
 xmp_parity_dsp s;uint32_t i;
 xmp_native_init(&s,2,.25,8000);
 assert(fabs(xmp_native_process(&s,.5f)-(1-exp(-2*3.14159265358979323846*8000/48000))*.125)<.000002);
 assert(isfinite(xmp_native_process(&s,NAN)));
 assert(isfinite(xmp_native_process(&s,.1f)));
 xmp_native_init(&s,0,.01,8000);
 for(i=1;i<=32;i++)assert(xmp_native_event(&s,1,i,69,.5));
 assert(!xmp_native_event(&s,1,33,69,.5));
 assert(!xmp_native_event(&s,1,1,69,.5));
 assert(xmp_native_active(&s)==32);
 xmp_native_event(&s,5,0,0,0);
 for(i=0;i<240;i++)assert(isfinite(xmp_native_process(&s,0)));
 assert(xmp_native_active(&s)==0);
 return 0;
}
