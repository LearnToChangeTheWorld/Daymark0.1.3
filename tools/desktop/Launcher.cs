using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using System.Web.Script.Serialization;
[assembly: System.Reflection.AssemblyTitle("Daymark")]
[assembly: System.Reflection.AssemblyProduct("Daymark")]
[assembly: System.Reflection.AssemblyVersion("0.1.3.0")]
namespace DaymarkDesktop {
 static class Program {
  [STAThread] static int Main(string[] args) {
   Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
   try {
    string data = Environment.GetEnvironmentVariable("STUDENT_INBOX_DATA_DIR");
    if (String.IsNullOrWhiteSpace(data)) data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "StudentInbox");
    data = Path.GetFullPath(data); string name;
    using(var sha = SHA256.Create()) name = "Local\\Daymark-" + BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(data.ToUpperInvariant()))).Replace("-", "").Substring(0,24);
    bool first;
    using(var mutex = new Mutex(true,name,out first)) {
     if(!first) { using(var reopen = EventWaitHandle.OpenExisting(name+"-open")) reopen.Set(); return 0; }
     using(var reopen = new EventWaitHandle(false,EventResetMode.AutoReset,name+"-open"))
     using(var form = new Launcher(AppDomain.CurrentDomain.BaseDirectory,data,reopen,args)) { Application.Run(form); return form.Result; }
    }
   } catch(Exception e) { MessageBox.Show("Daymark 无法启动：\n"+e.Message,"Daymark",MessageBoxButtons.OK,MessageBoxIcon.Error); return 1; }
  }
 }
 sealed class Launcher : Form {
  readonly string root,data; readonly EventWaitHandle reopen; readonly bool noBrowser;
  readonly Label status=new Label(); readonly Button open=new Button(),access=new Button(),quit=new Button();
  readonly NotifyIcon tray=new NotifyIcon(); readonly System.Windows.Forms.Timer timer=new System.Windows.Forms.Timer();
  Process service; string address,screenshot; bool ready,exiting,explicitExit; int autoExit;
  public int Result { get; private set; }
  public Launcher(string root,string data,EventWaitHandle reopen,string[] args) {
   this.root=root; this.data=data; this.reopen=reopen; noBrowser=Array.IndexOf(args,"--no-browser")>=0;
   foreach(string arg in args) if(arg.StartsWith("--exit-after=")) Int32.TryParse(arg.Substring(13),out autoExit);
   foreach(string arg in args) if(arg.StartsWith("--screenshot=")) screenshot=arg.Substring(13);
   Text="Daymark"; ClientSize=new Size(460,230); FormBorderStyle=FormBorderStyle.FixedDialog; MaximizeBox=false;
   StartPosition=FormStartPosition.CenterScreen; Font=new Font("Microsoft YaHei UI",10F); BackColor=Color.White;
   Icon=Icon.ExtractAssociatedIcon(Application.ExecutablePath);
   var title=new Label { Text="Daymark",Location=new Point(24,22),AutoSize=true,Font=new Font(Font.FontFamily,19,FontStyle.Bold) };
   status.SetBounds(24,69,412,66); status.Text="正在检查组件并启动…";
   open.SetBounds(24,148,130,36); open.Text="打开 Daymark"; open.Enabled=false; open.Click+=delegate { OpenBrowser(); };
   access.SetBounds(163,148,130,36); access.Text="查看访问码"; access.Enabled=false;
   access.Click+=delegate { ShowAccessCode(); };
   quit.SetBounds(302,148,130,36); quit.Text="退出程序"; quit.Click+=async delegate { await Stop(); };
   var hint=new Label { Text="关闭此窗口后在托盘继续运行；退出请使用“退出程序”。",Location=new Point(24,199),AutoSize=true,ForeColor=Color.DimGray,Font=new Font(Font.FontFamily,8F) };
   Controls.AddRange(new Control[] {title,status,open,access,quit,hint});
   var menu=new ContextMenuStrip(); menu.Items.Add("打开 Daymark",null,delegate { OpenBrowser(); });
   menu.Items.Add("运行状态 / 访问码",null,delegate { ShowWindow(); }); menu.Items.Add(new ToolStripSeparator());
   menu.Items.Add("退出程序",null,async delegate { await Stop(); });
   tray.Icon=Icon; tray.Text="Daymark · 正在启动"; tray.ContextMenuStrip=menu; tray.Visible=true;
   tray.DoubleClick+=delegate { if(ready) OpenBrowser(); else ShowWindow(); };
   timer.Interval=300; timer.Tick+=delegate { if(reopen.WaitOne(0)) { if(ready && !noBrowser) OpenBrowser(); else ShowWindow(); } }; timer.Start();
   FormClosing+=delegate(object sender,FormClosingEventArgs e) { if(!explicitExit && e.CloseReason==CloseReason.UserClosing) { e.Cancel=true; Hide(); } };
   Shown+=async delegate { await Start(); };
  }
  void ShowWindow() { Show(); WindowState=FormWindowState.Normal; Activate(); }
  void OpenBrowser() {
   if(!ready) { ShowWindow(); return; }
   try { Process.Start(new ProcessStartInfo(address) { UseShellExecute=true }); }
   catch(Exception e) { MessageBox.Show(this,"请手动打开浏览器访问：\n"+address+"\n\n"+e.Message,"Daymark"); }
  }
  void ShowAccessCode() {
   try {
    string value=File.ReadAllText(Path.Combine(data,"access.token")).Trim();
    using(var dialog=new Form()) {
     dialog.Text="Daymark 访问码"; dialog.ClientSize=new Size(385,145); dialog.Font=Font; dialog.StartPosition=FormStartPosition.CenterParent;
     dialog.FormBorderStyle=FormBorderStyle.FixedDialog; dialog.MaximizeBox=dialog.MinimizeBox=false; dialog.Icon=Icon;
     var hint=new Label {Text="首次在网页填写此码，浏览器随后会保存登录状态。",AutoSize=true,Location=new Point(16,15)};
     var field=new TextBox {Text=value,ReadOnly=true,Location=new Point(16,45),Width=352};
     var copy=new Button {Text="复制访问码",Location=new Point(245,91),Size=new Size(123,33)};
     copy.Click+=delegate { try { Clipboard.SetText(value); copy.Text="已复制"; } catch { field.Focus(); field.SelectAll(); } };
     dialog.Controls.AddRange(new Control[] {hint,field,copy}); dialog.ShowDialog(this);
    }
   } catch(Exception e) { MessageBox.Show(this,"暂时无法读取访问码："+e.Message,"Daymark"); }
  }
  static string Quote(string path) { return "\""+path.Replace("\"","\\\"")+"\""; }
  async Task CheckComponents() {
   foreach(string file in new string[] { "runtimes/node/node.exe", "runtimes/python/python.exe", "runtimes/napcat/NapCatWinBootMain.exe", "runtimes/napcat/napcat.mjs", "runtimes/napcat/NapCatWinBootHook.dll" }) {
    if(!File.Exists(Path.Combine(root,file))) throw new Exception("完整包缺少组件，请重新全部解压："+file);
   }
   string probe="import sys,site,sqlite3,ctypes,win32api,win32crypt,win32gui,win32ui,win32process,pywinauto,comtypes,six,PIL,frida,zstandard,typing_extensions; from Crypto.Cipher import AES; assert sys.version_info[:2]==(3,10) and not site.ENABLE_USER_SITE";
   var check=new ProcessStartInfo(Path.Combine(root,"runtimes","python","python.exe"),"-I -B -c "+Quote(probe));
   check.UseShellExecute=false; check.CreateNoWindow=true; check.RedirectStandardOutput=true; check.RedirectStandardError=true;
   using(var child=Process.Start(check)) {
    var output=child.StandardOutput.ReadToEndAsync(); var errors=child.StandardError.ReadToEndAsync();
    bool ended=await Task.Run(()=>child.WaitForExit(30000));
    if(!ended) { child.Kill(); throw new Exception("组件检查超时，请重新打开程序。"); }
    await output; string failure=await errors;
    if(child.ExitCode!=0) throw new Exception("随包 Python 组件无法加载，请重新完整解压。\n"+failure);
   }
  }
  async Task Start() {
   try {
    if(!Environment.Is64BitOperatingSystem) throw new Exception("需要 Windows 10/11 64 位系统。");
    if(!File.Exists(Path.Combine(root,"runtime-manifest.json"))) throw new Exception("请使用 Windows 完整包并全部解压；不能只复制 Daymark.exe。");
    await CheckComponents(); if(exiting) return; status.Text="正在启动本机服务…";
    var psi=new ProcessStartInfo(Path.Combine(root,"runtimes","node","node.exe"),Quote(Path.Combine(root,"server.mjs")));
    psi.WorkingDirectory=root; psi.UseShellExecute=false; psi.CreateNoWindow=true;
    psi.RedirectStandardInput=true; psi.RedirectStandardOutput=true; psi.RedirectStandardError=true;
    psi.StandardOutputEncoding=Encoding.UTF8; psi.StandardErrorEncoding=Encoding.UTF8;
    psi.EnvironmentVariables["HOST"]="127.0.0.1"; psi.EnvironmentVariables["PORT"]=Environment.GetEnvironmentVariable("PORT") ?? "4317";
    psi.EnvironmentVariables["STUDENT_INBOX_MODE"]="local"; psi.EnvironmentVariables["STUDENT_INBOX_DATA_DIR"]=data;
    psi.EnvironmentVariables["STUDENT_INBOX_PYTHON_PATH"]=Path.Combine(root,"runtimes","python","python.exe");
    psi.EnvironmentVariables["DAYMARK_DESKTOP"]="1";
    service=new Process { StartInfo=psi }; string failure="";
    service.OutputDataReceived+=delegate(object sender,DataReceivedEventArgs e) {
     if(e.Data==null || IsDisposed) return;
     var url=Regex.Match(e.Data,@"running at (http://127\.0\.0\.1:\d+)");
     if(url.Success) address=url.Groups[1].Value;
    };
    service.ErrorDataReceived+=delegate(object sender,DataReceivedEventArgs e) { if(e.Data!=null && failure.Length<4000) failure+=e.Data+"\n"; };
    service.Start(); service.BeginOutputReadLine(); service.BeginErrorReadLine();
    for(int n=0;n<300 && address==null;n++) {
     if(exiting) return;
     if(service.HasExited) throw new Exception((failure.Contains("EADDRINUSE") ? "本机端口已被占用，请先退出旧版 Daymark 启动窗口。" : "本机服务启动失败。")+"\n"+failure);
     await Task.Delay(100);
    }
    if(address==null) throw new Exception("服务启动超时，请稍后重试。");
    using(var client=new WebClient()) { client.Proxy=null; await client.DownloadStringTaskAsync(address+"/api/health"); }
    Directory.CreateDirectory(data);
    File.WriteAllText(Path.Combine(data,"desktop-state.json"),new JavaScriptSerializer().Serialize(new { url=address,pid=service.Id,ownerPid=Process.GetCurrentProcess().Id,version="0.1.3" }));
    ready=true; open.Enabled=access.Enabled=true; tray.Text="Daymark · 正在运行";
    status.Text="本机服务已启动，正在后台运行。\n"+address+"\n首次使用请点“查看访问码”。";
    if(screenshot!=null) { using(var bitmap=new Bitmap(Width,Height)) { DrawToBitmap(bitmap,new Rectangle(0,0,Width,Height)); bitmap.Save(screenshot,System.Drawing.Imaging.ImageFormat.Png); } }
    if(!noBrowser) OpenBrowser();
    var watch=new System.Windows.Forms.Timer { Interval=1000 };
    watch.Tick+=delegate {
     if(exiting) { watch.Stop(); watch.Dispose(); return; }
     if(service.HasExited) { watch.Stop(); ready=false; open.Enabled=access.Enabled=false; Result=1; status.Text="本机服务已停止，请退出后重新打开。\n"+failure; tray.Text="Daymark · 已停止"; ShowWindow(); }
    }; watch.Start();
    if(autoExit>0) { await Task.Delay(autoExit); await Stop(); }
   } catch(Exception e) {
    Result=1; status.Text="启动失败："+e.Message; tray.Text="Daymark · 启动失败"; ShowWindow();
    if(!noBrowser) MessageBox.Show(this,e.Message,"Daymark 启动失败",MessageBoxButtons.OK,MessageBoxIcon.Error);
    if(noBrowser) { Directory.CreateDirectory(data); File.WriteAllText(Path.Combine(data,"desktop-error.txt"),e.Message); }
   }
   if(Result!=0) await Stop();
  }
  async Task Stop() {
   if(exiting) return; exiting=true; quit.Enabled=open.Enabled=false; status.Text="正在保存并退出…";
   if(service!=null) {
    try {
     if(!service.HasExited) { await service.StandardInput.WriteLineAsync("shutdown"); service.StandardInput.Close(); await Task.Run(()=>service.WaitForExit(10000)); }
     if(!service.HasExited) service.Kill();
    } catch { }
    service.Dispose(); service=null;
   }
   try { File.Delete(Path.Combine(data,"desktop-state.json")); } catch { }
   tray.Visible=false; timer.Stop(); explicitExit=true; Close();
  }
  protected override void Dispose(bool disposing) { if(disposing) { tray.Dispose(); timer.Dispose(); } base.Dispose(disposing); }
 }
}
