#include "xmp/rt_audit.hpp"
#include <atomic>
#include <pthread.h>
namespace {
 pthread_key_t key;
 pthread_once_t once=PTHREAD_ONCE_INIT;
 std::atomic<bool> ready{false};
 thread_local xmp::audit::Counts counts;
 void initialize(){if(pthread_key_create(&key,nullptr)==0)ready.store(true,std::memory_order_release);}
 xmp::audit::Counts* current() noexcept {if(!ready.load(std::memory_order_acquire))return nullptr;return static_cast<xmp::audit::Counts*>(pthread_getspecific(key));}
}
namespace xmp::audit {
void begin() noexcept {pthread_once(&once,initialize);counts={};pthread_setspecific(key,&counts);}
Counts end() noexcept {pthread_setspecific(key,nullptr);return counts;}
void allocation() noexcept {if(auto* value=current())++value->allocations;}
void release() noexcept {if(auto* value=current())++value->frees;}
void lock() noexcept {if(auto* value=current())++value->locks;}
void file() noexcept {if(auto* value=current())++value->files;}
void network() noexcept {if(auto* value=current())++value->network;}
}
