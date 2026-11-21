#include "community_dsp.h"
void xmp_native_init(xmp_parity_dsp* s,uint32_t source,double gain,double cutoff){xmp_parity_init(s,source,gain,cutoff);}
uint32_t xmp_native_event(xmp_parity_dsp* s,uint32_t op,uint32_t id,uint32_t arg,double value){return xmp_parity_event(s,op,id,arg,value);}
float xmp_native_process(xmp_parity_dsp* s,float input){return xmp_parity_process(s,input);}
uint32_t xmp_native_active(const xmp_parity_dsp* s){return xmp_parity_active(s);}
