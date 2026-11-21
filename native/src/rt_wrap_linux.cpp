#include "xmp/rt_audit.hpp"
#include <cstdlib>
#include <cstdio>
#include <cstdarg>
#include <fcntl.h>
#include <new>
#include <pthread.h>
#include <sys/socket.h>
#include <unistd.h>
extern "C" {
void* __real_malloc(std::size_t);void* __real_calloc(std::size_t,std::size_t);void* __real_realloc(void*,std::size_t);void __real_free(void*);
int __real_pthread_mutex_lock(pthread_mutex_t*);int __real_open(const char*,int,...);ssize_t __real_read(int,void*,std::size_t);ssize_t __real_write(int,const void*,std::size_t);std::size_t __real_fwrite(const void*,std::size_t,std::size_t,FILE*);int __real_socket(int,int,int);ssize_t __real_send(int,const void*,std::size_t,int);ssize_t __real_recv(int,void*,std::size_t,int);
void* __wrap_malloc(std::size_t n){xmp::audit::allocation();return __real_malloc(n);}void* __wrap_calloc(std::size_t n,std::size_t s){xmp::audit::allocation();return __real_calloc(n,s);}void* __wrap_realloc(void* p,std::size_t n){xmp::audit::allocation();return __real_realloc(p,n);}void __wrap_free(void* p){xmp::audit::release();__real_free(p);}
int __wrap_pthread_mutex_lock(pthread_mutex_t* p){xmp::audit::lock();return __real_pthread_mutex_lock(p);}int __wrap_open(const char* p,int flags,...){xmp::audit::file();mode_t mode=0;if(flags&O_CREAT){va_list args;va_start(args,flags);mode=va_arg(args,int);va_end(args);}return __real_open(p,flags,mode);}
ssize_t __wrap_read(int fd,void* p,std::size_t n){xmp::audit::file();return __real_read(fd,p,n);}ssize_t __wrap_write(int fd,const void* p,std::size_t n){xmp::audit::file();return __real_write(fd,p,n);}std::size_t __wrap_fwrite(const void* p,std::size_t s,std::size_t n,FILE* f){xmp::audit::file();return __real_fwrite(p,s,n,f);}
int __wrap_socket(int domain,int type,int protocol){xmp::audit::network();return __real_socket(domain,type,protocol);}ssize_t __wrap_send(int fd,const void* p,std::size_t n,int flags){xmp::audit::network();return __real_send(fd,p,n,flags);}ssize_t __wrap_recv(int fd,void* p,std::size_t n,int flags){xmp::audit::network();return __real_recv(fd,p,n,flags);}
}
void* operator new(std::size_t n){if(auto* p=__wrap_malloc(n?n:1))return p;throw std::bad_alloc();}
void* operator new[](std::size_t n){return ::operator new(n);}void operator delete(void* p) noexcept {__wrap_free(p);}void operator delete[](void* p) noexcept {__wrap_free(p);}void operator delete(void* p,std::size_t) noexcept {__wrap_free(p);}void operator delete[](void* p,std::size_t) noexcept {__wrap_free(p);}
