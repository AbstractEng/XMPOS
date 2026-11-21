// XMP's C++ machines and parameters (xmp/machines.hpp, xmp/parameters.hpp)
// built natively with strict warnings. Parity with the TypeScript is
// tests/parity/parameters-parity.test.ts.
#include "xmp/parameters.hpp"

#include <cstdio>

namespace {
int failures = 0;
void check(bool ok, const char* what) {
  if (!ok) {
    std::printf("FAIL %s\n", what);
    ++failures;
  }
}
}  // namespace

int main() {
  using namespace xmp;
  using json::Value;
  Str pads;
  for (int i = 0; i < 16; ++i) {
    if (i) pads += ",";
    pads += Str("{\"id\":\"pad-") + int_text(i) + "\",\"name\":\"P\",\"sampleId\":\"s\"}";
  }
  Value machine;
  Str error;
  check(machine::machines().instantiate("xmp.midi", machine, error), "instantiate a MIDI machine");
  const Str text =
      Str("{\"format\":\"xmp-project\",\"version\":6,\"id\":\"p\",\"name\":\"T\",\"bpm\":120,\"swing\":0,\"master\":0.5,") +
      "\"pads\":[" + pads + "],\"samples\":[{\"id\":\"s\",\"name\":\"S\",\"sampleRate\":48000,\"pcm\":[0]}]," +
      "\"tracks\":[{\"id\":\"m\",\"name\":\"Keys\",\"muted\":false,\"volume\":0.8,\"clips\":[],\"machine\":" +
      json::stringify(machine) + "}],\"scenes\":[{\"id\":\"a\",\"name\":\"A\",\"clips\":{}}],\"seed\":0," +
      "\"parameterVersion\":1,\"parameters\":[]}";
  const auto opened = project::open(text);
  check(opened.ok, "project with a MIDI track opens");
  const auto reg = parameters::registry(opened.project);
  check(reg.size() == 4 && reg[0].id == "master.gain" && reg[3].id == "track.m.machine.xmp.midi.v1.channel" &&
            reg[3].has_step && reg[3].step == 1.0 / 15 && reg[3].name == "Keys Channel (MIDI channel)",
        "registry: master, gains, the channel");
  double v = 0;
  check(parameters::value(opened.project, "track.m.gain", v, error) && v == 0.8, "track gain from volume");
  auto set = parameters::set_parameter(opened.project, "track.m.machine.xmp.midi.v1.channel", 0.5);
  const Value& state = *set.project.get("tracks")->items()[0].get("machine")->get("state");
  check(set.ok && state.get("channel")->as_number() == 9, "channel snaps to its step (7.5 -> 8, channel 9)");
  check(parameters::set_parameter(opened.project, "track.m.gain", 0.3, "volume").error == "Unknown parameter source",
        "unknown source refused");
  check(!parameters::value(opened.project, "bogus", v, error) && error == "Unknown parameter bogus", "unknown parameter");
  double out = 0;
  check(parameters::smooth(0, 1, 48000, 10, 480, out, error) && fabs(out - (1 - exp(-1.0))) < 1e-15, "one time constant");
  if (failures) return 1;
  std::printf("machines and parameters: registry, values, edits and smoothing ok\n");
  return 0;
}
