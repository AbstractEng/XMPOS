#pragma once
#include "xmp/engine.hpp"
#include <vector>

namespace xmp {

// A prepared graph plus the sample storage its PreparedSample pointers refer to.
struct GraphOwner {
  PreparedGraph graph;
  std::vector<std::vector<float>> samples;
};

// Loads and validates a bounded host graph file; throws std::runtime_error.
GraphOwner load_host_graph(const char* path);

}  // namespace xmp
