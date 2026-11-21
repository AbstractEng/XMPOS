#include "xmp/live_platform_linux.hpp"
// Compile the Linux resource API independently of the instrument application.
static_assert(sizeof(xmp::live::platform::Screen) > sizeof(xmp::live::Canvas), "framebuffer ownership");
