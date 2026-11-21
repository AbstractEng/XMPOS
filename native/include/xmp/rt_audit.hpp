#pragma once
#include <cstdint>
namespace xmp::audit {
struct Counts {std::uint64_t allocations=0,frees=0,locks=0,files=0,network=0;};
void begin() noexcept;
Counts end() noexcept;
void allocation() noexcept;
void release() noexcept;
void lock() noexcept;
void file() noexcept;
void network() noexcept;
}
