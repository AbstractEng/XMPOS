using System;
using System.IO;
using System.Diagnostics;
using System.Windows.Forms;
class WindowsLauncher {
  [STAThread] static int Main(string[] args) {
    try {
      var root=AppDomain.CurrentDomain.BaseDirectory;var res=Path.Combine(root,"resources");
      var p=new ProcessStartInfo {FileName=Path.Combine(res,"node.exe"),Arguments="\""+Path.Combine(res,"server.mjs")+"\" --open",UseShellExecute=false,CreateNoWindow=true,WindowStyle=ProcessWindowStyle.Hidden};
      if(args.Length==1&&args[0]=="--simulate")p.Arguments+=" --simulate";
      else if(args.Length!=0)throw new Exception("Unsupported launcher option");
      Process.Start(p);return 0;
    } catch(Exception e) {MessageBox.Show(e.Message,"XMP OS Installer",MessageBoxButtons.OK,MessageBoxIcon.Error);return 1;}
  }
}
