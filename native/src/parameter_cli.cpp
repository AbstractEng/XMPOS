#include "xmp/parameter.hpp"
#include <iomanip>
#include <iostream>
#include <stdexcept>
#include <string>
static double number(const char* text){std::size_t used=0;const auto value=std::stod(text,&used);if(used!=std::string(text).size())throw std::runtime_error("Invalid number");return value;}
int main(int argc,char** argv){
  try{
    if(argc==7&&std::string(argv[1])=="--smooth"){
      double output=0;if(!xmp::smooth_parameter(number(argv[2]),number(argv[3]),number(argv[4]),number(argv[5]),number(argv[6]),output))throw std::runtime_error("Rejected invalid smoothing before DSP");
      std::cout<<std::setprecision(17)<<output<<'\n';return 0;
    }
    if(argc!=6)throw std::runtime_error("Expected base automation-or-none lock-or-none macro lfo");
    const bool automation=std::string(argv[2])!="none",lock=std::string(argv[3])!="none";
    double output=0;
    if(!xmp::resolve_parameter(number(argv[1]),automation,automation?number(argv[2]):0,lock,lock?number(argv[3]):0,number(argv[4]),number(argv[5]),output))throw std::runtime_error("Rejected invalid parameter before DSP");
    std::cout<<std::setprecision(17)<<output<<'\n';
  }catch(const std::exception& error){std::cerr<<error.what()<<'\n';return 1;}
}
