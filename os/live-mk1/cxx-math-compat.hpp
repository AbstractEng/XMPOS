#pragma once
// XMP's existing C-style math calls also build with Clang + libstdc++ headers,
// which need not expose these C++ classification overloads in the global scope.
#include <cmath>
using std::isfinite;
using std::isinf;
using std::isnan;
