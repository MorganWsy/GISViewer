// 图览 原生壳：WinForms 无边框窗口 + WebView2 内容 + Python 引擎子进程。
// 只有原生壳能拿到拖放文件和文件对话框的真实路径，网页版只能走上传，这是它存在的第一个理由。
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Windows.Automation;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace GISViewer
{
    static class Program
    {
        /* 同一个登录会话只留一套窗口和引擎；第二个进程把命令里的文件递给已经开着的那个 */
        const string InstanceName = @"Local\Tulan_GISViewer_Instance";

        [STAThread]
        static void Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            bool first;
            using (System.Threading.Mutex gate = new System.Threading.Mutex(true, InstanceName, out first))
            {
                if (!first)
                {
                    Handoff();
                    return;
                }
                Application.Run(new Shell(args));
                GC.KeepAlive(gate);
            }
        }

        static void Handoff()
        {
            IntPtr win = IntPtr.Zero;
            // 第一个进程可能还在建窗口，等它一会儿再放弃
            for (int i = 0; i < 40 && win == IntPtr.Zero; i++)
            {
                win = Native.ExistingShellWindow();
                if (win == IntPtr.Zero) System.Threading.Thread.Sleep(100);
            }
            if (win == IntPtr.Zero) return;
            Native.PostMessage(win, Native.WM_TULAN_SHOW, IntPtr.Zero, IntPtr.Zero);
        }
    }

    public class Shell : Form
    {
        const string Title = "图览";
        const string Repo = "MorganWsy/GISViewer";
        static readonly Color LightBack = Color.FromArgb(246, 247, 249);
        static readonly Color DarkBack = Color.FromArgb(18, 21, 26);

        readonly WebView2 _web;
        readonly string[] _startupPaths;
        Process _side;
        int _port;
        string _logPath;
        bool _navigated;
        readonly Stopwatch _sw = Stopwatch.StartNew();

        NotifyIcon _tray;
        Icon _trayIcon;
        uint _hkMods = Hotkey.FallbackMods;
        uint _hkKey = Hotkey.FallbackKey;
        bool _hkOk;
        int _hkTries;
        Timer _hkRetry;
        string _hkText = "";
        uint _hk2Mods = Native.MOD_CONTROL | Native.MOD_ALT;
        uint _hk2Key = Native.VK_SPACE2;
        bool _hk2Ok;
        string _hk2Text = "Ctrl+Alt+空格";
        string _lastDir = "";
        /* 文件框从哪起步：设置页填的固定目录；留空就用上次打开文件所在的文件夹 */
        string _openDir = "";
        /* 顶栏关闭按钮的行为：min＝最小化留在托盘（默认），exit＝直接退出；页面读设置后告知 */
        string _closeAction = "min";

        public Shell(string[] args)
        {
            _startupPaths = CleanArgs(args);
            // 日志路径要最早定下来，否则连快捷键注册这几行都记不到
            _logPath = Path.Combine(DataDir, "shell.log");
            try { File.WriteAllText(_logPath, ""); } catch { }
            Log("启动，参数 " + string.Join(" | ", _startupPaths));
            // 先清掉重复的环境变量，否则引擎进程会拉不起来（见 Native.DedupeEnv）
            string dup = Native.DedupeEnv();
            if (dup.Length > 0) Log("环境里有同名大小写变量，已去掉重复的一份：" + dup);
            string renamed = DesktopShortcut.Normalize();
            if (renamed.Length > 0) Log(renamed);
            Text = Title;
            // 系统标题栏整条不要了，顶栏兼任：拖动、双击最大化、右上角三键都在网页里画
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.CenterScreen;
            Size = new Size(1440, 900);
            MinimumSize = new Size(900, 560);
            BackColor = LightBack;
            AllowDrop = true;
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); }
            catch { /* 图标没带上也不影响使用 */ }
            DragEnter += OnFileDrag;
            DragDrop += OnFileDrop;

            _web = new WebView2
            {
                Dock = DockStyle.Fill,
                DefaultBackgroundColor = LightBack,
                // 外部文件拖进来交给窗口的 DragDrop 接：DataFormats.FileDrop 给的是资源管理器里的真实路径。
                // 让 WebView2 自己接（默认 true）只会把文件复制一份到临时目录再交给页面，
                // 页面拿到的就是副本路径；附加对象那条路在部分运行库版本上是空的
                AllowExternalDrop = false
            };
            Controls.Add(_web);
            DragLeave += OnFileDragLeave;

            BuildTray();
            /* 开机自启那次只挂托盘：窗口压根不显示出来——不闪屏、不抢前台，
               任务栏里也不会冒出一个按钮；等点托盘图标或按快捷键再真正亮相
               （拦下第一次显示的地方在 SetVisibleCore） */
            _startHidden = HasFlag(args, "--hidden");
            if (_startHidden)
            {
                ShowInTaskbar = false;
                /* 窗口不显示，但句柄先建出来：全局快捷键挂在窗口消息上，
                   没句柄就注册不了，自启进场后就只能点托盘才叫得出来。
                   建完顺手把引擎和页面也在后台准备好——Load 事件要等窗口
                   第一次显示才触发，不主动跑 Boot 的话，用户一唤出窗口会先
                   看到一块空白再慢慢画 */
                IntPtr warm = Handle;
                BeginInvoke((Action)(async () => await Boot()));
            }

            Load += async (s, e) => await Boot();   // 已经 Boot 过（自启进场的后台预热）就直接返回
        }

        static bool HasFlag(string[] raw, string flag)
        {
            if (raw == null) return false;
            foreach (string a in raw)
            {
                if ((a ?? "").Trim().Trim('"').Equals(flag, StringComparison.OrdinalIgnoreCase)) return true;
            }
            return false;
        }

        /* 命令行里可能带多个路径，也可能一个都没有；引号和空串都清掉 */
        internal static string[] CleanArgs(string[] raw)
        {
            List<string> list = new List<string>();
            if (raw != null)
            {
                foreach (string a in raw)
                {
                    string v = (a ?? "").Trim().Trim('"');
                    if (v.Length > 0 && !v.StartsWith("-")) list.Add(v);
                }
            }
            return list.ToArray();
        }

        static string ExeDir
        {
            get { return Path.GetDirectoryName(typeof(Shell).Assembly.Location); }
        }

        static string DataDir
        {
            get
            {
                /* 测试时可以指到别处：两个实例抢同一份界面组件数据时，
                   后起来的那个建不出浏览器控制器，日志也会互相覆盖 */
                string alt = Environment.GetEnvironmentVariable("GISVIEWER_DATA_DIR");
                string p = string.IsNullOrEmpty(alt)
                    ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "GISViewer")
                    : alt;
                Directory.CreateDirectory(p);
                return p;
            }
        }

        void Log(string msg)
        {
            try
            {
                File.AppendAllText(_logPath, DateTime.Now.ToString("HH:mm:ss.fff") + " " + msg + Environment.NewLine);
            }
            catch { /* 日志写不进去不拦主流程 */ }
        }

        /* 引擎在哪：免安装包里的 runtime 优先，其次环境变量，最后开发机的 conda 环境 */
        static string FindPython()
        {
            string[] tries = new string[]
            {
                Path.Combine(ExeDir, "runtime", "python.exe"),
                Path.Combine(ExeDir, "runtime", "Scripts", "python.exe"),
                Environment.GetEnvironmentVariable("GISVIEWER_PYTHON"),
                @"D:\miniAnaconda\envs\gisviewer\python.exe",
            };
            foreach (string p in tries)
            {
                if (!string.IsNullOrEmpty(p) && File.Exists(p)) return p;
            }
            return null;
        }

        /* HttpListener 在非管理员下要 URL ACL，用不了；让系统直接分配一个空闲端口最省事，
           也不会撞上别的程序正在监听的号 */
        static int FreePort()
        {
            System.Net.Sockets.TcpListener probe = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0);
            try
            {
                probe.Start();
                return ((IPEndPoint)probe.LocalEndpoint).Port;
            }
            catch { return 0; }
            finally
            {
                try { probe.Stop(); } catch { }
            }
        }

        /* 自启进场会在 ctor 里先跑一次 Boot（原因见上面），窗口第一次显示时
           Load 还会再触发一次；用这个旗标挡住第二次，别把引擎拉两遍 */
        bool _booted;

        async Task Boot()
        {
            if (_booted) return;
            _booted = true;
            string python = FindPython();
            if (python == null)
            {
                Fail("没找到数据引擎", "请把随软件一起发布的 runtime 文件夹放在 " + Title + ".exe 旁边。",
                    "开发机上也可以设置环境变量 GISVIEWER_PYTHON 指向 Python 解释器。");
                return;
            }

            // 界面组件的初始化与引擎启动互不依赖，先发起再等引擎，别串行加起来
            Task web = PrepareWebView();
            bool alive = false;
            for (int i = 0; i < 3 && !alive; i++)
            {
                _port = FreePort();
                Log("试第 " + (i + 1) + " 次，端口 " + _port);
                if (_port == 0) break;
                if (!StartSidecar(python, _port)) continue;
                alive = await WaitReady(_port);
                if (!alive) StopSidecar();
            }
            await web;
            if (!alive)
            {
                StopSidecar();
                Fail("数据引擎没能启动", "本地服务在 90 秒内没有响应。",
                    "详细记录在 " + _logPath);
                return;
            }

            NavigateNow();
        }

        bool StartSidecar(string python, int port)
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo(python);
                psi.WorkingDirectory = ExeDir;
                psi.Arguments = "-m gisviewer.server --port " + port + " --no-open" + ArgsWithPaths();
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.RedirectStandardError = true;
                psi.RedirectStandardOutput = true;
                // 壳被任务管理器直接结束时，引擎要自己收摊，别留后台
                psi.EnvironmentVariables["GISVIEWER_PPID"] = Process.GetCurrentProcess().Id.ToString();
                _side = Process.Start(psi);
                _side.OutputDataReceived += (s, e) => { if (!string.IsNullOrEmpty(e.Data)) Log("引擎 " + e.Data); };
                _side.ErrorDataReceived += (s, e) => { if (!string.IsNullOrEmpty(e.Data)) Log("引擎! " + e.Data); };
                _side.BeginOutputReadLine();
                _side.BeginErrorReadLine();
                Log("引擎已拉起 pid=" + _side.Id + " 解释器=" + python);
                return true;
            }
            catch (Exception ex)
            {
                Log("拉起失败 " + ex.Message);
                return false;
            }
        }

        string ArgsWithPaths()
        {
            // 路径原样交给引擎，界面第一次渲染就带着文件，不用先开空白页再跳
            var sb = new System.Text.StringBuilder();
            foreach (string p in _startupPaths) sb.Append(" \"").Append(p.Replace("\"", "")).Append('"');
            return sb.ToString();
        }

        async Task<bool> WaitReady(int port)
        {
            // 引擎一般 1 秒内就绪，所以头几秒探得密一点；固定 500ms 一轮平均要多等半秒
            int[] cadence = new int[200];
            for (int i = 0; i < cadence.Length; i++) cadence[i] = i < 24 ? 120 : 500;
            for (int i = 0; i < cadence.Length; i++)
            {
                if (_side != null && _side.HasExited)
                {
                    Log("引擎提前退出 code=" + _side.ExitCode);
                    return false;
                }
                try
                {
                    HttpWebRequest req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/api/formats");
                    req.Timeout = 900;
                    using (HttpWebResponse res = (HttpWebResponse)await req.GetResponseAsync())
                    {
                        if (res.StatusCode == HttpStatusCode.OK)
                        {
                            Log("引擎就绪，距启动 " + _sw.ElapsedMilliseconds + " ms");
                            return true;
                        }
                    }
                }
                catch (WebException) { /* 还没起来 */ }
                catch (Exception ex) { Log("探测异常 " + ex.Message); }
                await Task.Delay(cadence[i]);
            }
            return false;
        }

        async Task PrepareWebView()
        {
            try
            {
                string userData = Path.Combine(DataDir, "webview2");
                Directory.CreateDirectory(userData);
                CoreWebView2Environment env = null;
                /* 开发排查用：设了 GISVIEWER_CDP_PORT 就给 WebView2 开远程调试端口，
                   外面的工具（tools 里的 CDP 脚本）能直接看真窗口的 DOM、执行点击。
                   平时不设这个环境变量，功能完全不受影响 */
                string cdpPort = Environment.GetEnvironmentVariable("GISVIEWER_CDP_PORT");
                CoreWebView2EnvironmentOptions envOpts = null;
                if (!string.IsNullOrEmpty(cdpPort))
                {
                    envOpts = new CoreWebView2EnvironmentOptions("--remote-debugging-port=" + cdpPort);
                    Log("调试端口已开 " + cdpPort);
                }
                /* 上一个实例刚退出时用户数据目录还占着，重试而不是留一个空白窗口 */
                for (int i = 0; i < 9 && env == null; i++)
                {
                    if (i > 0) { Log("webview 目录占用，重试 " + i); await Task.Delay(700); }
                    try { env = await CoreWebView2Environment.CreateAsync(null, userData, envOpts); }
                    catch (Exception ex) { Log("环境创建失败 " + ex.Message); }
                }
                if (env == null) throw new InvalidOperationException("WebView2 运行库不可用");
                /* 上一个实例的浏览器进程还没退干净时，这一步会抛 0x8007139F（状态不对），
                   过一会儿再试就好；只试一次的话用户看到的就是一个报错框 */
                Exception last = null;
                for (int i = 0; i < 6; i++)
                {
                    if (i > 0) { Log("控制器没建起来，重试 " + i); await Task.Delay(600); }
                    try { await _web.EnsureCoreWebView2Async(env); last = null; break; }
                    catch (Exception ex) { last = ex; Log("控制器失败 " + ex.Message); }
                }
                if (last != null) throw last;
                Log("webview 就绪");

                CoreWebView2 core = _web.CoreWebView2;
                core.Settings.AreDefaultContextMenusEnabled = false;
                core.Settings.IsZoomControlEnabled = false;
                core.Settings.AreDevToolsEnabled = false;
                core.Settings.IsStatusBarEnabled = false;
                core.Settings.AreBrowserAcceleratorKeysEnabled = false;
                // 外部拖入走 WinForms 那条通道：这个开关只有 CoreWebView2 建好之后再设才作数，
                // 构造时设是白设（文档里那句 "CoreWebView2 没初始化时返回 false" 说的就是这个）
                _web.AllowExternalDrop = false;
                core.NewWindowRequested += (s, ev) => { ev.Handled = true; OpenExternal(ev.Uri); };
                core.PermissionRequested += (s, ev) =>
                {
                    /* 网页复制走异步剪贴板 API 时 WebView2 会弹"允许访问剪贴板吗"，
                       每次复制都问一次没法接受。界面是我们自己的、也不加载第三方页面，
                       权限请求一律放行（剪贴板在不同运行时版本里的枚举名还不一样，索性不挑） */
                    ev.Handled = true;
                    ev.State = CoreWebView2PermissionState.Allow;
                };
                core.WebMessageReceived += (s, ev) =>
                {
                    string msg;
                    try { msg = ev.TryGetWebMessageAsString(); }
                    catch { return; }
                    if (string.IsNullOrEmpty(msg)) return;
                    BeginInvoke((Action)(() => ApplyMessage(msg)));
                };
                core.NavigationCompleted += (s, ev) =>
                {
                    Log("导航完成 success=" + ev.IsSuccess + "，距启动 " + _sw.ElapsedMilliseconds + " ms");
                    if (!ev.IsSuccess)
                    {
                        Fail("界面没能打开", "本地服务（端口 " + _port + "）没有响应。",
                            "关掉本窗口再打开一次；详细记录在 " + _logPath);
                        return;
                    }
                    _navigated = true;
                    PushHostState();
                    // 页面加载期间拖进来的文件先攒着，界面一就绪立刻打开
                    FlushEarlyDrops();
                };
            }
            catch (Exception ex)
            {
                Log("webview 失败 " + ex);
                Fail("界面组件没能启动", ex.Message,
                    "本软件用系统自带的 Microsoft Edge 渲染界面，请确认 WebView2 运行库可用（装过新版 Edge 的机器都有）。");
            }
        }

        /* 引擎和界面组件是两笔互不依赖的耗时，并行等，谁慢也不能把另一个拖上 */
        void NavigateNow()
        {
            CoreWebView2 core = _web == null ? null : _web.CoreWebView2;
            if (core == null) return;
            core.Navigate("http://127.0.0.1:" + _port + "/");
        }

        void ApplyMessage(string msg)
        {
            if (msg == "theme:dark" || msg == "theme:light")
            {
                Color back = msg.EndsWith("dark") ? DarkBack : LightBack;
                BackColor = back;
                _web.DefaultBackgroundColor = back;
                return;
            }
            // 版本号只存在于引擎里，界面读到后转给壳，标题栏跟着走
            if (msg.StartsWith("ver:"))
            {
                string v = msg.Substring(4);
                if (v.Length > 0 && v.Length <= 16) Text = Title + " v" + v;
                return;
            }
            if (msg.StartsWith("hk:"))
            {
                string[] p = msg.Substring(3).Split(',');
                uint mods, vk;
                if (p.Length >= 2 && uint.TryParse(p[0], out mods) && uint.TryParse(p[1], out vk))
                    ApplyHotkey(mods, vk);
                return;
            }
            if (msg.StartsWith("hk2:"))
            {
                string[] p = msg.Substring(4).Split(',');
                uint mods, vk;
                if (p.Length >= 2 && uint.TryParse(p[0], out mods) && uint.TryParse(p[1], out vk))
                    ApplyHotkey2(mods, vk);
                return;
            }
            if (msg == "autostart:1" || msg == "autostart:0")
            {
                bool on = msg.EndsWith("1");
                string err = AutoStart.Set(on);
                Push("autoStartState", Json(err.Length == 0 ? (on ? "on" : "off") : "error:" + err));
                Log("开机自启 " + (on ? "开" : "关") + (err.Length == 0 ? "成功" : "失败 " + err));
                return;
            }
            if (msg == "desklnk:on" || msg == "desklnk:off")
            {
                bool on = msg.EndsWith("on");
                string err = on ? DesktopShortcut.Create() : (DesktopShortcut.Remove() ? "" : "桌面目录不让写");
                Push("deskLnkState", Json(err.Length == 0 ? (on ? "on" : "off") : "error:" + err));
                Log("桌面快捷方式 " + (on ? "创建" : "删除") + (err.Length == 0 ? "成功" : "失败 " + err));
                return;
            }
            if (msg.StartsWith("upd:"))
            {
                CheckUpdate(msg.Substring(4));
                return;
            }
            if (msg == "ready")
            {
                // 界面自己说"我准备好了"：这之前拖进来的东西现在才真能画出来
                Log("界面就绪，距启动 " + _sw.ElapsedMilliseconds + " ms");
                FlushEarlyDrops();
                return;
            }
            /* 主体区（页面里那圈虚线框）的矩形：遮罩盖哪、拖到哪算进来都以它为准。
               页面在加载完成和尺寸变化时报，坐标是客户区物理像素 */
            if (msg.StartsWith("dropArea:"))
            {
                string[] p = msg.Substring(9).Split(',');
                int x, y, w, h;
                if (p.Length >= 4 && int.TryParse(p[0], out x) && int.TryParse(p[1], out y) &&
                    int.TryParse(p[2], out w) && int.TryParse(p[3], out h) &&
                    x >= 0 && y >= 0 && w > 40 && h > 40)
                    _dropArea = new Rectangle(x, y, w, h);
                return;
            }
            if (msg == "titlebar:drag") { Frame.StartDrag(Handle); return; }
            if (msg == "win:min") { WindowState = FormWindowState.Minimized; return; }
            if (msg == "win:max") { ToggleMax(); return; }
            if (msg == "win:close")
            {
                /* 关闭按钮的行为按设置来：默认收进托盘，也可以直接退出。
                   收进托盘用"藏掉"而不是"最小化"：最小化的窗口任务栏上仍留着按钮
                   （实测改 WS_EX_TOOLWINDOW 也压不住已经建好的那个按钮），
                   窗口一藏，按钮和 Alt+Tab 那一项才真的没了，只剩托盘一个图标 */
                if (_closeAction == "exit") Close();
                else
                {
                    Hide();
                    Log("关闭按钮按下，已收进托盘（设置里可改为直接退出）");
                }
                return;
            }
            if (msg.StartsWith("closeact:"))
            {
                _closeAction = msg.Substring(9) == "exit" ? "exit" : "min";
                return;
            }
            if (msg == "pickfile") { Log("界面点了选择文件"); PickFiles(); return; }
            if (msg == "pickfolder") { Log("界面点了选择文件夹"); PickFolder(); return; }
            if (msg == "pickdir") { Log("界面点了选择起始目录"); PickDir(); return; }
            if (msg.StartsWith("opendir:"))
            {
                // 文件框 / 文件夹框从哪起步：设置页填的目录，空着表示"上次打开文件所在的文件夹"
                _openDir = msg.Substring(8).Trim();
                Log("文件框起始位置设为 " + (_openDir.Length == 0 ? "（跟随上次）" : _openDir));
                return;
            }
            if (msg.StartsWith("openpath:"))
            {
                // 设置页"缓存位置"旁边那颗"打开"：把目录交给资源管理器
                string target = msg.Substring(9).Trim();
                if (Directory.Exists(target))
                {
                    try { Process.Start(new ProcessStartInfo(target) { UseShellExecute = true }); }
                    catch (Exception ex) { Log("打开目录失败 " + ex.Message); }
                }
                else Log("要打开的目录不存在：" + target);
                return;
            }
            if (msg.StartsWith("lastdir:"))
            {
                /* 页面里打开的文件（路径框、最近打开）壳是不知道的，由页面报一声，
                   这样"打开文件框从哪开始＝上次的文件夹"才跟得上 */
                string p = msg.Substring(8).Trim();
                try
                {
                    string dir = Directory.Exists(p) ? p : Path.GetDirectoryName(p);
                    if (!string.IsNullOrEmpty(dir) && Directory.Exists(dir)) _lastDir = dir;
                }
                catch { }
                return;
            }
            if (msg.StartsWith("jserr:"))
            {
                Log("页面脚本出错 " + msg.Substring(6));
                return;
            }
        }

        void ToggleMax()
        {
            WindowState = WindowState == FormWindowState.Maximized
                ? FormWindowState.Normal : FormWindowState.Maximized;
        }

        /* 文件框的起始目录：设置页可以填一个固定目录，留空就用上次打开文件所在的文件夹。
           填的目录被删了就退回上次的；一路退到用户目录，总要给出一个真实存在的路径 */
        string StartDir()
        {
            string dir = _openDir;
            if (string.IsNullOrEmpty(dir) || !Directory.Exists(dir)) dir = _lastDir;
            if (string.IsNullOrEmpty(dir) || !Directory.Exists(dir))
                dir = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
            if (string.IsNullOrEmpty(dir) || !Directory.Exists(dir))
                dir = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
            if (string.IsNullOrEmpty(dir) || !Directory.Exists(dir))
                dir = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            return dir;
        }

        /* 设置页"打开文件框从哪开始"旁边那颗"选择…"：只挑目录，不打开数据，
           选完把路径回传给页面 */
        void PickDir()
        {
            try
            {
                SuspendDragWatch();
                try
                {
                    string picked = Native.PickFolder(Handle, Title + "：选择文件框的起始目录", StartDir());
                    if (string.IsNullOrEmpty(picked)) { Log("选起始目录已取消"); return; }
                    Log("文件框起始目录选了 " + picked);
                    Push("dir", Json(picked));
                }
                finally { ResumeDragWatch(); }
            }
            catch (Exception ex) { Log("选起始目录失败 " + ex.Message); }
        }

        /* 网页里的文件框在 WebView2 里只能拿到 C:\fakepath，选完还得先复制一份临时副本；
           用系统自己的打开框，拿到的就是真实路径。不做扩展名过滤：能读什么由引擎说了算 */
        void PickFiles()
        {
            try
            {
                /* 系统对话框弹出期间暂停拖放轮询：轮询会把"在文件对话框上按住鼠标"
                   掺进拖放判定里。判定逻辑已经把对话框当自家窗口了，这里停掉是第二道保险。
                   对话框本身被拖动、在列表里拖选文件时也不用白算 */
                SuspendDragWatch();
                try
                {
                    using (OpenFileDialog dlg = new OpenFileDialog())
                    {
                        dlg.Title = Title + "：选择要看的数据文件";
                        /* 一次只开一个文件：软件是单文件视图（地图、属性表、量算都围着
                           当前这一份转），多选没有能同时展示的地方，干脆让系统框只许选一个 */
                        dlg.Multiselect = false;
                        dlg.CheckFileExists = true;
                        dlg.Filter = "所有文件|*.*";
                        /* 从最近打开过的文件夹起步，并且不把这次的选择记回系统。
                           系统会记住上一次用过的目录，碰到网络位置或几十万文件的目录时
                           打开框会卡半天，看起来就像按钮没反应 */
                        dlg.RestoreDirectory = true;
                        string start = StartDir();
                        if (!string.IsNullOrEmpty(start) && Directory.Exists(start))
                            dlg.InitialDirectory = start;
                        Log("选择文件框已打开，从 " + (start ?? "系统默认位置") + " 开始");
                        if (dlg.ShowDialog(this) != DialogResult.OK)
                        {
                            Log("选择文件框已取消");
                            return;
                        }
                        Log("选择文件框选了 " + dlg.FileNames.Length + " 项：" +
                            string.Join(" | ", dlg.FileNames));
                        SendPaths(dlg.FileNames, false);
                    }
                }
                finally { ResumeDragWatch(); }
            }
            catch (Exception ex) { Log("打开框没弹出来 " + ex.Message); }
        }

        /* 选文件夹：.gdb 这类数据在资源管理器里是文件夹，OpenFileDialog 选不了。
           走系统的"选择文件夹"框（Native.PickFolder），和选文件共用一套后续流程 */
        void PickFolder()
        {
            try
            {
                SuspendDragWatch();
                try
                {
                    string start = StartDir();
                    Log("选择文件夹框已打开，从 " + (start ?? "系统默认位置") + " 开始");
                    string picked = Native.PickFolder(Handle, Title + "：选择数据文件夹", start);
                    if (string.IsNullOrEmpty(picked))
                    {
                        Log("选择文件夹框已取消");
                        return;
                    }
                    Log("选择文件夹框选了 " + picked);
                    SendPaths(new string[] { picked }, false);
                }
                finally { ResumeDragWatch(); }
            }
            catch (Exception ex) { Log("文件夹框没弹出来 " + ex.Message); }
        }

        /* 把只有壳知道的事一次性交给界面：本机字体、自启状态、快捷方式、当前快捷键 */
        void PushHostState()
        {
            if (_web == null || _web.CoreWebView2 == null) return;
            Push("frame", Frame.Inset().ToString());
            var names = new List<string>();
            try { names = Fonts.Usable(); }
            catch (Exception ex) { Log("字体清单失败 " + ex.Message); }
            var sb = new System.Text.StringBuilder();
            foreach (string n in names)
            {
                if (sb.Length > 0) sb.Append(',');
                sb.Append(n.Replace(",", " ").Replace("\"", ""));
            }
            Eval("window.GisHost && window.GisHost('fonts', " + Json(sb.ToString()) + ")");
            Eval("window.GisHost && window.GisHost('autoStart', " + Json(AutoStart.Enabled() ? "on" : "off") + ")");
            Eval("window.GisHost && window.GisHost('deskLnk', " + Json(DesktopShortcut.Exists() ? "on" : "off") + ")");
            Eval("window.GisHost && window.GisHost('hotkey', " + Json(_hkText) + ")");
            Eval("window.GisHost && window.GisHost('hotkey2', " + Json(_hk2Text) + ")");
            if (!_hk2Ok)
                Eval("window.GisHost && window.GisHost('hotkey2Failed', " + Json(_hk2Text) + ")");
            Eval("window.GisHost && window.GisHost('maximized', " +
                Json(WindowState == FormWindowState.Maximized ? "on" : "off") + ")");
        }

        /* 拖进来的路径送进页面：这条通道给的是资源管理器里的原始路径 */
        string _lastDrop = "";
        DateTime _lastDropAt = DateTime.MinValue;

        void SendPaths(string[] paths)
        {
            SendPaths(paths, true);
        }

        void SendPaths(string[] paths, bool dedupe)
        {
            var list = new List<string>();
            foreach (string p in paths)
            {
                list.Add(Json(p));
                try
                {
                    string dir = Directory.Exists(p) ? p : Path.GetDirectoryName(p);
                    if (!string.IsNullOrEmpty(dir) && Directory.Exists(dir)) _lastDir = dir;
                }
                catch { }
            }
            if (list.Count == 0) return;
            /* WebView2 自己会送一次、窗口的 DragDrop 也可能再送一次，
               同一批路径两秒内只认第一次，不然一份大文件要读两遍。
               从"选择文件"框来的路径不会重复，不去重——就算连着选同一个文件，
               用户也是想再看一遍 */
            string key = string.Join("|", list.ToArray());
            DateTime now = DateTime.Now;
            if (dedupe && key == _lastDrop && (now - _lastDropAt).TotalSeconds < 2)
            {
                Log("两秒内收到同一批路径，跳过重复投递");
                return;
            }
            _lastDrop = key;
            _lastDropAt = now;
            Eval("window.GisDropPaths && window.GisDropPaths([" + string.Join(",", list.ToArray()) + "])");
        }

        /* 拖进来一批路径：界面还没导航完就先收着，等页面就绪再一起送 */
        readonly List<string[]> _earlyDrops = new List<string[]>();

        /* ---------- 资源管理器里选中、按 Ctrl+Alt+空格 直接打开 ---------- */

        void OpenExplorerSelection()
        {
            string[] paths = ExplorerSelection();
            ShowFromTray();
            if (paths.Length == 0)
            {
                Log("按了选中即开，但资源管理器里没有选中的文件");
                if (_sawVirtualPick)
                {
                    /* 停在"此电脑"、"回收站"这类位置时给的是 ::{GUID} 壳路径，
                       或者选中的是桌面、文档这类文件夹——都不是能打开的数据文件 */
                    Push("notice", "{title:" + Json("这里没有能打开的文件") + ",detail:" +
                        Json("资源管理器现在停在\"此电脑\"这类没有磁盘路径的位置，或者选中的是" +
                             "桌面、文档这样的文件夹。请进入文件所在的真实文件夹，" +
                             "点选文件（比如 .tif、.shp、.gdb）后再按快捷键。") + "}");
                    return;
                }
                Push("notice", "{title:" + Json("没拿到选中的文件") + ",detail:" +
                    Json("请先在资源管理器里点选一个文件或文件夹（比如 .tif、.shp、.gdb），" +
                         "再按 Ctrl+Alt+空格。") + "}");
                return;
            }
            Log("选中即开拿到 " + paths.Length + " 项：" + string.Join(" | ", paths));
            OnDroppedPaths(paths);
        }

        /* 资源管理器开着的每个窗口都挂在 Shell.Application 的 Windows() 上，
           窗口自己的 Document.SelectedItems() 就是当前选中的那几项，Path 是真实路径。
           取哪一扇窗的顺序：前台优先，其次屏幕层级最上、确实有选中项的那一扇。

           但 Shell.Application 有两处靠不住（本轮实测踩到）：
             1. 窗口开了标签页时，Document 报的是整个窗口里第一个标签的位置，
                当前标签里选的文件根本看不到（日志里显示"此电脑，选中 0 项"）；
             2. 在桌面上选文件时根本没有资源管理器窗口，只有 Progman/WorkerW。
           所以每个候选窗口先问 COM，问不出东西再用 UI Automation 直接读眼前这个窗口的
           地址栏和列表——UIA 读的是当前标签的可见内容，不受上面两条影响。 */
        bool _sawVirtualPick;
        string _lastFolderSeen = "";

        string[] ExplorerSelection()
        {
            _sawVirtualPick = false;
            _lastFolderSeen = "";
            List<dynamic> all = new List<dynamic>();
            try
            {
                Type t = Type.GetTypeFromProgID("Shell.Application");
                if (t != null)
                {
                    dynamic shell = Activator.CreateInstance(t);
                    dynamic windows = shell.Windows();
                    if (windows != null)
                        for (int i = 0; i < (int)windows.Count; i++)
                        {
                            dynamic w = windows.Item(i);
                            try { int dummy = (int)w.HWND; all.Add(w); }
                            catch { continue; }
                        }
                }
            }
            catch (Exception ex) { Log("问资源管理器失败：" + ex.Message); }

            /* 开了标签页的窗口在 Shell.Application 里对应多个条目（同一个 HWND，
               每个标签一个 Document），所以不能按 HWND 只留最后一个——那样留下的
               往往不是眼前这个标签。这里逐个问，谁报出了选中项就用谁。
               优先级：当前标签 > 前台窗口 > 其它。
               "当前标签"靠窗口标题认：标题以文件夹名开头（"samples 和 3 个其他选项卡"） */
            IntPtr fg = Native.GetForegroundWindow();
            List<dynamic> ws = new List<dynamic>();
            List<int> scores = new List<int>();
            foreach (dynamic w in all)
            {
                int hwnd;
                try { hwnd = (int)w.HWND; } catch { continue; }
                string folder = "";
                try { folder = (string)w.Document.Folder.Self.Path; } catch { }
                string name = string.IsNullOrEmpty(folder) ? "" : Path.GetFileName(folder.TrimEnd('\\'));
                bool active = name.Length > 0 &&
                    Native.WindowText(new IntPtr(hwnd)).StartsWith(name, StringComparison.OrdinalIgnoreCase);
                ws.Add(w);
                scores.Add((active ? 2 : 0) + (hwnd == fg.ToInt32() ? 1 : 0));
            }
            for (int want = 3; want >= 0; want--)
            {
                for (int i = 0; i < ws.Count; i++)
                {
                    if (scores[i] != want) continue;
                    string[] hit = ReadSelection(ws[i]);
                    if (hit.Length > 0)
                    {
                        Log("选中即开用的是 Shell.Application 条目（优先级 " + want + "）");
                        return hit;
                    }
                }
            }

            List<IntPtr> order = new List<IntPtr>();
            if (fg != IntPtr.Zero) order.Add(fg);
            foreach (IntPtr h in Native.VisibleExplorers())
                if (!order.Contains(h)) order.Add(h);

            foreach (IntPtr h in order)
            {
                if (!UiaWorthy(h)) continue;
                string[] hit = SelectionByUia(h);
                if (hit.Length > 0)
                {
                    Log("选中即开用的是 UIA（hwnd=" + h.ToInt32() + "）");
                    return hit;
                }
            }

            /* 都没读到：如果眼前这扇窗停在 .gdb 这类以文件夹形式存在的数据上，就打开它 */
            if (!string.IsNullOrEmpty(_lastFolderSeen) &&
                _lastFolderSeen.TrimEnd('\\').EndsWith(".gdb", StringComparison.OrdinalIgnoreCase))
            {
                Log("没有选中项，打开当前所在的 .gdb 文件夹：" + _lastFolderSeen);
                return new string[] { _lastFolderSeen };
            }
            Log("没找到带选中项的资源管理器窗口（候选 " + order.Count + " 扇）");
            return new string[0];
        }

        /* 只有资源管理器窗口和桌面值得用 UIA 去翻：别的窗口（尤其 WebView2）元素树太大 */
        static bool UiaWorthy(IntPtr h)
        {
            string cls = Native.ClassName(h);
            return cls == "CabinetWClass" || cls == "Progman" || cls == "WorkerW";
        }

        string[] SelectionByUia(IntPtr hwnd)
        {
            List<string> found = new List<string>();
            try
            {
                AutomationElement root = AutomationElement.FromHandle(hwnd);
                if (root == null) return found.ToArray();
                string folder = UiaFolder(root, hwnd);
                if (string.IsNullOrEmpty(folder)) return found.ToArray();
                Condition listCond = new PropertyCondition(
                    AutomationElement.ControlTypeProperty, ControlType.List);
                foreach (AutomationElement list in root.FindAll(TreeScope.Descendants, listCond))
                {
                    object pat;
                    if (!list.TryGetCurrentPattern(SelectionPattern.Pattern, out pat)) continue;
                    AutomationElement[] sel;
                    try { sel = ((SelectionPattern)pat).Current.GetSelection(); }
                    catch { continue; }
                    foreach (AutomationElement item in sel)
                    {
                        string name = item.Current.Name;
                        if (string.IsNullOrEmpty(name)) continue;
                        string p = Path.Combine(folder, name);
                        if (File.Exists(p) || Directory.Exists(p)) { found.Add(p); continue; }
                        /* 资源管理器藏了扩展名时，显示名不含 .tif 这类后缀，按前缀找一次 */
                        try
                        {
                            foreach (string f in Directory.EnumerateFiles(folder, name + ".*"))
                            { found.Add(f); break; }
                        }
                        catch { }
                    }
                    if (found.Count > 0) break;
                }
                if (found.Count > 0) Log("UIA 在 " + folder + " 里读到 " + found.Count + " 项");
            }
            catch (Exception ex) { Log("UIA 读选中项失败：" + ex.Message); }
            return found.ToArray();
        }

        /* UIA 里怎么找"这个窗口现在在哪个文件夹"：
             1. 地址栏那个编辑框的值就是完整路径（最直接）；
             2. 桌面上没有地址栏，按窗口类名认出来，直接用桌面目录。 */
        string UiaFolder(AutomationElement root, IntPtr hwnd)
        {
            try
            {
                Condition editCond = new PropertyCondition(
                    AutomationElement.ControlTypeProperty, ControlType.Edit);
                foreach (AutomationElement e in root.FindAll(TreeScope.Descendants, editCond))
                {
                    object pat;
                    if (!e.TryGetCurrentPattern(ValuePattern.Pattern, out pat)) continue;
                    string v;
                    try { v = ((ValuePattern)pat).Current.Value; } catch { continue; }
                    if (string.IsNullOrEmpty(v)) continue;
                    if (v.Length > 2 && v[1] == ':' || v.StartsWith("\\\\"))
                        if (Directory.Exists(v)) return v;
                }
                string cls = Native.ClassName(hwnd);
                if (cls == "Progman" || cls == "WorkerW")
                {
                    string desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
                    if (Directory.Exists(desktop)) return desktop;
                }
            }
            catch (Exception ex) { Log("UIA 读文件夹失败：" + ex.Message); }
            return "";
        }

        string[] ReadSelection(dynamic w)
        {
            List<string> paths = new List<string>();
            string folder = "";
            try
            {
                folder = (string)w.Document.Folder.Self.Path;
                dynamic items = w.Document.SelectedItems();
                int c = (int)items.Count;
                Log("资源管理器窗口（文件夹 " + (string.IsNullOrEmpty(folder) ? "?" : folder) +
                    "）选中 " + c + " 项");
                string real = Native.RealPath(folder);
                _lastFolderSeen = real;   // 没选中时用于 .gdb 兜底
                if (string.IsNullOrEmpty(real)) _sawVirtualPick = true;
                for (int k = 0; k < c; k++)
                {
                    /* 每一项单独兜底：某一项取不到路径（云文件、异常的壳扩展）时，
                       不能把同一批里其它选中的文件一起丢掉 */
                    try
                    {
                        string raw = (string)items.Item(k).Path;
                        if (string.IsNullOrEmpty(raw)) { Log("  第 " + k + " 项没有路径，跳过"); continue; }
                        string p = Native.RealPath(raw);
                        if (string.IsNullOrEmpty(p))
                        {
                            _sawVirtualPick = true;
                            Log("  第 " + k + " 项是壳路径且没有磁盘路径：" + raw);
                            continue;
                        }
                        /* 桌面、文档、下载在"此电脑"里选中时给的是 ::{GUID}，上面已经转成真实路径；
                           转出来是个普通文件夹的话，只有 .gdb 才算数据，别的当"这里没有文件"处理 */
                        if (Directory.Exists(p) &&
                            !p.TrimEnd('\\').EndsWith(".gdb", StringComparison.OrdinalIgnoreCase))
                        {
                            _sawVirtualPick = true;
                            Log("  第 " + k + " 项是普通文件夹：" + p);
                            continue;
                        }
                        Log("  选中：" + p);
                        paths.Add(p);
                    }
                    catch (Exception ex) { Log("  读第 " + k + " 项失败：" + ex.Message); }
                }
            }
            catch (Exception ex) { Log("读这个资源管理器窗口失败：" + ex.Message); return new string[0]; }
            /* 一次只开一个文件（软件是单文件视图）：多选时按资源管理器的先后取第一个 */
            if (paths.Count > 1) paths = paths.GetRange(0, 1);
            return paths.ToArray();
        }

        void OnDroppedPaths(string[] paths)
        {
            if (paths == null || paths.Length == 0) { Log("拖放收到了，但里面没有路径"); return; }
            Log("拖入 " + paths.Length + " 项：" + paths[0] +
                (_navigated ? "" : "（界面还没就绪，先攒着）"));
            if (!_navigated) { _earlyDrops.Add(paths); return; }
            SendPaths(paths);
        }

        void FlushEarlyDrops()
        {
            if (_earlyDrops.Count == 0) return;
            var all = new List<string>();
            foreach (string[] p in _earlyDrops) all.AddRange(p);
            _earlyDrops.Clear();
            Log("补送启动期间拖入的 " + all.Count + " 项");
            SendPaths(all.ToArray());
        }

        void Push(string name, string jsonValue)
        {
            Eval("window.GisHost && window.GisHost(" + Json(name) + ", " + jsonValue + ")");
        }

        void Eval(string script)
        {
            try
            {
                if (_web != null && _web.CoreWebView2 != null) _web.CoreWebView2.ExecuteScriptAsync(script);
            }
            catch (Exception ex) { Log("回推界面失败 " + ex.Message); }
        }

        /* 检查更新走后台线程：网络慢或者没网都不能把界面冻住 */
        void CheckUpdate(string token)
        {
            string current = UpdateCheck.Current();
            if (string.IsNullOrEmpty(token))
            {
                /* 仓库是私有的：不带访问码去问 GitHub 只会得到 404。
                   发布由仓库主人自己做，这里把话说清楚，不当成网络故障 */
                BeginInvoke((Action)(() => Push("update",
                    "{error:" + Json("现在检查不到更新：仓库还是私有，或还没有发布版本") +
                    ",current:" + Json(current) + "}")));
                return;
            }
            System.Threading.ThreadPool.QueueUserWorkItem(delegate
            {
                UpdateCheck.Result r = UpdateCheck.Query(Repo, token);
                string payload;
                if (!r.Ok) payload = "{error:" + Json(r.Error) + ",current:" + Json(current) + "}";
                else payload = "{current:" + Json(current) + ",latest:" + Json(r.Latest) +
                    ",found:" + (r.Found ? "true" : "false") + ",url:" + Json(r.Url) +
                    ",notes:" + Json(r.Notes) + "}";
                BeginInvoke((Action)(() => Push("update", payload)));
            });
        }

        static string Json(string s)
        {
            return "\"" + (s ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"")
                .Replace("\r", "").Replace("\n", "\\n") + "\"";
        }

        bool _dragOn = false;

        void SetDragOn(bool on)
        {
            /* 只管界面的收放状态；遮罩显不显示由轮询说了算（按下的那一下发生在窗口
               出现之前的那种启动期拖放，也要把遮罩亮出来给人接）。
               推给页面的值要按 JSON 字符串序列化：页面那头拿字符串比较 */
            if (on == _dragOn) return;
            _dragOn = on;
            Push("drag", Json(on ? "true" : "false"));
        }

        /* ---------- 外部拖放的接收层：盖在软件主体上的半透明遮罩 ----------
           为什么非要这一层：画面最里面那几层窗口属于浏览器进程，资源管理器发起的
           拖放根本到不了；挂在子窗口上的手写 RegisterDragDrop 接收器又收不到
           （对照实验证实：同样手写注册的普通窗口也收不到，而 WinForms 自己的
           AllowDrop 窗口每次都能收到）。
           所以外部拖放进行时，用一块顶层遮罩盖住主体区去接——顶层窗口 + AllowDrop
           就是唯一验证可行的配置，收到后拿到的就是资源管理器里的真实路径。
           盖的范围由页面报上来的主体矩形说了算（和那圈虚线框重合，顶栏不在里面），
           平时隐藏，不挡任何点击；页面那头同时亮出"松开即可打开"的动画提示。
           怎么知道是外部拖放：每 0.1 秒看一眼左键——按下的那一瞬间不在我们窗口里、
           之后又按住移进来，就是从别的软件拖过来的；在自己窗口里按下的（平移、框选）不接。
           不用全局鼠标钩子：拖放循环期间低级钩子收不到移动消息，实测不可靠。 */
        Form _dragPane;
        Timer _dragWatch;
        /* 等着接拖放时的透明度：肉眼看不出来，但窗口还在命中测试里 */
        const double HIDDEN_ALPHA = 0.004;
        /* 初值 true：软件刚起来时可能左键早就按着在拖了（启动期拖放），
           false 的话第一跳会把这当成"在自己窗口里按下的"，遮罩就亮不起来 */
        bool _btnWas = true;
        bool _downInside;
        /* 页面报上来的主体区矩形（客户区坐标）；页面还没就绪时是空的，按整块客户区算 */
        Rectangle _dropArea;

        /* 遮罩盖在哪块、拖到哪算"进来了"：都按主体区算；页面还没报就用整块客户区兜底 */
        Rectangle DropAreaScreen()
        {
            Rectangle c = RectangleToScreen(ClientRectangle);
            if (_dropArea.Width > 40 && _dropArea.Height > 40 &&
                _dropArea.Right <= ClientSize.Width + 8 && _dropArea.Bottom <= ClientSize.Height + 8)
            {
                return new Rectangle(c.Left + _dropArea.X, c.Top + _dropArea.Y,
                                     _dropArea.Width, _dropArea.Height);
            }
            return c;
        }

        void EnsureDragPane()
        {
            if (_dragPane != null) return;
            Form veil = new Form
            {
                FormBorderStyle = FormBorderStyle.None,
                StartPosition = FormStartPosition.Manual,
                ShowInTaskbar = false,
                /* 不置顶。置顶会出大事：图览最大化时这块接收层几乎铺满整屏，
                   别的软件正拖到它下面、甚至只是拖过去放别的窗口，都会被判到我们头上，
                   结果就是"拖其他软件被遮挡、按钮点了没反应"。
                   不置顶也照样接得住：拖放命中看的是光标那一点最上面是谁，
                   我们的窗口在前的时候就是我们，别的窗口压在上面时归它 */
                BackColor = Color.FromArgb(40, 40, 44),
                /* 亮起来的时候是半透明灰；刚接住拖动时几乎看不见（alpha 1/255）——
                   那会儿还不知道人家拖的是什么，先占住位置等 DragEnter 说话。
                   不能用 Opacity=0：整条透明之后系统不再把拖放命中给它，实测收不到 DragEnter */
                Opacity = HIDDEN_ALPHA,
                AllowDrop = true,
            };
            /* 这块遮罩自己不写任何字：提示语由页面那层虚线框说
               （"松开即可打开"，连字体字号和主题都跟软件走），这里只负责压暗和接住拖放 */
            veil.DragEnter += delegate(object s, DragEventArgs e)
            {
                bool files = e.Data != null && e.Data.GetDataPresent(DataFormats.FileDrop);
                Log(files ? "拖放进来：是文件" : "拖放进来但不是文件，遮罩不亮");
                e.Effect = files ? DragDropEffects.Copy : DragDropEffects.None;
                /* 到这一步才真正确认拖的是文件，只有这时候才把遮罩和提示亮出来；
                   拖别的软件、拖一段文字过来，屏幕上什么都不会变 */
                if (files) RevealDragPane(); else SetDragOn(false);
            };
            veil.DragLeave += delegate
            {
                SetDragOn(false);
                if (_dragPane != null) _dragPane.Opacity = HIDDEN_ALPHA;
            };
            veil.DragDrop += delegate(object s, DragEventArgs e)
            {
                string[] paths = null;
                try { paths = e.Data.GetData(DataFormats.FileDrop) as string[]; } catch { }
                HideDragPane();
                if (paths == null || paths.Length == 0) { Log("松手了但没取到路径"); return; }
                OnDroppedPaths(paths);
            };
            veil.Owner = this;
            _dragPane = veil;
            _dragWatch = new Timer { Interval = 100 };
            _dragWatch.Tick += delegate { DragWatchTick(); };
            _dragWatch.Start();
            Log("拖放接收层已备好");
        }

        /* 弹系统对话框（选文件/选文件夹）期间暂停轮询、关上后恢复 */
        void SuspendDragWatch()
        {
            if (_dragWatch != null) _dragWatch.Stop();
        }

        void ResumeDragWatch()
        {
            /* 关对话框那一下的点击不该被当成下一次拖拽的起点：
               _btnWas 重置为"已抬起"、按下判定清掉，接收层有亮着的一并收掉 */
            _btnWas = true;
            _downInside = false;
            if (_dragPane != null && _dragPane.Visible) HideDragPane();
            if (_dragWatch != null) _dragWatch.Start();
        }

        void DragWatchTick()
        {
            bool btn = (Native.GetAsyncKeyState(Native.VK_LBUTTON) & 0x8000) != 0;
            Point pt = Cursor.Position;
            bool inside = DropAreaScreen().Contains(pt);
            /* 按下的一瞬间落在谁家窗口上，决定这次按住算不算"从别的软件拖过来"：
               光比坐标不行——资源管理器盖住我们一块时，拖动的起点坐标也在我们窗口里 */
            if (btn && !_btnWas) _downInside = Native.DownInsideOwnWindow(Handle, pt.X, pt.Y);
            _btnWas = btn;
            if (!btn || _downInside || !Visible) { HideDragPane(); return; }
            if (inside) ShowDragPane(); else HideDragPane();
        }

        /* 确认拖的是文件之后才看得见：透明度从 0 提到 0.62，页面那层的提示同时亮出来 */
        void RevealDragPane()
        {
            if (_dragPane == null || !_dragPane.Visible) return;
            if (_dragPane.Opacity <= HIDDEN_ALPHA) _dragPane.Opacity = 0.62;
            SetDragOn(true);
        }

        void ShowDragPane()
        {
            if (_dragPane == null || _dragPane.Visible) return;
            _dragPane.Bounds = DropAreaScreen();
            _dragPane.Opacity = HIDDEN_ALPHA;
            _dragPane.Show();
            _dragPane.BringToFront();
            Log("外部拖放进入窗口，接收层已就位（还不知道拖的是什么）");
        }

        void HideDragPane()
        {
            if (_dragPane == null || !_dragPane.Visible) return;
            _dragPane.Hide();
            _dragPane.Opacity = HIDDEN_ALPHA;
            SetDragOn(false);
            Log("接收层已隐藏");
        }

        /* 退路：主窗口自己的 AllowDrop 通道。正常情况下拖放都被接收层接走，
           走不到这里；万一走到了，也要在日志里说清楚是这条通道收到的 */
        void OnFileDrag(object sender, DragEventArgs e)
        {
            bool files = e.Data.GetDataPresent(DataFormats.FileDrop);
            Log("窗口层拖放进来 files=" + files);
            e.Effect = files ? DragDropEffects.Copy : DragDropEffects.None;
            SetDragOn(files);
        }

        void OnFileDragLeave(object sender, EventArgs e)
        {
            SetDragOn(false);
        }

        void OnFileDrop(object sender, DragEventArgs e)
        {
            SetDragOn(false);
            Log("窗口层松手");
            OnDroppedPaths(e.Data.GetData(DataFormats.FileDrop) as string[]);
        }

        void OpenExternal(string url)
        {
            try
            {
                if (!url.StartsWith("http://") && !url.StartsWith("https://")) return;
                Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
            }
            catch (Exception ex) { Log("外部链接失败 " + ex.Message); }
        }

        void Fail(string title, string detail, string hint)
        {
            MessageBox.Show(this, title + "\n\n" + detail + "\n\n" + hint, Title,
                MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }

        /* ---------- 托盘与全局快捷键 ---------- */

        /* 开机自启这次进场要不要"隐身"：置 true 后第一次显示会被拦下 */
        bool _startHidden;

        protected override void SetVisibleCore(bool value)
        {
            /* 自启进场：第一次要求显示时压住不显示，只有托盘图标在场。
               之后（点托盘、快捷键唤起）走正常流程，这个旗标早已消掉 */
            if (_startHidden && value)
            {
                _startHidden = false;
                base.SetVisibleCore(false);
                return;
            }
            base.SetVisibleCore(value);
        }

        void BuildTray()
        {
            try
            {
                _trayIcon = Icon;
                ContextMenuStrip menu = new ContextMenuStrip();
                menu.Items.Add("显示主界面", null, delegate { ShowFromTray(); });
                menu.Items.Add("退出", null, delegate { Close(); });
                _tray = new NotifyIcon
                {
                    Icon = _trayIcon,
                    Text = Title + "（" + Hotkey.Describe(_hkMods, _hkKey) + " 唤起）",
                    Visible = true,
                    ContextMenuStrip = menu
                };
                _tray.MouseClick += (s, ev) => { if (ev.Button == MouseButtons.Left) Toggle(); };
            }
            catch (Exception ex) { Log("托盘没建起来 " + ex.Message); }
        }

        void Toggle()
        {
            if (WindowState == FormWindowState.Minimized || !Visible) { ShowFromTray(); return; }
            WindowState = FormWindowState.Minimized;
        }

        void ShowFromTray()
        {
            /* 从托盘回来：任务栏按钮也跟着回来（自启进场时它是关着的） */
            ShowInTaskbar = true;
            Show();
            if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
            Activate();
            Native.ForceForeground(Handle);
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            RegisterHotkey2();
            RegisterHotkey();
            /* 启动头几百毫秒界面还没就绪时拖进来的文件，接收层照收，
               收到的路径先攒着，等界面就绪再补送 */
            EnsureDragPane();
        }

        /* 选中即开这一条：默认 Ctrl+Alt+空格，设置里可以换。
           系统自己把空格给了"快速预览"，单独按抢不过来，所以默认带一组修饰键 */
        void RegisterHotkey2()
        {
            Native.UnregisterHotKey(Handle, Native.HotkeyId2);
            string text = Hotkey.Describe(_hk2Mods, _hk2Key);
            _hk2Text = text;
            if (Native.RegisterHotKey(Handle, Native.HotkeyId2, _hk2Mods, _hk2Key))
            {
                _hk2Ok = true;
                Log("选中即开的快捷键已挂上 " + text);
            }
            else
            {
                _hk2Ok = false;
                Log("选中即开的快捷键 " + text + " 注册不上（可能被别的软件占了）");
            }
        }

        /* 上一次退出时热键可能还被旧进程占着，重试几次而不是干脆不要 */
        void RegisterHotkey()
        {
            if (Native.RegisterHotKey(Handle, Native.HotkeyId, _hkMods, _hkKey))
            {
                _hkOk = true;
                if (_hkRetry != null) _hkRetry.Stop();
                _hkText = Hotkey.Describe(_hkMods, _hkKey);
                if (_tray != null) _tray.Text = Title + "（" + _hkText + " 唤起）";
                Log("快捷键已挂上 " + _hkText);
                return;
            }
            _hkOk = false;
            if (_hkTries++ >= 15)
            {
                Log("快捷键注册不上，放弃重试");
                if (_hkRetry != null) _hkRetry.Stop();
                return;
            }
            if (_hkRetry == null)
            {
                _hkRetry = new Timer { Interval = 400 };
                _hkRetry.Tick += delegate { RegisterHotkey(); };
            }
            _hkRetry.Start();
        }

        /* 设置里换了"选中即开"的组合键：先试新的，被别人占了就退回默认并告诉界面 */
        void ApplyHotkey2(uint mods, uint vk)
        {
            if (!Hotkey.Plausible(mods, vk)) return;
            _hk2Mods = mods;
            _hk2Key = vk;
            RegisterHotkey2();
            if (_hk2Ok)
            {
                Push("hotkey2Ok", Json(_hk2Text));
                return;
            }
            string want = Hotkey.Describe(mods, vk);
            _hk2Mods = Native.MOD_CONTROL | Native.MOD_ALT;
            _hk2Key = Native.VK_SPACE2;
            RegisterHotkey2();
            Push("hotkey2Ok", Json(_hk2Text));
            Push("hotkey2Failed", Json(want));
        }

        void ApplyHotkey(uint mods, uint vk)
        {
            if (!Hotkey.Plausible(mods, vk)) return;
            Native.UnregisterHotKey(Handle, Native.HotkeyId);
            _hkTries = 0;
            _hkMods = mods;
            _hkKey = vk;
            RegisterHotkey();
            if (!_hkOk)
            {
                string want = Hotkey.Describe(mods, vk);
                _hkMods = Hotkey.FallbackMods;
                _hkKey = Hotkey.FallbackKey;
                RegisterHotkey();
                // 先把退回后的组合键报回去，再单独说清是哪一个被占了
                Push("hotkey", Json(_hkText));
                Push("hotkeyFailed", Json(want));
            }
            else Push("hotkeyOk", Json(_hkText));
        }

        /* FormBorderStyle.None 会把这些样式位一起摘掉，手动加回来：
           有 WS_THICKFRAME 才有边缘缩放和 Aero Snap，有 WS_CAPTION 拖动标题栏才生效。
           它们本该画出来的非客户区由下面的 WM_NCCALCSIZE 抹平。 */
        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.Style |= Frame.WS_CAPTION | Frame.WS_THICKFRAME | Frame.WS_MINIMIZEBOX
                    | Frame.WS_MAXIMIZEBOX | Frame.WS_SYSMENU;
                return cp;
            }
        }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == Frame.WM_NCCALCSIZE && m.WParam != IntPtr.Zero)
            {
                // 非客户区整个抹掉：客户区就是窗口本身，不做任何内缩
                m.Result = IntPtr.Zero;
                return;
            }
            if (m.Msg == Frame.WM_GETMINMAXINFO)
            {
                Frame.MINMAXINFO mm = (Frame.MINMAXINFO)Marshal.PtrToStructure(
                    m.LParam, typeof(Frame.MINMAXINFO));
                Frame.POINT size, pos;
                Frame.MaxInfo(Handle, out size, out pos);
                // 正好铺满所在屏的工作区：不往外扩那一圈隐形边框，顶栏才不会被推出屏幕
                mm.maxSize = size;
                mm.maxPosition = pos;
                mm.maxTrack = size;
                mm.minTrack = new Frame.POINT { X = MinimumSize.Width, Y = MinimumSize.Height };
                Marshal.StructureToPtr(mm, m.LParam, true);
                m.Result = IntPtr.Zero;
                return;
            }
            if (m.Msg == Native.WM_HOTKEY)
            {
                if ((int)m.WParam == Native.HotkeyId2) OpenExplorerSelection();
                else Toggle();
                return;
            }
            // 后启动的那一个进程找到这里：把窗口叫回来，命令行里带了文件就顺手打开
            if (m.Msg == Native.WM_TULAN_SHOW)
            {
                Log("又启动了一次，已有实例把窗口叫回来");
                ShowFromTray();
                return;
            }
            base.WndProc(ref m);
        }

        /* 最大化时直角、平时圆角，并把当前状态同步给界面换图标 */
        protected override void OnSizeChanged(EventArgs e)
        {
            base.OnSizeChanged(e);
            if (!IsHandleCreated) return;
            if (_dragPane != null && _dragPane.Visible) _dragPane.Bounds = DropAreaScreen();
            Frame.Round(Handle, WindowState != FormWindowState.Maximized);
            Push("maximized", Json(WindowState == FormWindowState.Maximized ? "on" : "off"));
            // 最大化后内容要缩回去的边距，量的是系统边框有多厚
            Push("frame", Frame.Inset().ToString());
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            // 真正退出的路径才走到这里（关闭按钮默认只最小化；托盘菜单的"退出"或设置里选了直接退出才会关）。这是个"看一眼"的工具，弹一句"要不要留在托盘"只会拖慢下一次
            if (_tray != null) { _tray.Visible = false; _tray.Dispose(); _tray = null; }
            if (_hkRetry != null) { _hkRetry.Stop(); _hkRetry.Dispose(); _hkRetry = null; }
            if (_hkOk) Native.UnregisterHotKey(Handle, Native.HotkeyId);
            StopSidecar();
            base.OnFormClosing(e);
        }

        /* 子进程只杀父会留一串 GDAL 的子孙进程，交给 taskkill 连树收掉 */
        void StopSidecar()
        {
            try
            {
                if (_side == null || _side.HasExited) return;
                int pid = _side.Id;
                ProcessStartInfo psi = new ProcessStartInfo("taskkill.exe",
                    "/PID " + pid + " /T /F");
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                Process.Start(psi).WaitForExit(4000);
                Log("引擎已回收 pid=" + pid);
            }
            catch (Exception ex) { Log("回收引擎失败 " + ex.Message); }
        }
    }
}
