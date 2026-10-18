using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using System.Windows.Forms;
using System.Reflection;
[assembly: AssemblyTitle("Daymark Setup")]
[assembly: AssemblyVersion("0.1.3.0")]
namespace DaymarkInstaller {
 static class Program {
  internal static string TestTarget;
  [STAThread] static int Main(string[] args) {
   Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
   foreach(string arg in args) if(arg.StartsWith("--verify-install=")) TestTarget=Path.GetFullPath(arg.Substring(17));
   using(var form=new Setup()) { Application.Run(form); return form.Result; }
  }
 }
 sealed class Setup : Form {
  readonly Label label=new Label(); readonly Button install=new Button(); readonly CheckBox launch=new CheckBox(); readonly ProgressBar progress=new ProgressBar();
  bool busy; public int Result {get;private set;}
  public Setup() {
   Text="安装 Daymark"; ClientSize=new Size(490,290); FormBorderStyle=FormBorderStyle.FixedDialog; MaximizeBox=false; StartPosition=FormStartPosition.CenterScreen;
   Font=new Font("Microsoft YaHei UI",10F); BackColor=Color.White; Icon=Icon.ExtractAssociatedIcon(Application.ExecutablePath);
   Controls.Add(new Label {Text="Daymark 0.1.3",AutoSize=true,Location=new Point(25,22),Font=new Font(Font.FontFamily,19,FontStyle.Bold)});
   label.SetBounds(25,76,440,88); label.Text="将安装到当前用户目录，并创建桌面快捷方式。\n已包含 Python、Node 和聊天读取组件，无需额外配置。\n账号和事项数据继续保存在原数据目录。";
   progress.SetBounds(25,176,440,17); progress.Style=ProgressBarStyle.Marquee; progress.Visible=false;
   launch.SetBounds(25,207,250,28); launch.Text="完成后打开 Daymark"; launch.Checked=true;
   install.SetBounds(326,236,139,34); install.Text="安装"; install.Click+=async delegate { await Install(); };
   Controls.AddRange(new Control[] {label,progress,launch,install});
   var license=new LinkLabel {Text="许可证说明",AutoSize=true,Location=new Point(25,245)};
   license.LinkClicked+=delegate { MessageBox.Show(this,"Daymark 自有代码采用 MIT 许可。QQ 组件 NapCatQQ 采用独立的非商用许可；MIT 不改变其条款。完整许可证和版权均随程序保留在安装目录。\n\n此安装包仅安装到当前用户，不附带官方微信或 QQ。","许可证说明"); }; Controls.Add(license);
   FormClosing+=delegate(object sender,FormClosingEventArgs e) { if(busy) e.Cancel=true; };
   if(Program.TestTarget!=null) Shown+=async delegate { await Install(); };
  }
  async Task Install() {
   busy=true; install.Enabled=false; progress.Visible=true; label.Text="正在校验并解压完整程序，请稍候…";
   try {
    string target=await Task.Run(()=>Extract());
    if(Program.TestTarget==null) {
     Shortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),"Daymark.lnk"),target);
     string menu=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs),"Daymark"); Directory.CreateDirectory(menu); Shortcut(Path.Combine(menu,"Daymark.lnk"),target);
    }
    else Shortcut(Path.Combine(Program.TestTarget,"Daymark-test.lnk"),target);
    if(Program.TestTarget==null && launch.Checked) Process.Start(new ProcessStartInfo(Path.Combine(target,"Daymark.exe")) {UseShellExecute=true});
    Result=0; busy=false; Close();
   } catch(Exception e) {
    busy=false; Result=1; label.Text="安装未完成："+e.Message; progress.Visible=false; install.Enabled=true; install.Text="重试";
    if(Program.TestTarget!=null) { Directory.CreateDirectory(Program.TestTarget); File.WriteAllText(Path.Combine(Program.TestTarget,"install-error.txt"),e.ToString()); Close(); }
   }
  }
  static string Extract() {
   if(!Environment.Is64BitOperatingSystem) throw new Exception("需要 Windows 10/11 64 位系统。");
   string parent=Program.TestTarget ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Programs");
   Directory.CreateDirectory(parent); parent=Path.GetFullPath(parent);
   string target=Path.Combine(parent,"Daymark");
   foreach(var process in Process.GetProcessesByName("Daymark")) {
    using(process) { try { if(process.MainModule.FileName.StartsWith(target+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("请先从托盘退出正在运行的 Daymark，再安装新版。"); } catch(System.ComponentModel.Win32Exception) {} }
   }
   string stage=Path.Combine(parent,"Daymark.install-"+Guid.NewGuid().ToString("N")); Directory.CreateDirectory(stage);
   string zip=Path.Combine(stage,"payload.zip"), unpack=Path.Combine(stage,"app"); Directory.CreateDirectory(unpack);
   using(var source=File.OpenRead(Application.ExecutablePath)) {
    if(source.Length<56) throw new Exception("安装文件不完整。");
    source.Position=source.Length-56; var reader=new BinaryReader(source); long length=reader.ReadInt64(); byte[] expected=reader.ReadBytes(32); string magic=Encoding.ASCII.GetString(reader.ReadBytes(16));
    if(magic!="DAYMARK-SETUP-V1" || length<=0 || length>source.Length-56) throw new Exception("安装包尾部校验失败，请重新下载。");
    source.Position=source.Length-56-length;
    using(var output=File.Create(zip)) { byte[] buffer=new byte[1024*1024]; long left=length; while(left>0) { int count=source.Read(buffer,0,(int)Math.Min(buffer.Length,left)); if(count==0) throw new Exception("安装包已损坏。"); output.Write(buffer,0,count); left-=count; } }
    using(var input=File.OpenRead(zip)) using(var sha=SHA256.Create()) if(BitConverter.ToString(sha.ComputeHash(input))!=BitConverter.ToString(expected)) throw new Exception("安装包内容损坏，请重新下载。");
   }
   string prefix=Path.GetFullPath(unpack)+Path.DirectorySeparatorChar;
   using(var archive=ZipFile.OpenRead(zip)) {
    string top=null;
    foreach(var entry in archive.Entries) {
     string path=entry.FullName.Replace('\\','/'); int slash=path.IndexOf('/'); if(slash<1) throw new Exception("安装包目录异常。");
     if(top==null) top=path.Substring(0,slash); else if(top!=path.Substring(0,slash)) throw new Exception("安装包根目录不唯一。");
     path=path.Substring(slash+1); if(path.Length==0 || path.EndsWith("/")) continue;
     string destination=Path.GetFullPath(Path.Combine(unpack,path));
     if(!destination.StartsWith(prefix,StringComparison.OrdinalIgnoreCase) || path.Contains(":")) throw new Exception("安装包路径无效。");
     Directory.CreateDirectory(Path.GetDirectoryName(destination)); entry.ExtractToFile(destination,false);
    }
   }
   if(!File.Exists(Path.Combine(unpack,"Daymark.exe")) || !File.Exists(Path.Combine(unpack,"runtime-manifest.json"))) throw new Exception("安装包缺少主要文件。");
   string backup=null;
   if(Directory.Exists(target)) { backup=Path.Combine(parent,"Daymark.previous-"+DateTime.Now.ToString("yyyyMMdd-HHmmss")+"-"+Guid.NewGuid().ToString("N").Substring(0,6)); Directory.Move(target,backup); }
   try { Directory.Move(unpack,target); } catch { if(backup!=null && !Directory.Exists(target)) Directory.Move(backup,target); throw; }
   // Only this installer-created temporary payload is removed. Earlier installs
   // remain as backups so custom user files are not silently discarded.
   File.Delete(zip); Directory.Delete(stage,false);
   return target;
  }
  static void Shortcut(string path,string target) {
   Type type=Type.GetTypeFromProgID("WScript.Shell"); object shell=Activator.CreateInstance(type);
   object link=type.InvokeMember("CreateShortcut",BindingFlags.InvokeMethod,null,shell,new object[] {path}); Type shortcut=link.GetType();
   shortcut.InvokeMember("TargetPath",BindingFlags.SetProperty,null,link,new object[] {Path.Combine(target,"Daymark.exe")});
   shortcut.InvokeMember("WorkingDirectory",BindingFlags.SetProperty,null,link,new object[] {target});
   shortcut.InvokeMember("Description",BindingFlags.SetProperty,null,link,new object[] {"Daymark 本地学生事项工具"});
   shortcut.InvokeMember("Save",BindingFlags.InvokeMethod,null,link,null);
   System.Runtime.InteropServices.Marshal.FinalReleaseComObject(link); System.Runtime.InteropServices.Marshal.FinalReleaseComObject(shell);
  }
 }
}
