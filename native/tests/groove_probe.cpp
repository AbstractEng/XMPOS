#include "xmp/engine.hpp"
#include "xmp/protocol.hpp"
#include <array>
#include <cmath>
#include <iostream>
#include <limits>
#include <memory>
#include <stdexcept>
void require(bool value){if(!value)throw std::runtime_error("Native groove invariant failed");}
int main(){try{
 std::array<float,48000> sample{};sample.fill(0.25f);xmp::PreparedGraph graph;graph.samples[0]={sample.data(),static_cast<unsigned>(sample.size())};graph.sample_count=1;graph.event_count=4;for(unsigned i=0;i<4;++i)graph.events[i]={i*240,0,i+1,0,0.5f,0};
 std::array<std::uint8_t,40> packet{};xmp::protocol::put(packet.data(),0,4,0x34504d58);xmp::protocol::put(packet.data(),4,2,1);xmp::protocol::put(packet.data(),6,2,12);xmp::protocol::put(packet.data(),12,4,16);xmp::protocol::put(packet.data(),16,8,3840);xmp::protocol::put(packet.data(),24,4,1);xmp::protocol::number(packet.data(),32,1.0/3);xmp::Snapshot initial;xmp::Command decoded;require(xmp::protocol::decode(packet.data(),initial,1,true,decoded)==xmp::Status::ok);xmp::protocol::put(packet.data(),24,4,2);require(xmp::protocol::decode(packet.data(),initial,1,true,decoded)==xmp::Status::invalid);
 auto engine=std::make_unique<xmp::Engine>(graph);std::array<float,1> left{},right{};engine->critical.push({xmp::Op::start,1,0,0,0,0});engine->render(left.data(),right.data(),1);
 engine->commands.push({xmp::Op::groove,2,3840,1,0,1.0/3});engine->render(left.data(),right.data(),1);
 xmp::Ack ack;bool accepted=false;while(engine->acknowledgements.pop(ack))if(ack.ticket==2)accepted=ack.status==xmp::Status::ok;require(accepted);
 engine->commands.push({xmp::Op::groove,3,3840,1,0,std::numeric_limits<double>::quiet_NaN()});engine->commands.push({xmp::Op::groove,4,3840,2,0,0});engine->render(left.data(),right.data(),1);unsigned rejected=0;while(engine->acknowledgements.pop(ack))if((ack.ticket==3||ack.ticket==4)&&ack.status==xmp::Status::invalid)++rejected;require(rejected==2);
 // This live voice must cross the groove boundary without a fabricated note-off.
 engine->commands.push({xmp::Op::note_on,5,95000,99,0,0.5});
 std::array<unsigned long long,12> frames{};unsigned count=0;bool crossed=false;unsigned changes=0;
 for(unsigned frame=3;frame<202001;++frame){if(frame==150000){engine->commands.push({xmp::Op::groove,6,7680,1,0,0});}engine->render(left.data(),right.data(),1);xmp::Trace trace;while(engine->traces.pop(trace)){if(trace.kind==1&&trace.id!=99&&count<frames.size())frames[count++]=trace.frame;if(trace.kind==5){++changes;if(trace.frame==96000)crossed=true;}if(trace.id==99&&trace.kind==2)require(trace.frame>=142999);}}
 require(count==10&&crossed&&changes==2);const std::array<unsigned long long,10> expected{{0,6000,12000,18000,96000,104000,108000,116000,192000,198000}};for(unsigned i=0;i<count;++i)require(frames[i]==expected[i]);xmp::Snapshot snapshot;require(engine->snapshot(snapshot)&&snapshot.frame==202001&&snapshot.running==1);require(graph.events[1].tick==240);
 std::cout<<"{\"accepted\":true,\"rejected\":2,\"frames\":[";for(unsigned i=0;i<count;++i){if(i)std::cout<<",";std::cout<<frames[i];}std::cout<<"],\"sampleClock\":"<<snapshot.frame<<",\"running\":true,\"originalTick\":240,\"activeNoteContinuous\":true,\"changes\":"<<changes<<"}\n";return 0;
 }catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}}
