#ifndef XMP_PLUGIN_H
#define XMP_PLUGIN_H
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
// Experimental ABI, not a stable external plugin contract or dynamic loader.
// Caller owns buffers; this function never allocates, blocks or performs I/O.
#define XMP_DSP_API_VERSION 1u
void xmp_gain_process(float* left, float* right, uint32_t frames, float gain);
#ifdef __cplusplus
}
#endif
#endif
