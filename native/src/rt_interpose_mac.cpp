// Process-local test interposition. No injected library or system setting is changed.
#include "xmp/rt_audit.hpp"
#include <cstdlib>
#include <cstdio>
#include <cstdarg>
#include <fcntl.h>
#include <pthread.h>
#include <sys/socket.h>
#include <unistd.h>
namespace {
void* allocation(std::size_t n){xmp::audit::allocation();return std::malloc(n);}
void* zero_allocation(std::size_t n,std::size_t size){xmp::audit::allocation();return std::calloc(n,size);}
void* reallocation(void* p,std::size_t n){xmp::audit::allocation();return std::realloc(p,n);}
void release(void* p){xmp::audit::release();std::free(p);}
int lock(pthread_mutex_t* p){xmp::audit::lock();return pthread_mutex_lock(p);}
int file_open(const char* path,int flags,...){xmp::audit::file();mode_t mode=0;if(flags&O_CREAT){va_list args;va_start(args,flags);mode=static_cast<mode_t>(va_arg(args,int));va_end(args);}return ::open(path,flags,mode);}
ssize_t file_read(int fd,void* data,std::size_t n){xmp::audit::file();return ::read(fd,data,n);}
ssize_t file_write(int fd,const void* data,std::size_t n){xmp::audit::file();return ::write(fd,data,n);}
std::size_t stream_write(const void* p,std::size_t size,std::size_t n,FILE* stream){xmp::audit::file();return std::fwrite(p,size,n,stream);}
int network_socket(int domain,int type,int protocol){xmp::audit::network();return ::socket(domain,type,protocol);}
ssize_t network_send(int fd,const void* p,std::size_t n,int flags){xmp::audit::network();return ::send(fd,p,n,flags);}
ssize_t network_recv(int fd,void* p,std::size_t n,int flags){xmp::audit::network();return ::recv(fd,p,n,flags);}
struct Interposition {const void* replacement;const void* original;};
#define XMP_REDIRECT(replacement,original) {reinterpret_cast<const void*>(replacement),reinterpret_cast<const void*>(original)}
__attribute__((used,section("__DATA,__interpose"))) const Interposition redirects[]={
 XMP_REDIRECT(allocation,malloc),XMP_REDIRECT(zero_allocation,calloc),XMP_REDIRECT(reallocation,realloc),XMP_REDIRECT(release,free),XMP_REDIRECT(lock,pthread_mutex_lock),XMP_REDIRECT(file_open,open),XMP_REDIRECT(file_read,read),XMP_REDIRECT(file_write,write),XMP_REDIRECT(stream_write,fwrite),XMP_REDIRECT(network_socket,socket),XMP_REDIRECT(network_send,send),XMP_REDIRECT(network_recv,recv)
};
}
