// Shared workspace recording fixture, replayed by tests/parity/sampler-workspace.test.ts.
#include "xmp/live_workbench.hpp"
#include <fstream>
#include <iterator>
int main(int argc,char** argv) {
  if(argc!=3 && (argc!=4 || std::strcmp(argv[3],"--delete"))) return 2;
  std::ifstream input(argv[1]);const std::string text{std::istreambuf_iterator<char>(input),{}};
  const auto opened=xmp::song_snapshot::open(text.data(),text.size());if(!opened.ok) return 3;
  auto project=opened.project;xmp::Str error; xmp::live::ProjectSound sound;
  if(!sound.prepare(project,error)) return 4;
  uint64_t frame=0;bool capturing=false;
  xmp::live::sample::LoopTake loop;
  xmp::live::Workbench w(project,sound,true,{
    [&]{return frame;},[](const auto&){return true;},[&]{capturing=true;return true;},[&]{return capturing;},[&]{capturing=false;},
    []{return std::vector<xmp::live::library::Entry>{};},[](const auto&,auto&){return false;},[](const char*){},
    [&](const auto&)->std::string {xmp::Str song,why;if(!xmp::portable::save_song(project,song,why))return why.c_str();std::ofstream f(argv[2]);f.write(song.data(),song.size());return {};}
  });w.loop=&loop;
  auto button=[&](int code){w.face.button(xmp::live::ui::button_of(code),true,w.board,w.now_state(),w.actions);w.run_actions("fixture");w.face.button(xmp::live::ui::button_of(code),false,w.board,w.now_state(),w.actions);w.run_actions("fixture");w.tick();};
  auto pad=[&](int p){xmp::live::ui::pad_event(w.face,project,w.board,w.now_state(),p,100,w.actions);w.run_actions("fixture");xmp::live::ui::pad_event(w.face,project,w.board,w.now_state(),p,0,w.actions);w.run_actions("fixture");w.tick();};
  auto menu=[&](int p){w.face.button(xmp::live::ui::Button::menu,true,w.board,w.now_state(),w.actions);pad(p);w.face.button(xmp::live::ui::Button::menu,false,w.board,w.now_state(),w.actions);w.run_actions("fixture");w.tick();};
  menu(14);button(0x53);button(0x49);
  float pcm[512],left[512],right[512];unsigned char valid[512];
  std::fill_n(pcm,512,.25f);std::fill_n(valid,512,1);
  const int blocks = argc == 4 ? 450 : 900;
  std::vector<float> rendered; rendered.reserve(blocks*1024);
  for(int n=0;n<blocks;++n) {
    w.tick();if(w.player.playing()&&!w.player.fill(frame+4800,error))return 5;
    std::fill_n(left,512,0.f);std::fill_n(right,512,0.f);
    sound.process(left,right,512,frame,&loop,pcm,valid);
    for(int i=0;i<512;++i) {
      if(w.monitor_input()) left[i]+=pcm[i]*.25f,right[i]+=pcm[i]*.25f;
      rendered.push_back(left[i]);rendered.push_back(right[i]);
    }
    frame+=512;
  }
  {std::ofstream audio(std::string(argv[2])+".audio",std::ios::binary);audio.write(reinterpret_cast<const char*>(rendered.data()),rendered.size()*sizeof(float));}

  if(!w.player.playing() || (w.face.sampler_take(w.board) && w.face.chop_points.empty()))return 6;
  if(argc==4) {
    // This take is still playing directly while its main-engine handoff is queued.
    if(loop.state()!=xmp::live::sample::LoopTake::State::looping) return 8;
    menu(8);
    w.face.button(xmp::live::ui::Button::shift,true,w.board,w.now_state(),w.actions);
    button(0x7a);
    w.face.button(xmp::live::ui::Button::shift,false,w.board,w.now_state(),w.actions);
    std::fill_n(left,512,0.f);std::fill_n(right,512,0.f);
    loop.process(frame,pcm,valid,512,left,right,1.f);
    for(float v:left) if(v!=0) return 9;
    w.tick();
    if(!w.player.playing() || !w.now_state().clip[0].empty() || !w.board.clip[0][0].empty()) return 10;
  }
  button(0x51);menu(4);pad(14);
  return w.project_dirty ? 0 : 7;
}
