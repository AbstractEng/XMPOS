using System;
using System.Linq;
using System.Text;
using System.Security.Cryptography;
using System.Diagnostics;
using System.IO;

// Policy and console-free startup tests. No WMI, registry writes, elevation or
// USB access: the real helper receives an unsupported action and must refuse it.
class WindowsUsbCompatibilityTests {
  static string Hash(string s) {using(var h=SHA256.Create())return BitConverter.ToString(h.ComputeHash(Encoding.UTF8.GetBytes(s))).Replace("-","").ToLowerInvariant();}
  static void Check(bool value,string message) {if(!value)throw new Exception(message);}
  static void Refuses(Action action) {try {action();}catch{return;}throw new Exception("Expected refusal");}
  static int Main(string[] args) {
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
    var fingerprint=Hash("synthetic snapshot");
    var start=WindowsHost.RepairStartInfo(pin,fingerprint);
    Check(start.UseShellExecute&&start.Verb=="runas","elevation must use the Windows shell runas verb");
    Check(!start.CreateNoWindow&&start.WindowStyle==ProcessWindowStyle.Normal,"elevated helper must not inherit hidden-window policy");
    Check(!start.RedirectStandardInput&&!start.RedirectStandardOutput&&!start.RedirectStandardError,"shell elevation must not redirect streams");
    Check(start.FileName==System.Reflection.Assembly.GetExecutingAssembly().Location&&start.WorkingDirectory==Path.GetDirectoryName(start.FileName),"fixed helper executable and working directory");
    Check(start.Arguments=="winusb-apply "+pin+" "+fingerprint,"only the fixed apply action and hex preview cross UAC");
    Refuses(()=>WindowsHost.RepairStartInfo(pin+" extra-command",fingerprint));
    Refuses(()=>WindowsHost.RepairStartInfo(pin,"not-a-fingerprint"));
    Check(WindowsHost.ElevationFailure(1223).Code=="XMP_UAC_CANCELLED","cancelled approval identified");
    Check(WindowsHost.ElevationFailure(5).Code=="XMP_UAC_DENIED","denied elevation is not cancellation");
    Check(WindowsHost.ElevationFailure(2).Code=="XMP_UAC_LAUNCH_FAILED","launch failure is not cancellation");
    Check(WindowsHost.ElevatedExitFailure(31).Code=="XMP_USB_DEVICE_CHANGED","elevated device recheck failure retained");
    Check(WindowsHost.ElevatedExitFailure(32).Code=="XMP_USB_SNAPSHOT_CHANGED","elevated registry recheck failure retained");
    Check(WindowsHost.ElevatedExitFailure(33).Code=="XMP_USB_REGISTRY_DENIED","elevated registry denial retained");
    Check(WindowsHost.ElevatedExitFailure(1).Code=="XMP_UAC_CHILD_FAILED","child failure is not cancellation");
    if(args.Length==1) {
      var info=new ProcessStartInfo(Path.GetFullPath(args[0]),"unsupported-startup-test") {
        UseShellExecute=false,CreateNoWindow=true,WindowStyle=ProcessWindowStyle.Hidden,
        RedirectStandardOutput=true,RedirectStandardError=true,
        StandardOutputEncoding=new UTF8Encoding(false),StandardErrorEncoding=new UTF8Encoding(false)
      };
      using(var process=Process.Start(info)) {
        var outRead=process.StandardOutput.ReadToEndAsync();var errRead=process.StandardError.ReadToEndAsync();
        if(!process.WaitForExit(15000)) {process.Kill();throw new Exception("Console-free helper must exit promptly");}
        var stdout=outRead.Result;var stderr=errRead.Result;
        Check(process.ExitCode==1&&stdout.Length==0&&stderr.Trim()=="Unsupported host action","console-free helper reached argument validation instead of crashing at Console.OutputEncoding: "+stderr);
      }
      Console.WriteLine("Console-free native helper startup passed (unsupported action, no device access).");
    } else if(args.Length!=0)throw new Exception("Optional compiled helper path only");
    Console.WriteLine("Windows USB compatibility policy passed (no hardware or registry access).");return 0;
  }
}
