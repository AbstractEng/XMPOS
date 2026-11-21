#include "xmp/live_controls.hpp"
#include "xmp/rt_thread.hpp"
#include <cstdio>
#include <string>
#include <vector>

using namespace xmp::live;
static int failures = 0;
static void check(bool ok, const char* what) {
  if (!ok) {
    std::printf("FAIL: %s\n", what);
    ++failures;
  }
}

static std::vector<Event> parse(const std::vector<std::uint8_t>& bytes, Parser& parser) {
  std::vector<Event> events;
  Event e;
  for (auto b : bytes)
    if (parser.feed(b, e)) events.push_back(e);
  return events;
}

int main() {
  // Pads: channel 10 notes; pad 1 = 0x25, pad 16 = 0x35; running status; velocity 0 = release.
  {
    Parser p;
    auto ev = parse({0x99, 0x25, 0x64, 0x35, 0x7F, 0x25, 0x00, 0x89, 0x35, 0x40, 0xA9, 0x24, 0x30}, p);
    check(ev.size() == 5, "five pad events");
    check(ev[0].kind == Kind::pad_on && ev[0].pad == 0 && ev[0].data2 == 0x64, "pad 1 on");
    check(ev[1].kind == Kind::pad_on && ev[1].pad == 15, "pad 16 on by running status");
    check(ev[2].kind == Kind::pad_off && ev[2].pad == 0, "velocity 0 is release");
    check(ev[3].kind == Kind::pad_off && ev[3].pad == 15, "note off");
    check(ev[4].kind == Kind::pad_pressure && ev[4].pad == 1, "pad 2 pressure");
  }
  // Buttons on channel 1, controls, real-time bytes ignored, SysEx captured.
  {
    Parser p;
    auto ev = parse({0x90, 49, 0x7F, 0xF8, 0x90, 49, 0x00, 0xB0, 0x10, 0x01, 0xF0, 0x47, 0x7F, 0x3B, 0x41, 0xF7}, p);
    check(ev.size() == 4, "four events");
    check(ev[0].kind == Kind::button_on && ev[0].data1 == 49, "Shift press");
    check(ev[1].kind == Kind::button_off, "Shift release");
    check(ev[2].kind == Kind::control, "control change");
    check(ev[3].kind == Kind::sysex && p.sysex_size() == 6 && p.sysex()[4] == 0x41, "SysEx captured");
  }
  // An unknown channel-10 note is not a pad.
  {
    Parser p;
    auto ev = parse({0x99, 0x10, 0x40}, p);
    check(ev.size() == 1 && ev[0].kind == Kind::other && ev[0].pad < 0, "non-pad note");
  }
  // Pad map: 16 distinct notes.
  for (std::size_t i = 0; i < kPadNotes.size(); ++i)
    check(pad_index(kPadNotes[i]) == static_cast<int>(i), "pad map is one-to-one");
  // Startup bytes: only well-formed Akai (0x47) or universal (0x7E) SysEx.
  {
    check(kIdentityRequest.front() == 0xF0 && kIdentityRequest.back() == 0xF7, "identity request framed");
    int messages = 0;
    bool inside = false, ok = true;
    for (auto b : kStartupSequence) {
      if (b == 0xF0) {
        ok = ok && !inside;
        inside = true;
        ++messages;
      } else if (b == 0xF7) {
        ok = ok && inside;
        inside = false;
      } else ok = ok && inside && b < 0x80;
    }
    check(ok && !inside && messages == 8, "start-up sequence is eight framed SysEx messages");
    for (std::size_t i = 0; i + 3 < kStartupSequence.size(); ++i)
      if (kStartupSequence[i] == 0xF0)
        check(kStartupSequence[i + 1] == 0x47 && kStartupSequence[i + 3] == 0x3B, "Akai MPC Live SysEx only");
  }
  {
    using Result = QLinkLeds::Result;
    constexpr std::array<std::array<std::uint8_t, 12>, 4> expected{{
        {{0xB0, 0x5B, 0, 0xB0, 0x5C, 0, 0xB0, 0x5D, 0, 0xB0, 0x5A, 3}},
        {{0xB0, 0x5A, 0, 0xB0, 0x5C, 0, 0xB0, 0x5D, 0, 0xB0, 0x5B, 3}},
        {{0xB0, 0x5A, 0, 0xB0, 0x5B, 0, 0xB0, 0x5D, 0, 0xB0, 0x5C, 3}},
        {{0xB0, 0x5A, 0, 0xB0, 0x5B, 0, 0xB0, 0x5C, 0, 0xB0, 0x5D, 3}},
    }};
    QLinkLeds leds;
    std::vector<std::uint8_t> bytes;
    auto write = [&](const std::uint8_t* p, std::size_t n) {
      bytes.insert(bytes.end(), p, p + n);
      return static_cast<int>(n);
    };
    check(kQLinkLedPort == 1, "Q-Link LEDs use the Private port only");
    check(leds.sync(-1, write) == Result::idle && leds.sync(4, write) == Result::idle && bytes.empty(),
          "unknown pages produce no output");
    for (int page = 0; page < 4; ++page) {
      bytes.clear();
      check(leds.sync(page, write) == Result::sent && leds.page() == page, "marks the page sent");
      check(bytes.size() == 12 && std::equal(bytes.begin(), bytes.end(), expected[page].begin()),
            "wire bytes match the allowlist and leave one red LED");
      check(leds.sync(page, write) == Result::idle && bytes.size() == 12, "unchanged page is silent");
    }
    bytes.clear();
    check(leds.sync(0, [&](const std::uint8_t* p, std::size_t) { return write(p, 2); }) == Result::pending,
          "handles a short nonblocking write");
    check(leds.sync(1, [](const auto*, auto) { return 0; }) == Result::pending, "handles a busy port");
    check(leds.sync(1, write) == Result::sent && leds.page() == 0 && bytes.size() == 12 &&
              std::equal(bytes.begin(), bytes.end(), expected[0].begin()),
          "finishes the current MIDI frame before changing the LEDs");
    check(leds.sync(1, [](const auto*, auto) { return -1; }) == Result::failed, "reports a rejected write");
  }
  {
    PanelFeedback feedback;PanelLights state;state.button(0x52,true);state.pads[15]={127,12,4};
    std::vector<std::uint8_t> bytes;
    const auto write=[&](const auto* p,std::size_t n){bytes.insert(bytes.end(),p,p+n);return static_cast<int>(n);};
    using Result=PanelFeedback::Result;
    check(feedback.sync(1,state,write)==Result::sent&&bytes.size()==51,"initial button snapshot is bounded");
    for(size_t i=0;i<bytes.size();i+=3)check(bytes[i]==0xB0&&bytes[i+1]==kFeedbackButtons[i/3]&&(bytes[i+2]==0||bytes[i+2]==3),"button frame contains only allowlisted CC");
    bytes.clear();check(feedback.sync(0,state,write)==Result::sent&&bytes.size()==192,"initial pads use sixteen RGB messages");
    for(size_t i=0;i<bytes.size();i+=12) {
      check(bytes[i]==0xF0&&bytes[i+1]==0x47&&bytes[i+2]==0x7F&&bytes[i+3]==0x3B&&bytes[i+4]==0x65&&bytes[i+5]==0&&bytes[i+6]==4&&bytes[i+7]==i/12&&bytes[i+11]==0xF7,"pad frame has only the Live RGB display opcode");
      check(bytes[i+8]<128&&bytes[i+9]<128&&bytes[i+10]<128,"RGB payload is seven bit");
    }
    bytes.clear();check(feedback.sync(0,state,write)==Result::idle&&bytes.empty(),"unchanged pads produce no traffic");
    state.pads[0]={0,127,0};
    check(feedback.sync(0,state,[&](const auto* p,std::size_t){return write(p,5);})==Result::pending,"short RGB write waits");
    state.pads[0]={127,0,0};
    check(feedback.sync(0,state,write)==Result::sent&&bytes.size()==12&&bytes[9]==127,"newer colours cannot splice an old SysEx");
    bytes.clear();check(feedback.sync(0,state,write)==Result::sent&&bytes.size()==12&&bytes[8]==127,"latest colour follows the completed frame");
    bytes.clear();state.pads[0].r=128;
    check(feedback.sync(0,state,write)==Result::failed&&bytes.empty(),"invalid RGB cannot reach a device");
    state.buttons[0]=127;check(feedback.sync(1,state,write)==Result::failed&&bytes.empty(),"invalid button value cannot reach a device");
    check(feedback.sync(2,state,write)==Result::idle&&bytes.empty(),"no arbitrary output port");
  }
  // Audio card: only the Live's own card on the Live; never the Force or another card.
  {
    const std::string live = "inmusic,acv8 inmusic,az01 rockchip,rk3288";
    const std::string card = "Audio\n 09e8:203b\n Akai Professional MPC Live Audio at usb-ff500000.usb-1.5";
    check(live_audio_card_allowed(card, live), "Live audio card allowed on the Live");
    check(!live_audio_card_allowed(card, "inmusic,ada2 inmusic,az01 rockchip,rk3288"), "refused on a Force tree");
    check(!live_audio_card_allowed(card, "linux,dummy-virt"), "refused off the Live");
    check(!live_audio_card_allowed("Force\n 09e8:0000\n Akai Professional Force", live), "Force card refused");
    check(!live_audio_card_allowed("Controller\n 09e8:003b\n Akai Pro MPC Live Controller", live), "controller is not audio");
    check(!live_audio_card_allowed("Audio\n 46f4:0002\n QEMU USB Audio", live), "other card refused");
    check(live_controller_card("Controller\n 09e8:003b\n Akai Pro MPC Live Controller"), "controller recognised");
    const std::string controller = "Controller\n 09e8:003b\n";
    const std::string internal = "Akai Pro MPC Live Controller at usb-ff500000.usb-1.6, full speed";
    const std::string twin = "XMP emulator MPC Live Controller at usb-dummy_hcd.2-1, full speed";
    check(qlink_led_controller_allowed(live, controller, internal), "LEDs allow the Live's internal USB port");
    check(!qlink_led_controller_allowed(live, controller, "Akai Pro MPC Live Controller at usb-ff500000.usb-1.3, full speed"),
          "LEDs refuse even a matching USB ID on an external port");
    check(!qlink_led_controller_allowed("inmusic,acv8 inmusic,ada2", controller, internal),
          "LEDs refuse a Force identity");
    check(!qlink_led_controller_allowed(live, controller, twin) &&
              qlink_led_controller_allowed("linux,dummy-virt inmusic,acv8", controller, twin),
          "LEDs accept the named twin only in the emulator");
  }
  // Isolated-core choice for the audio thread (the Live boots with isolcpus=2-3).
  check(xmp::highest_isolated_cpu("2-3\n") == 3, "isolcpus 2-3 picks core 3");
  check(xmp::highest_isolated_cpu("1,3-5") == 5, "CPU list with ranges");
  check(xmp::highest_isolated_cpu("\n") == -1 && xmp::highest_isolated_cpu("") == -1, "none isolated");
  check(xmp::highest_isolated_cpu("x") == -1 && xmp::highest_isolated_cpu("3-1") == -1, "malformed list refused");
  // -12 dBFS ceiling.
  check(limit(1.0f) <= 0.2512f && limit(-1.0f) >= -0.2512f && limit(0.1f) == 0.1f, "peak limit");
  std::printf(failures ? "live controls failed\n" : "live controls passed\n");
  return failures ? 1 : 0;
}
