#pragma once
#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
namespace xmp {
static_assert(std::atomic<std::uint64_t>::is_always_lock_free,"Lock-free snapshots required on this target");
constexpr std::uint32_t kRate=48000,kBlock=256,kPpq=960;
template<class T,std::size_t Size> class Spsc {
 static_assert(std::atomic<std::size_t>::is_always_lock_free,"Lock-free indices required");
 std::array<T,Size+1> entries_{};std::atomic<std::size_t> head_{0},tail_{0};
 public:
 bool push(const T& value) noexcept {const auto head=head_.load(std::memory_order_relaxed),next=(head+1)%(Size+1);if(next==tail_.load(std::memory_order_acquire))return false;entries_[head]=value;head_.store(next,std::memory_order_release);return true;}
 bool pop(T& value) noexcept {const auto tail=tail_.load(std::memory_order_relaxed);if(tail==head_.load(std::memory_order_acquire))return false;value=entries_[tail];tail_.store((tail+1)%(Size+1),std::memory_order_release);return true;}
 std::size_t size() const noexcept {const auto head=head_.load(std::memory_order_acquire),tail=tail_.load(std::memory_order_acquire);return (head+Size+1-tail)%(Size+1);}
};
struct PreparedSample {const float* data=nullptr;std::uint32_t frames=0;};
struct PatternEvent {std::uint32_t tick=0,sample=0,id=0,duration=0;float velocity=0;std::uint32_t track=0;};
struct PreparedGraph {std::array<PreparedSample,16> samples{};std::uint32_t sample_count=0;std::array<PatternEvent,512> events{};std::uint32_t event_count=0,loop_ticks=3840;double bpm=120,swing=0;bool allow_groove=true;std::array<std::uint8_t,32> project_hash{};std::array<float,8> track_gain{{1,1,1,1,1,1,1,1}};float master=1;};
enum class Op:std::uint16_t {hello=1,snapshot=2,start=3,stop=4,note_on=5,note_off=6,tempo=7,shutdown=8,backend_lost=9,reconnect=10,project=11,groove=12};
enum class Status:std::uint32_t {ok=0,version=1,invalid=2,queue_full=3,handshake=4,applied=5,unsupported=6,voice_refused=7};
struct Command {Op op=Op::snapshot;std::uint64_t ticket=0,timestamp=0;std::uint32_t a=0,b=0;double value=0;};
struct Ack {std::uint64_t ticket=0,revision=0,frame=0;Status status=Status::applied;};
struct Trace {std::uint64_t frame=0;double tick=0;std::uint32_t id=0,kind=0;};
struct Snapshot {std::uint64_t revision=0,frame=0,on=0,off=0,refused=0,trace_drops=0;double tick=0,bpm=120;std::uint32_t running=0,safe=0,pending=0;};
class Engine {
 struct Voice {PreparedSample sample{};std::uint32_t cursor=0,id=0,track=0;double release=0;float gain=0;bool active=false,gated=false;};
 PreparedGraph graph_{};std::array<Voice,32> voices_{};std::array<Command,64> scheduled_{};std::size_t scheduled_size_=0;std::array<Command,16> future_critical_{};std::size_t future_critical_size_=0;
 std::uint64_t frame_=0,revision_=0,on_=0,off_=0,refused_=0,trace_drops_=0,last_loop_=0,play_frame_=0,tempo_anchor_frame_=0;double tempo_anchor_tick_=0,tick_=0,bpm_=120;std::uint32_t next_event_=0;bool running_=false,safe_=false;double swing_=0;Command groove_{};bool groove_pending_=false;
 std::array<std::atomic<std::uint64_t>,12> published_{};
 void note(std::uint32_t id,std::uint32_t sample,float gain,std::uint32_t duration,std::uint32_t track=0) noexcept;
 void release(Voice& voice) noexcept;
 void trace(std::uint32_t id,std::uint32_t kind) noexcept;
 void apply(const Command& command) noexcept;
 void ack(const Ack& value) noexcept;
 void publish() noexcept;
 public:
 Spsc<Command,64> commands;Spsc<Command,16> critical;Spsc<Ack,256> acknowledgements;Spsc<Trace,65536> traces;
 explicit Engine(const PreparedGraph& graph) noexcept;
 void render(float* left,float* right,std::uint32_t frames) noexcept;
 bool snapshot(Snapshot& out) const noexcept;
};
}
