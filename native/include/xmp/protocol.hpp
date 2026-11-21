#pragma once
#include "xmp/engine.hpp"
#include <cmath>
#include <cstring>
namespace xmp::protocol {
constexpr std::size_t request_bytes=40,response_bytes=176;
inline std::uint64_t get(const std::uint8_t* bytes,std::size_t offset,std::size_t size) noexcept {std::uint64_t value=0;for(std::size_t i=0;i<size;++i)value|=static_cast<std::uint64_t>(bytes[offset+i])<<(i*8);return value;}
inline void put(std::uint8_t* bytes,std::size_t offset,std::size_t size,std::uint64_t value) noexcept {for(std::size_t i=0;i<size;++i)bytes[offset+i]=static_cast<std::uint8_t>(value>>(i*8));}
inline double number(const std::uint8_t* bytes,std::size_t offset) noexcept {const auto bits=get(bytes,offset,8);double value;std::memcpy(&value,&bits,8);return value;}
inline void number(std::uint8_t* bytes,std::size_t offset,double value) noexcept {std::uint64_t bits;std::memcpy(&bits,&value,8);put(bytes,offset,8,bits);}
inline Status decode(const std::uint8_t* bytes,const Snapshot& snapshot,std::uint32_t samples,bool handshake,Command& result) noexcept {
 if(get(bytes,0,4)!=0x34504d58)return Status::invalid;
 if(get(bytes,4,2)!=1)return Status::version;
 const auto op=get(bytes,6,2),payload=get(bytes,12,4);if(op<1||op>12)return Status::unsupported;
 if(payload>16)return Status::invalid;
 if(!handshake&&op!=1)return Status::handshake;
 result={static_cast<Op>(op),get(bytes,8,4),get(bytes,16,8),static_cast<std::uint32_t>(get(bytes,24,4)),static_cast<std::uint32_t>(get(bytes,28,4)),number(bytes,32)};
 if(!std::isfinite(result.value))return Status::invalid;
 if(op==11)return payload==16&&result.timestamp==0&&result.a<=24*1024*1024&&result.b>0&&result.b<=4096&&result.value==0?Status::ok:Status::invalid;
 if(op==1||op==2||op==8)return payload==0&&result.timestamp==0&&result.a==0&&result.b==0&&result.value==0?Status::ok:Status::invalid;
 if(payload!=16)return Status::invalid;
 if(op==12)return result.timestamp%3840==0&&result.timestamp>=snapshot.tick&&result.timestamp<=snapshot.tick+115200&&result.value>=0&&result.value<=0.5&&result.a==1&&result.b==0?Status::ok:Status::invalid;
 if(op==7)return result.timestamp%3840==0&&result.timestamp>=snapshot.tick&&result.timestamp<=snapshot.tick+115200&&result.value>=30&&result.value<=300&&result.a==0&&result.b==0?Status::ok:Status::invalid;
 if(result.timestamp>snapshot.frame+60*kRate||(result.timestamp&&result.timestamp<snapshot.frame+2*kBlock))return Status::invalid;
 if(op==5)return result.a>0&&result.a<=65535&&(result.b&65535)<samples&&(result.b>>16)<8&&result.value>=0&&result.value<=1?Status::ok:Status::invalid;
 if(op==6)return result.a>0&&result.a<=65535&&result.b==0&&result.value==0?Status::ok:Status::invalid;
 if((op==3||op==4||op==9||op==10)&&result.timestamp!=0)return Status::invalid;
 if(op==10)return result.a==kRate&&result.b==kBlock&&result.value==0?Status::ok:Status::invalid;
 return result.a==0&&result.b==0&&result.value==0?Status::ok:Status::invalid;
}
}
