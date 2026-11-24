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
  // Read OS PnP metadata only. Never open a USB device or change its driver.
  // Exclude instance paths (which contain serials) from the returned report.
  static string[] InterfaceGuids(string id) {
    try {
      var values=new List<string>();
      using(var key=Microsoft.Win32.Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Enum\"+id)) {
        if(key==null)return null;
        using(var parameters=key.OpenSubKey("Device Parameters")) {
          foreach(var current in new[]{key,parameters}) {
            if(current==null)continue;
            foreach(var valueName in new[]{"DeviceInterfaceGUIDs","DeviceInterfaceGUID"}) {
            var raw=current.GetValue(valueName);
            var entries=raw as string[] ?? (raw is string ? new[]{(string)raw} : new string[0]);
            foreach(var entry in entries) {
              Guid guid;if(Guid.TryParse(entry,out guid)&&!values.Contains(guid.ToString("B")))values.Add(guid.ToString("B"));
              if(values.Count>32)throw new Exception("Too many USB interface GUIDs");
            }
            }
          }
        }
      }
      return values.ToArray();
    } catch(System.Security.SecurityException) {return null;}
      catch(UnauthorizedAccessException) {return null;}
  }
  static List<object> UpdateModeInfo() {
    var result=new List<object>();
    var options=new System.Management.EnumerationOptions {Timeout=TimeSpan.FromSeconds(15),ReturnImmediately=false};
    using(var q=new ManagementObjectSearcher("root\\CIMV2","SELECT Name,PNPDeviceID,Service,ConfigManagerErrorCode FROM Win32_PnPEntity WHERE Present=TRUE",options)) foreach(ManagementObject d in q.Get()) {
      var name=Text(d["Name"]);var id=Text(d["PNPDeviceID"]);
      var match=System.Text.RegularExpressions.Regex.Match(id,@"^USB\\(VID_[0-9A-F]{4}&PID_[0-9A-F]{4})",System.Text.RegularExpressions.RegexOptions.IgnoreCase);
      if(!match.Success||!System.Text.RegularExpressions.Regex.IsMatch(name,@"mpc\s*live|force|ada2",System.Text.RegularExpressions.RegexOptions.IgnoreCase))continue;
      if(result.Count>=32)throw new Exception("Too many matching USB entries");
      result.Add(new {name=name,usbId=match.Groups[1].Value,service=Text(d["Service"]),problemCode=Convert.ToInt32(d["ConfigManagerErrorCode"]),interfaceGuids=InterfaceGuids(id)});
    }
    return result;
  }
  const string AndroidGuid="{f72fe0d4-cbcb-407d-8814-9ed673d0dd6b}";
  // This is a Windows registry repair, never a USB transport. Only the existing
  // flash tool can communicate with the bootloader after the owner reconnects.
  internal static string[] AddFastbootGuid(string[] before) {
    if(before==null||before.Length>32)throw new Exception("Bounded GUID list required");
    foreach(var value in before) {Guid guid;if(!Guid.TryParse(value,out guid))throw new Exception("Invalid existing USB interface GUID; refusing repair");}
    if(before.Any(v=>String.Equals(v,AndroidGuid,StringComparison.OrdinalIgnoreCase)))return before;
    if(before.Length==32)throw new Exception("USB interface GUID list is full");
    return before.Concat(new[]{AndroidGuid}).ToArray();
  }
  internal static bool PinnedSerial(string id,string hashes) {
    var pins=hashes.Split(',');
    if(pins.Length<1||pins.Length>2||pins.Any(p=>!System.Text.RegularExpressions.Regex.IsMatch(p,"^[a-f0-9]{64}$")))throw new Exception("Verified unit hashes required");
    var m=System.Text.RegularExpressions.Regex.Match(id,@"^USB\\VID_09E8&PID_403B\\([A-Za-z0-9._:-]{1,128})$",System.Text.RegularExpressions.RegexOptions.IgnoreCase);
    if(!m.Success)return false;
    var serial=m.Groups[1].Value;
    return new[]{serial,serial.ToLowerInvariant(),serial.ToUpperInvariant()}.Any(v=>pins.Contains(Hash(v)));
  }
  static string RepairDevice(string hashes) {
    // No opening the device, no broad driver filters and no friendly-name-only selection.
    var candidates=new List<string>();int otherLive=0;
    var options=new System.Management.EnumerationOptions {Timeout=TimeSpan.FromSeconds(15),ReturnImmediately=false};
    using(var q=new ManagementObjectSearcher("root\\CIMV2","SELECT Name,PNPDeviceID,Service,ConfigManagerErrorCode FROM Win32_PnPEntity WHERE Present=TRUE",options))foreach(ManagementObject d in q.Get()) {
      var id=Text(d["PNPDeviceID"]);var name=Text(d["Name"]);
      if(!id.StartsWith("USB\\",StringComparison.OrdinalIgnoreCase))continue;
      if(System.Text.RegularExpressions.Regex.IsMatch(name,"force|ada2",System.Text.RegularExpressions.RegexOptions.IgnoreCase))throw new Exception("Protected instrument connected; disconnect it before repair");
      if(!id.StartsWith("USB\\VID_09E8",StringComparison.OrdinalIgnoreCase))continue;
      if(id.StartsWith("USB\\VID_09E8&PID_503B\\",StringComparison.OrdinalIgnoreCase))continue; // Host hub, never modified.
      otherLive++;
      if(PinnedSerial(id,hashes)&&String.Equals(Text(d["Service"]),"WINUSB",StringComparison.OrdinalIgnoreCase)&&Convert.ToInt32(d["ConfigManagerErrorCode"])==0&&System.Text.RegularExpressions.Regex.IsMatch(name,@"^MPC\s*Live$",System.Text.RegularExpressions.RegexOptions.IgnoreCase))candidates.Add(id);
    }
    if(candidates.Count!=1||otherLive!=1)throw new Exception("Connect only the verified Live Mk1 in update mode with a healthy WinUSB driver");
    return candidates[0];
  }
  static object GuidValue(Microsoft.Win32.RegistryKey key,string name) {
    var raw=key.GetValue(name,null,Microsoft.Win32.RegistryValueOptions.DoNotExpandEnvironmentNames);
    if(raw==null)return new {kind="absent",values=new string[0]};
    var kind=key.GetValueKind(name);var values=raw as string[] ?? (raw is string?new[]{(string)raw}:null);
    if(values==null||(kind!=Microsoft.Win32.RegistryValueKind.MultiString&&kind!=Microsoft.Win32.RegistryValueKind.String))throw new Exception("Unsupported existing USB interface registry value");
    AddFastbootGuid(values); // Validates, but never writes during a preview.
    return new {kind=kind.ToString(),values=values};
  }
  static string RepairSnapshot(string id) {
    using(var key=Microsoft.Win32.Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Enum\"+id+@"\Device Parameters")) {
      if(key==null)throw new Exception("WinUSB Device Parameters key missing");
      return new JavaScriptSerializer().Serialize(new {deviceKey=Hash(id),plural=GuidValue(key,"DeviceInterfaceGUIDs"),singular=GuidValue(key,"DeviceInterfaceGUID")});
    }
  }
  static object RepairPlan(string hashes) {
    var id=RepairDevice(hashes);var snapshot=RepairSnapshot(id);
    var guids=InterfaceGuids(id);if(guids==null)throw new Exception("Cannot read USB interface registration");
    return new {fingerprint=Hash(snapshot),before=new JavaScriptSerializer().DeserializeObject(snapshot),needsRepair=!guids.Any(v=>String.Equals(v,AndroidGuid,StringComparison.OrdinalIgnoreCase))};
  }
  static object RepairWinUsb(string hashes,string fingerprint,bool elevated) {
    if(!System.Text.RegularExpressions.Regex.IsMatch(fingerprint,"^[a-f0-9]{64}$"))throw new Exception("Repair preview required");
    var id=RepairDevice(hashes);var snapshot=RepairSnapshot(id);
    if(Hash(snapshot)!=fingerprint)throw new Exception("USB registration changed since preview; inspect it again");
    if(!elevated) {
      // Caller has already saved a private backup. Only fixed hex arguments cross UAC.
      var start=new System.Diagnostics.ProcessStartInfo(System.Reflection.Assembly.GetExecutingAssembly().Location,"winusb-apply "+hashes+" "+fingerprint) {UseShellExecute=true,Verb="runas"};
      using(var process=System.Diagnostics.Process.Start(start)) {process.WaitForExit();if(process.ExitCode!=0)throw new Exception("Windows USB repair was cancelled or failed; no automatic retry");}
      return RepairPlan(hashes);
    }
    using(var identity=System.Security.Principal.WindowsIdentity.GetCurrent())if(!new System.Security.Principal.WindowsPrincipal(identity).IsInRole(System.Security.Principal.WindowsBuiltInRole.Administrator))throw new Exception("Windows administrator approval required");
    using(var key=Microsoft.Win32.Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Enum\"+id+@"\Device Parameters",true)) {
      if(key==null)throw new Exception("Cannot open this Live's WinUSB registration");
      if(Hash(RepairSnapshot(id))!=fingerprint)throw new Exception("USB registration changed during approval");
      var raw=key.GetValue("DeviceInterfaceGUIDs");
      var previous=raw as string[] ?? (raw is string?new[]{(string)raw}:new string[0]);
      var next=AddFastbootGuid(previous);
      key.SetValue("DeviceInterfaceGUIDs",next,Microsoft.Win32.RegistryValueKind.MultiString);key.Flush();
    }
    return RepairPlan(hashes);
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
        case "update-mode-info": if(args.Length!=1)throw new Exception("No device or command arguments allowed");result=UpdateModeInfo();break;
        case "winusb-plan": if(args.Length!=2)throw new Exception("Verified unit hashes required");result=RepairPlan(args[1]);break;
        case "winusb-repair": if(args.Length!=3)throw new Exception("Verified repair preview required");result=RepairWinUsb(args[1],args[2],false);break;
        case "winusb-apply": if(args.Length!=3)throw new Exception("Verified repair preview required");result=RepairWinUsb(args[1],args[2],true);break;
        case "inspect-usb": if(args.Length!=2||!System.Text.RegularExpressions.Regex.IsMatch(args[1],@"^[A-Za-z]:\\$"))throw new Exception("USB drive root required");var v=Volumes(args[1]);if(v.Count!=1)throw new Exception("The selected removable FAT32 USB key is unavailable");result=v[0];break;
        case "label-usb": if(args.Length!=2||Volumes(args[1]).Count!=1)throw new Exception("Selected USB key required");if(!SetVolumeLabel(args[1],"XMP"))throw new Exception("Could not label the selected USB key XMP");result=true;break;
        case "open-usb": if(args.Length!=2||Volumes(args[1]).Count!=1)throw new Exception("Selected USB key required");System.Diagnostics.Process.Start("explorer.exe",args[1]);result=true;break;
        default:throw new Exception("Unsupported host action");
      }
      Console.WriteLine(json.Serialize(result));return 0;
    } catch(Exception e) {Console.Error.WriteLine(e.Message);return 1;}
  }
}
