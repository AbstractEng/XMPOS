using System;
using System.Linq;
using System.Text;
using System.Security.Cryptography;

// Pure policy tests. No WMI, registry reads/writes, elevation or USB access.
class WindowsUsbCompatibilityTests {
  static string Hash(string s) {using(var h=SHA256.Create())return BitConverter.ToString(h.ComputeHash(Encoding.UTF8.GetBytes(s))).Replace("-","").ToLowerInvariant();}
  static void Check(bool value,string message) {if(!value)throw new Exception(message);}
  static void Refuses(Action action) {try {action();}catch{return;}throw new Exception("Expected refusal");}
  static int Main() {
    var android="{f72fe0d4-cbcb-407d-8814-9ed673d0dd6b}";
    var other="{12345678-1234-1234-1234-123456789abc}";
    Check(WindowsHost.AddFastbootGuid(new string[0]).SequenceEqual(new[]{android}),"missing GUID added");
    Check(WindowsHost.AddFastbootGuid(new[]{other}).SequenceEqual(new[]{other,android}),"other GUID preserved");
    Check(WindowsHost.AddFastbootGuid(new[]{android.ToUpperInvariant()}).Length==1,"case-insensitive idempotency");
    Refuses(()=>WindowsHost.AddFastbootGuid(new[]{"not a GUID"}));
    Refuses(()=>WindowsHost.AddFastbootGuid(Enumerable.Repeat(other,33).ToArray()));
    var pin=Hash("123456789abcdef0");
    Check(WindowsHost.PinnedSerial(@"USB\VID_09E8&PID_403B\123456789ABCDEF0",pin),"Windows serial casing");
    Check(!WindowsHost.PinnedSerial(@"USB\VID_09E8&PID_403B\0000000000000001",pin),"different Live refused");
    foreach(var id in new[]{@"USB\VID_09E8&PID_403A\123456789abcdef0",@"USB\VID_09E8&PID_003B\123456789abcdef0",@"USB\VID_1234&PID_403B\123456789abcdef0",@"USB\VID_09E8&PID_403B&MI_00\123456789abcdef0"})Check(!WindowsHost.PinnedSerial(id,pin),"other device or interface refused");
    Refuses(()=>WindowsHost.PinnedSerial(@"USB\VID_09E8&PID_403B\123456789abcdef0","not-a-unit-pin"));
    Console.WriteLine("Windows USB compatibility policy passed (no hardware or registry access).");return 0;
  }
}
