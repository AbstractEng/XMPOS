// Compile only the live audio callback path so its undefined symbols can be
// audited independently from control-thread preparation and file handling.
#include "xmp/live_player.hpp"
extern "C" void xmp_live_audio_callback(xmp::live::ProjectSound* sound, float* left, float* right,
                                        uint32_t frames, uint64_t start, xmp::live::sample::LoopTake* loop,
                                        const float* input, const uint8_t* valid) noexcept {
  sound->process(left, right, frames, start, loop, input, valid);
}
