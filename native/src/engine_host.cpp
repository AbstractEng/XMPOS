#include "xmp/engine.hpp"
#include "xmp/host_graph.hpp"
#include "xmp/protocol.hpp"
#include "xmp/rt_audit.hpp"
#include "xmp/rt_thread.hpp"
#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <csignal>
#include <cstring>
#include <fcntl.h>
#include <fstream>
#include <iostream>
#include <memory>
#include <poll.h>
#include <stdexcept>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <thread>
#include <unistd.h>
#include <vector>
namespace {
volatile std::sig_atomic_t interrupted=0;
void interrupt(int){interrupted=1;}
void put16(std::ostream& out,std::uint16_t value){out.put(value&255);out.put((value>>8)&255);}
void put32(std::ostream& out,std::uint32_t value){put16(out,value&65535);put16(out,value>>16);}
struct Client {int fd=-1;std::uint64_t generation=0;bool handshake=false;std::array<std::uint8_t,4096> input{};std::size_t used=0;std::array<std::uint8_t,32768> output{};std::size_t sent=0,size=0;};
struct Pending {std::uint64_t ticket=0;std::uint32_t client=0,id=0;std::uint16_t op=0;std::uint64_t generation=0;bool ready=false;std::uint64_t applied_revision=0;xmp::Status status=xmp::Status::applied;};
struct Metrics {std::atomic<std::uint64_t> callbacks{0},overruns{0},max_ns{0},faults{0};};
void close_client(Client& client){if(client.fd>=0)::close(client.fd);client=Client{};}
}
int main(int argc,char** argv){
 try{
  // No default audio device, hardware flag, device discovery or writable device adapter.
  if(argc!=9||(std::string(argv[1])!="--virtual"&&std::string(argv[1])!="--virtual-bounded"))throw std::runtime_error("Usage: xmp_engine_host --virtual graph socket report capture trace seconds project");
  const bool bounded=std::string(argv[1])=="--virtual-bounded";
  const auto seconds=std::stoi(argv[7]);if(seconds<1||seconds>(bounded?28800:60))throw std::runtime_error("Virtual duration exceeds the selected profile");
  std::ifstream project_file(argv[8],std::ios::binary|std::ios::ate);if(!project_file||project_file.tellg()<0||project_file.tellg()>24*1024*1024)throw std::runtime_error("Project snapshot exceeds profile");
  std::string project(static_cast<std::size_t>(project_file.tellg()),'\0');project_file.seekg(0);if(!project_file.read(project.data(),project.size()))throw std::runtime_error("Project snapshot read failed");
  const auto owner=xmp::load_host_graph(argv[2]);auto engine=std::make_unique<xmp::Engine>(owner.graph);
  sockaddr_un address{};address.sun_family=AF_UNIX;if(std::strlen(argv[3])>=sizeof(address.sun_path))throw std::runtime_error("Socket path too long");std::strcpy(address.sun_path,argv[3]);
  const int server=::socket(AF_UNIX,SOCK_STREAM,0);if(server<0)throw std::runtime_error("Socket creation failed");
  if(::bind(server,reinterpret_cast<sockaddr*>(&address),sizeof(address))!=0){::close(server);throw std::runtime_error("Cannot bind owned session socket");}
  ::chmod(argv[3],0600);if(::listen(server,16)!=0)throw std::runtime_error("Listen failed");::fcntl(server,F_SETFL,O_NONBLOCK);
  std::signal(SIGPIPE,SIG_IGN);std::signal(SIGTERM,interrupt);std::signal(SIGINT,interrupt);
  const auto capacity=static_cast<std::size_t>(seconds)*xmp::kRate;const auto capture_frames=bounded?std::min<std::size_t>(capacity,96000):capacity;std::vector<float> capture(capture_frames*2);std::vector<std::uint64_t> durations(bounded?0:(capacity+255)/256);std::array<std::uint64_t,64> histogram{};std::vector<xmp::Trace> trace;trace.reserve(65536);Metrics metrics;std::atomic<bool> finished{false},stop{false};std::size_t written=0;
  xmp::RealtimeResult realtime{};
  // Promote before the loop and outside the audited render: a normal-priority
  // thread can be preempted mid-render, which the gate correctly counts as a miss.
  std::thread audio([&]{realtime=xmp::promote_audio_thread(static_cast<std::uint64_t>(xmp::kBlock)*1000000000ULL/xmp::kRate);std::array<float,256> left{},right{};const auto anchor=std::chrono::steady_clock::now();while(written<capacity&&!stop.load(std::memory_order_acquire)){const auto count=static_cast<std::uint32_t>(std::min<std::size_t>(256,capacity-written));const auto start=std::chrono::steady_clock::now();xmp::audit::begin();engine->render(left.data(),right.data(),count);const auto audit=xmp::audit::end();const auto elapsed=static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now()-start).count());const auto index=metrics.callbacks.load();if(bounded){std::size_t bin=0;for(auto value=elapsed;value>1;value>>=1)++bin;++histogram[bin];}else durations[index]=elapsed;metrics.callbacks.store(index+1);if(elapsed>metrics.max_ns.load())metrics.max_ns.store(elapsed);if(elapsed>static_cast<std::uint64_t>(count)*1000000000/xmp::kRate)++metrics.overruns;metrics.faults.fetch_add(audit.allocations+audit.frees+audit.locks+audit.files+audit.network);for(std::size_t frame=0;frame<count;++frame){const auto slot=(written+frame)%capture_frames;capture[slot*2]=left[frame];capture[slot*2+1]=right[frame];}written+=count;std::this_thread::sleep_until(anchor+std::chrono::nanoseconds(written*1000000000/xmp::kRate));}finished.store(true,std::memory_order_release);});
  std::array<Client,16> clients{};std::array<Pending,256> pending{};std::uint64_t ticket=0,queue_drops=0,slow_clients=0,client_generation=0;bool shutdown=false;
  std::uint64_t observed_trace=0,trace_digest=1469598103934665603ull;
  auto collect_trace=[&](const xmp::Trace& event){++observed_trace;std::uint64_t tick_bits=0;std::memcpy(&tick_bits,&event.tick,8);for(const auto value:{event.frame,tick_bits,static_cast<std::uint64_t>(event.id),static_cast<std::uint64_t>(event.kind)}){trace_digest^=value;trace_digest*=1099511628211ull;}if(trace.size()<65536)trace.push_back(event);};
  xmp::Snapshot cached_snapshot;engine->snapshot(cached_snapshot);
  auto reply=[&](Client& client,std::uint32_t id,std::uint16_t op,xmp::Status status,const char* data=nullptr,std::size_t data_size=0){if(client.fd<0)return;if(client.size-client.sent+xmp::protocol::response_bytes+data_size>client.output.size()){++slow_clients;close_client(client);return;}if(client.sent){std::memmove(client.output.data(),client.output.data()+client.sent,client.size-client.sent);client.size-=client.sent;client.sent=0;}xmp::Snapshot snapshot=cached_snapshot;if(engine->snapshot(snapshot))cached_snapshot=snapshot;std::array<std::uint8_t,xmp::protocol::response_bytes> bytes{};xmp::protocol::put(bytes.data(),0,4,0x34524d58);xmp::protocol::put(bytes.data(),4,2,1);xmp::protocol::put(bytes.data(),6,2,op);xmp::protocol::put(bytes.data(),8,4,id);xmp::protocol::put(bytes.data(),12,4,static_cast<std::uint32_t>(status));xmp::protocol::put(bytes.data(),16,8,snapshot.revision);xmp::protocol::put(bytes.data(),24,8,snapshot.frame);xmp::protocol::number(bytes.data(),32,snapshot.tick);xmp::protocol::number(bytes.data(),40,snapshot.bpm);const std::uint64_t counters[]={snapshot.on,snapshot.off,snapshot.refused,queue_drops,metrics.callbacks.load(),metrics.overruns.load(),snapshot.trace_drops};for(std::size_t i=0;i<7;++i)xmp::protocol::put(bytes.data(),48+i*8,8,counters[i]);xmp::protocol::put(bytes.data(),104,4,snapshot.running|(snapshot.safe<<1));xmp::protocol::put(bytes.data(),108,4,snapshot.pending+engine->commands.size()+engine->critical.size());xmp::protocol::put(bytes.data(),112,8,metrics.max_ns.load());xmp::protocol::put(bytes.data(),120,4,metrics.faults.load());xmp::protocol::put(bytes.data(),124,4,data_size);xmp::protocol::put(bytes.data(),128,4,xmp::kRate);xmp::protocol::put(bytes.data(),132,4,xmp::kBlock);xmp::protocol::put(bytes.data(),136,8,1);std::copy(owner.graph.project_hash.begin(),owner.graph.project_hash.end(),bytes.begin()+144);std::copy(bytes.begin(),bytes.end(),client.output.begin()+client.size);client.size+=bytes.size();if(data_size){std::memcpy(client.output.data()+client.size,data,data_size);client.size+=data_size;}};
  std::cout<<"{\"ready\":true,\"backend\":\"virtual-paced\",\"sampleRate\":48000,\"bufferFrames\":256}\n"<<std::flush;
  while(!finished.load(std::memory_order_acquire)&&!interrupted&&!shutdown){
   std::array<pollfd,17> descriptors{};descriptors[0]={server,POLLIN,0};for(std::size_t i=0;i<clients.size();++i)descriptors[i+1]={clients[i].fd,static_cast<short>(POLLIN|(clients[i].size>clients[i].sent?POLLOUT:0)),0};::poll(descriptors.data(),descriptors.size(),1);
   if(descriptors[0].revents&POLLIN){const int fd=::accept(server,nullptr,nullptr);if(fd>=0){auto slot=std::find_if(clients.begin(),clients.end(),[](const Client& client){return client.fd<0;});if(slot==clients.end())::close(fd);else{slot->fd=fd;slot->generation=++client_generation;::fcntl(fd,F_SETFL,O_NONBLOCK);}}}
   for(std::size_t index=0;index<clients.size();++index){auto& client=clients[index];if(client.fd<0)continue;const auto events=descriptors[index+1].revents;if(events&(POLLHUP|POLLERR|POLLNVAL)){close_client(client);continue;}
    if(events&POLLIN){const auto received=::recv(client.fd,client.input.data()+client.used,client.input.size()-client.used,0);if(received==0){close_client(client);continue;}if(received>0)client.used+=static_cast<std::size_t>(received);}
    for(int work=0;work<64&&client.fd>=0&&client.used>=40;++work){std::array<std::uint8_t,40> bytes{};std::copy_n(client.input.begin(),40,bytes.begin());std::memmove(client.input.data(),client.input.data()+40,client.used-40);client.used-=40;xmp::Snapshot snapshot=cached_snapshot;if(engine->snapshot(snapshot))cached_snapshot=snapshot;xmp::Command command;const auto status=xmp::protocol::decode(bytes.data(),snapshot,owner.graph.sample_count,client.handshake,command);const auto id=static_cast<std::uint32_t>(xmp::protocol::get(bytes.data(),8,4));const auto op=static_cast<std::uint16_t>(xmp::protocol::get(bytes.data(),6,2));
     if(status!=xmp::Status::ok){reply(client,id,op,status);continue;}
     if(command.op==xmp::Op::hello){client.handshake=true;reply(client,id,op,xmp::Status::ok);continue;}
     if(command.op==xmp::Op::snapshot){reply(client,id,op,xmp::Status::ok);continue;}
     if(command.op==xmp::Op::project){if(command.a>project.size())reply(client,id,op,xmp::Status::invalid);else reply(client,id,op,xmp::Status::ok,project.data()+command.a,std::min<std::size_t>(command.b,project.size()-command.a));continue;}
     if(command.op==xmp::Op::shutdown){reply(client,id,op,xmp::Status::ok);shutdown=true;continue;}
     auto slot=std::find_if(pending.begin(),pending.end(),[](const Pending& item){return item.ticket==0;});command.ticket=++ticket;
     const bool critical=command.op==xmp::Op::start||command.op==xmp::Op::stop||command.op==xmp::Op::note_off||command.op==xmp::Op::backend_lost||command.op==xmp::Op::reconnect;
     if(slot==pending.end()||(!critical&&std::count_if(pending.begin(),pending.end(),[](const Pending& item){return item.ticket==0;})<=16)||!(critical?engine->critical.push(command):engine->commands.push(command))){++queue_drops;reply(client,id,op,xmp::Status::queue_full);}else *slot={command.ticket,static_cast<std::uint32_t>(index),id,op,client.generation,false,0,xmp::Status::applied};
    }
    if(client.fd>=0&&client.size>client.sent){const auto sent=::send(client.fd,client.output.data()+client.sent,client.size-client.sent,0);if(sent>0){client.sent+=static_cast<std::size_t>(sent);if(client.sent==client.size)client.sent=client.size=0;}}
   }
   xmp::Ack ack;for(int work=0;work<256&&engine->acknowledgements.pop(ack);++work){auto slot=std::find_if(pending.begin(),pending.end(),[&](const Pending& item){return item.ticket==ack.ticket;});if(slot!=pending.end()){if(ack.status==xmp::Status::queue_full)++queue_drops;slot->ready=true;slot->status=ack.status;slot->applied_revision=ack.revision;}}
   engine->snapshot(cached_snapshot);for(auto& item:pending)if(item.ticket&&item.ready&&cached_snapshot.revision>=item.applied_revision){if(clients[item.client].generation==item.generation)reply(clients[item.client],item.id,item.op,item.status);item.ticket=0;item.ready=false;}
   xmp::Trace event;for(int work=0;work<4096&&engine->traces.pop(event);++work)collect_trace(event);
  }
  stop.store(true,std::memory_order_release);audio.join();engine->critical.push({xmp::Op::stop,0,0,0,0,0});std::array<float,1> silence{};engine->render(silence.data(),silence.data(),0);xmp::Trace event;while(engine->traces.pop(event))collect_trace(event);for(auto& client:clients)close_client(client);::close(server);::unlink(argv[3]);
  xmp::Snapshot final;engine->snapshot(final);std::uint64_t p99=0;
  if(bounded){const auto rank=(metrics.callbacks.load()*99+99)/100;std::uint64_t count=0;for(std::size_t bin=0;bin<histogram.size();++bin){count+=histogram[bin];if(count>=rank){p99=bin>=63?~std::uint64_t{0}:(std::uint64_t{1}<<(bin+1))-1;break;}}}
  else{durations.resize(metrics.callbacks.load());std::sort(durations.begin(),durations.end());p99=durations.empty()?0:durations[(durations.size()-1)*99/100];}
  const auto captured=std::min(written,capture_frames),capture_start=written>capture_frames?written%capture_frames:0;

  std::ofstream report(argv[4]);report<<"{\"backend\":\"virtual-paced\",\"physicalAudio\":false,\"realtimeScheduling\":\""<<xmp::scheduling_name(realtime.scheduling)<<"\",\"memoryLocked\":"<<(realtime.memoryLocked?"true":"false")<<",\"frames\":"<<written<<",\"callbacks\":"<<metrics.callbacks.load()<<",\"overruns\":"<<metrics.overruns.load()<<",\"callbackP99Ns\":"<<p99<<",\"callbackMaxNs\":"<<metrics.max_ns.load()<<",\"auditFaults\":"<<metrics.faults.load()<<",\"queueDrops\":"<<queue_drops<<",\"slowClients\":"<<slow_clients<<",\"on\":"<<final.on<<",\"off\":"<<final.off<<",\"traceDrops\":"<<final.trace_drops<<",\"boundedMetrics\":"<<(bounded?"true":"false")<<",\"callbackP99IsUpperBound\":"<<(bounded?"true":"false")<<",\"captureFrames\":"<<captured<<",\"captureStartFrame\":"<<(written-captured)<<",\"traceObserved\":"<<observed_trace<<",\"traceDigest\":\""<<trace_digest<<"\",\"traceTruncated\":"<<(observed_trace>trace.size()?"true":"false")<<",\"projectGeneration\":1}\n";
  std::ofstream capture_file(argv[5],std::ios::binary);capture_file.write("RIFF",4);put32(capture_file,36+captured*4);capture_file.write("WAVEfmt ",8);put32(capture_file,16);put16(capture_file,1);put16(capture_file,2);put32(capture_file,48000);put32(capture_file,192000);put16(capture_file,4);put16(capture_file,16);capture_file.write("data",4);put32(capture_file,captured*4);for(std::size_t i=0;i<captured*2;++i){const auto frame=(capture_start+i/2)%capture_frames;const float value=capture[frame*2+i%2];put16(capture_file,static_cast<std::int16_t>(std::lround(value*(value<0?32768:32767))));}
  std::ofstream trace_file(argv[6]);trace_file<<"[";for(std::size_t i=0;i<trace.size();++i){if(i)trace_file<<",";trace_file<<"{\"frame\":"<<trace[i].frame<<",\"tick\":"<<trace[i].tick<<",\"id\":"<<trace[i].id<<",\"kind\":"<<trace[i].kind<<"}";}trace_file<<"]\n";
  if(!report||!capture_file||!trace_file){throw std::runtime_error("Evidence write failed");}
  return 0;
 }catch(const std::exception& error){std::cerr<<error.what()<<'\n';return 1;}
}
