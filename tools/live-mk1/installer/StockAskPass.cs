using System;
using System.Text;
using System.Windows.Forms;
class StockAskPass {
  [STAThread] static int Main() {
    Application.EnableVisualStyles();
    using(var form=new Form {Text="MPC Live Mk1 Developer Mode",Width=510,Height=245,FormBorderStyle=FormBorderStyle.FixedDialog,MaximizeBox=false,MinimizeBox=false,StartPosition=FormStartPosition.CenterScreen,TopMost=true}) {
      var target=Environment.GetEnvironmentVariable("XMP_STOCK_TARGET")??"your Live";
      var label=new Label {Left=18,Top=16,Width=455,Height=72,Text="Enter the SSH password for your Live at "+target+". This reads stock 3.10.1 identity and rootfs capacity only. The password goes directly to SSH and is not saved."};
      var input=new TextBox {Left=18,Top=92,Width=455,UseSystemPasswordChar=true};
      var ok=new Button {Left=260,Top=135,Width=115,Text="Verify Live",DialogResult=DialogResult.OK};
      var cancel=new Button {Left=385,Top=135,Width=88,Text="Cancel",DialogResult=DialogResult.Cancel};
      form.Controls.AddRange(new Control[]{label,input,ok,cancel});form.AcceptButton=ok;form.CancelButton=cancel;
      if(form.ShowDialog()!=DialogResult.OK)return 1;
      var bytes=Encoding.UTF8.GetBytes(input.Text+"\n");input.Clear();
      using(var output=Console.OpenStandardOutput())output.Write(bytes,0,bytes.Length);
      Array.Clear(bytes,0,bytes.Length);return 0;
    }
  }
}
