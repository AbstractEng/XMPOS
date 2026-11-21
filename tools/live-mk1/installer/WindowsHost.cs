using System;
using System.IO;
using System.Text;
using System.Linq;
using System.Collections.Generic;
using System.Management;
using System.Windows.Forms;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;

class WindowsHost {
  [DllImport("wintrust.dll", ExactSpelling=true, SetLastError=false)] static extern uint WinVerifyTrust(IntPtr hwnd, [MarshalAs(UnmanagedType.LPStruct)] Guid action, IntPtr data);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct TrustFile { public uint size; [MarshalAs(UnmanagedType.LPWStr)] public string path; public IntPtr handle; public IntPtr subject; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct TrustData { public uint size; public IntPtr policy, client; public uint ui, revocation, choice; public IntPtr file; public uint state; public IntPtr stateData; [MarshalAs(UnmanagedType.LPWStr)] public string url; public uint flags, context; public IntPtr signatureSettings; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool SetVolumeLabel(string root, string label);
  [DllImport("cfgmgr32.dll", CharSet=CharSet.Unicode)] static extern uint CM_Locate_DevNodeW(out uint node, string id, uint flags);
  [DllImport("cfgmgr32.dll")] static extern uint CM_Get_Parent(out uint parent, uint node, uint flags);
  [DllImport("cfgmgr32.dll", CharSet=CharSet.Unicode)] static extern uint CM_Get_Device_IDW(uint node, StringBuilder id, uint size, uint flags);
  static int UsbVendor(string pnp) {
    uint node;if(CM_Locate_DevNodeW(out node,pnp,0)!=0)return 0;int vendor=0;
    for(int depth=0;depth<16;depth++) {
      var b=new StringBuilder(1024);if(CM_Get_Device_IDW(node,b,1024,0)!=0)return 0;
      var m=System.Text.RegularExpressions.Regex.Match(b.ToString(),@"^USB\\VID_([0-9A-F]{4})&PID_([0-9A-F]{4})",System.Text.RegularExpressions.RegexOptions.IgnoreCase);
      if(m.Success){int found=Convert.ToInt32(m.Groups[1].Value,16);if(found==0x09e8)return 0;if(vendor==0)vendor=found;}
      uint parent;if(CM_Get_Parent(out parent,node,0)!=0)break;node=parent;
    } return vendor;
  }
  static string Text(object o) { return o == null ? "" : Convert.ToString(o); }
  static string Hash(string s) { using(var h=SHA256.Create()) return BitConverter.ToString(h.ComputeHash(Encoding.UTF8.GetBytes(s))).Replace("-","").ToLowerInvariant(); }
  static object Signature(string path) {
    var file=new TrustFile {size=(uint)Marshal.SizeOf(typeof(TrustFile)),path=Path.GetFullPath(path)};
    var fp=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(TrustFile))); Marshal.StructureToPtr(file,fp,false);
    var data=new TrustData {size=(uint)Marshal.SizeOf(typeof(TrustData)),ui=2,choice=1,file=fp,flags=0x1000};
    var dp=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(TrustData))); Marshal.StructureToPtr(data,dp,false);
    try { var code=WinVerifyTrust(new IntPtr(-1),new Guid("00AAC56B-CD44-11d0-8CC2-00C04FC295EE"),dp); if(code!=0) throw new Exception("The updater Authenticode signature did not verify ("+code+")."); var cert=new X509Certificate2(X509Certificate.CreateFromSignedFile(path)); if(cert.Subject.IndexOf("inMusic",StringComparison.OrdinalIgnoreCase)<0) throw new Exception("The updater is not signed by inMusic."); return new {valid=true,subject=cert.Subject,thumbprint=cert.Thumbprint}; }
    finally {Marshal.DestroyStructure(fp,typeof(TrustFile));Marshal.FreeHGlobal(fp);Marshal.DestroyStructure(dp,typeof(TrustData));Marshal.FreeHGlobal(dp);}
  }
  static List<object> Volumes(string selected=null) {
    var result=new List<object>();
    using(var q=new ManagementObjectSearcher("SELECT * FROM Win32_LogicalDisk WHERE DriveType=2")) foreach(ManagementObject d in q.Get()) {
      var letter=Text(d["DeviceID"]); if(selected!=null&&!String.Equals(selected.TrimEnd('\\'),letter,StringComparison.OrdinalIgnoreCase)) continue;
      foreach(ManagementObject p in d.GetRelated("Win32_DiskPartition")) foreach(ManagementObject disk in p.GetRelated("Win32_DiskDrive")) {
        var model=Text(disk["Model"]);var pnp=Text(disk["PNPDeviceID"]);if(!pnp.StartsWith("USBSTOR\\",StringComparison.OrdinalIgnoreCase)||new[]{"force","ada2","akai","inmusic"}.Any(s=>(model+" "+pnp).IndexOf(s,StringComparison.OrdinalIgnoreCase)>=0)) continue;
        var fs=Text(d["FileSystem"]);if(!String.Equals(fs,"FAT32",StringComparison.OrdinalIgnoreCase)) continue;
        int vendor=UsbVendor(pnp);if(vendor==0)continue;
        result.Add(new {mountPoint=letter+"\\",filesystem="fat32",external=true,removable=true,bus="USB",usbVendorId=vendor,model=model,label=Text(d["VolumeName"]),deviceId=Text(disk["DeviceID"]),deviceKey=Hash(pnp+"|"+Text(d["VolumeSerialNumber"])),freeBytes=Convert.ToInt64(d["FreeSpace"]),capacityBytes=Convert.ToInt64(d["Size"])});
      }
    } return result;
  }
  [STAThread] static int Main(string[] args) {
    Console.OutputEncoding=new UTF8Encoding(false); var json=new JavaScriptSerializer();
    try {
      if(args.Length<1)throw new Exception("A fixed host action is required.");object result=null;
      switch(args[0]) {
        case "pick-updater": using(var d=new OpenFileDialog {Title="Choose the official MPC (Gen 1) 3.10.1 Updater.exe",Filter="Official updater (*.exe)|*.exe",CheckFileExists=true}) result=d.ShowDialog()==DialogResult.OK?d.FileName:null;break;
        case "pick-loader": using(var d=new FolderBrowserDialog {Description="Choose the verified XMP loader folder",ShowNewFolderButton=false}) result=d.ShowDialog()==DialogResult.OK?d.SelectedPath:null;break;
        case "verify-updater": if(args.Length!=2)throw new Exception("Updater path required");result=Signature(args[1]);break;
        case "list-usb": result=Volumes();break;
        case "inspect-usb": if(args.Length!=2||!System.Text.RegularExpressions.Regex.IsMatch(args[1],@"^[A-Za-z]:\\$"))throw new Exception("USB drive root required");var v=Volumes(args[1]);if(v.Count!=1)throw new Exception("The selected removable FAT32 USB key is unavailable");result=v[0];break;
        case "label-usb": if(args.Length!=2||Volumes(args[1]).Count!=1)throw new Exception("Selected USB key required");if(!SetVolumeLabel(args[1],"XMP"))throw new Exception("Could not label the selected USB key XMP");result=true;break;
        case "open-usb": if(args.Length!=2||Volumes(args[1]).Count!=1)throw new Exception("Selected USB key required");System.Diagnostics.Process.Start("explorer.exe",args[1]);result=true;break;
        default:throw new Exception("Unsupported host action");
      }
      Console.WriteLine(json.Serialize(result));return 0;
    } catch(Exception e) {Console.Error.WriteLine(e.Message);return 1;}
  }
}
