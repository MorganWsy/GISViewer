// 和系统打交道的那部分：全局快捷键、托盘、开机自启、桌面快捷方式、检查更新、本机字体清单。
// 单独一个文件是为了让 Shell.cs 只管窗口和引擎。
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;
using Microsoft.Win32;

namespace GISViewer
{
    static class Native
    {
        [DllImport("user32.dll")] public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint mods, uint vk);
        [DllImport("user32.dll")] public static extern bool UnregisterHotKey(IntPtr hWnd, int id);
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
        [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr p);
        [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
        [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool join);

        public const int WM_HOTKEY = 0x0312;
        public const int SW_RESTORE = 9;
        public const int SW_SHOW = 5;
        public const uint MOD_ALT = 0x1, MOD_CONTROL = 0x2, MOD_SHIFT = 0x4, MOD_WIN = 0x8;
        public const int HotkeyId = 0xC101;
        /* 第二个全局热键：在资源管理器里选中文件后按它，直接在这软件里打开 */
        public const int HotkeyId2 = 0xC102;
        public const int VK_SPACE2 = 0x20;

        /* 单实例：后启动的那个不要另开一套窗口和引擎，把已经在跑的叫回来 */
        public const int WM_TULAN_SHOW = 0x8000 + 17;

        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, int msg, IntPtr w, IntPtr l);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int max);

        /* 已经在跑的主窗口：标题以"图览"开头、类是 WinForms 的顶层窗口。
           窗口收进托盘后 IsWindowVisible 是假，所以这里不能按可见性过滤 */
        public static IntPtr ExistingShellWindow()
        {
            IntPtr found = IntPtr.Zero;
            StringBuilder title = new StringBuilder(256);
            StringBuilder cls = new StringBuilder(160);
            EnumWindows(delegate(IntPtr h, IntPtr l)
            {
                title.Length = 0;
                GetWindowText(h, title, title.Capacity);
                if (title.Length == 0 || !title.ToString().StartsWith("图览", StringComparison.Ordinal))
                    return true;
                cls.Length = 0;
                GetClassName(h, cls, cls.Capacity);
                if (!cls.ToString().StartsWith("WindowsForms10.Window", StringComparison.Ordinal))
                    return true;
                found = h;
                return false;
            }, IntPtr.Zero);
            return found;
        }

        /* 所有可见、没最小化的资源管理器窗口，顺序就是屏幕层级（最上面那个在前） */
        public static List<IntPtr> VisibleExplorers()
        {
            List<IntPtr> list = new List<IntPtr>();
            StringBuilder cls = new StringBuilder(160);
            EnumWindows(delegate(IntPtr h, IntPtr l)
            {
                if (!IsWindowVisible(h) || IsIconic(h)) return true;
                cls.Length = 0;
                GetClassName(h, cls, cls.Capacity);
                string c = cls.ToString();
                if (c == "CabinetWClass" || c == "ExploreWClass") list.Add(h);
                return true;
            }, IntPtr.Zero);
            return list;
        }

        /* 从别的进程把窗口抢到前台：光调 SetForegroundWindow 经常被系统挡下来 */
        public static void ForceForeground(IntPtr hWnd)
        {
            if (hWnd == IntPtr.Zero) return;
            uint fore = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);
            uint mine = GetCurrentThreadId();
            if (fore != 0 && fore != mine)
            {
                AttachThreadInput(fore, mine, true);
                try { SetForegroundWindow(hWnd); }
                finally { AttachThreadInput(fore, mine, false); }
            }
            else SetForegroundWindow(hWnd);
        }

        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();

        public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);

        [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int max);

        [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vk);

        public const int VK_LBUTTON = 0x01;

        [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }

        public const uint GA_ROOT = 2;

        [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
        [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
        /* 取窗口所属进程号：和上面那个只拿线程号的声明分开写，EntryPoint 指同一个系统函数 */
        [DllImport("user32.dll", EntryPoint = "GetWindowThreadProcessId")]
        static extern uint PidOfWindow(IntPtr h, out uint pid);

        /* 按下的那一下落在谁家的窗口上：跨进程拖放的起点在别人的窗口里，
           哪怕那个点的坐标正好压在我们窗口上面（比如资源管理器盖住了我们一块）。
           只看坐标会把它误判成"在自己窗口里按住拖动"，拖放就永远接不上。
           注意"自家"不止主窗口一个：文件对话框（OpenFileDialog）也是本进程的顶层窗口，
           只认主窗口的话，在文件对话框上的按下会被当成外部拖动，
           对话框悬在地图区域上方时接收遮罩就会亮出来盖住它、吃掉鼠标点击 */
        public static bool DownInsideOwnWindow(IntPtr root, int x, int y)
        {
            IntPtr hit = WindowFromPoint(new POINT { X = x, Y = y });
            if (hit == IntPtr.Zero) return false;
            IntPtr top = GetAncestor(hit, GA_ROOT);
            if (top == root) return true;
            uint pid;
            PidOfWindow(top, out pid);
            return pid != 0 && pid == (uint)Process.GetCurrentProcess().Id;
        }

        /* ---------- 选文件夹的系统对话框：.gdb、瓦片目录这类"在资源管理器里是文件夹"的数据 ----------
           WinForms 的 OpenFileDialog 只能选文件；FolderBrowserDialog 是老式小树，
           没有地址栏、没法粘贴路径。这里直接用系统的 IFileOpenDialog + FOS_PICKFOLDERS，
           弹出来的就是资源管理器那个现代的"选择文件夹"框 */

        const uint FOS_PICKFOLDERS = 0x20, FOS_FORCEFILESYSTEM = 0x40, FOS_PATHMUSTEXIST = 0x800;
        const uint SIGDN_FILESYSPATH = 0x80058000;

        [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IShellItem
        {
            void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
            void GetParent(out IShellItem ppsi);
            [PreserveSig] int GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
            void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
            void Compare(IShellItem psi, uint hint, out int piOrder);
        }

        /* COM 接口的方法按个查虚表，顺序必须和系统头文件里一模一样（IFileDialog 的全部方法
           在前、IFileOpenDialog 自己的两个在后），少一个、错一个位调用的都是别的函数 */
        [ComImport, Guid("D57C7288-D4AD-4768-BE02-9D969532D960"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IFileOpenDialog
        {
            [PreserveSig] int Show(IntPtr parent);
            void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
            void SetFileTypeIndex(uint iFileType);
            void GetFileTypeIndex(out uint piFileType);
            void Advise(IntPtr pfde, out uint pdwCookie);
            void Unadvise(uint dwCookie);
            void SetOptions(uint fos);
            void GetOptions(out uint pfos);
            void SetDefaultFolder(IShellItem psi);
            void SetFolder(IShellItem psi);
            void GetFolder(out IShellItem ppsi);
            void GetCurrentSelection(out IShellItem ppsi);
            void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
            void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
            void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
            void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
            void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
            [PreserveSig] int GetResult(out IShellItem ppsi);
            void AddPlace(IShellItem psi, uint fdap);
            void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
            void Close(int hr);
            void SetClientGuid(ref Guid guid);
            void ClearClientData();
            void SetFilter(IntPtr pFilter);
            void GetResults(out IntPtr ppenum);
            void GetSelectedItems(out IntPtr ppsai);
        }

        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        static extern int SHCreateItemFromParsingName(string path, IntPtr pbc, ref Guid riid,
            [MarshalAs(UnmanagedType.Interface)] out IShellItem item);

        /* 弹系统的"选择文件夹"框；选中返回路径，取消/失败返回 null */
        public static string PickFolder(IntPtr owner, string title, string initial)
        {
            IFileOpenDialog dlg = null;
            IShellItem result = null;
            try
            {
                Type cls = Type.GetTypeFromCLSID(new Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7"));
                dlg = (IFileOpenDialog)Activator.CreateInstance(cls);
                dlg.SetOptions(FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST);
                if (!string.IsNullOrEmpty(title)) dlg.SetTitle(title);
                /* 从上次用过的目录起步：系统的对话框会自己记上次位置，
                   碰到网络位置或超大目录时打开会卡，所以这里只喂我们自己的记忆 */
                if (!string.IsNullOrEmpty(initial) && Directory.Exists(initial))
                {
                    IShellItem start = null;
                    Guid iid = typeof(IShellItem).GUID;
                    if (SHCreateItemFromParsingName(initial, IntPtr.Zero, ref iid, out start) == 0 && start != null)
                    {
                        try { dlg.SetFolder(start); }
                        finally { Marshal.ReleaseComObject(start); }
                    }
                }
                if (dlg.Show(owner) != 0) return null;   // 取消时返回的是 0x800704C7
                if (dlg.GetResult(out result) != 0 || result == null) return null;
                string path;
                if (result.GetDisplayName(SIGDN_FILESYSPATH, out path) != 0) return null;
                return path;
            }
            finally
            {
                if (result != null) Marshal.ReleaseComObject(result);
                if (dlg != null) Marshal.ReleaseComObject(dlg);
            }
        }
    }

    /* 无边框窗口：样式位留着 WS_THICKFRAME|WS_CAPTION，再用 WM_NCCALCSIZE 把非客户区抹平。
       这样边缘缩放、Aero Snap、Win+方向键、任务栏预览、窗口阴影都是白拿的，
       自己算这些反而更容易出错。 */
    static class Frame
    {
        public const int WM_NCCALCSIZE = 0x0083;
        public const int WM_GETMINMAXINFO = 0x0024;
        public const int WM_NCLBUTTONDOWN = 0x00A1;
        public const int HTCAPTION = 0x2;
        public const int WS_CAPTION = 0x00C00000, WS_THICKFRAME = 0x00040000;
        public const int WS_MINIMIZEBOX = 0x00020000, WS_MAXIMIZEBOX = 0x00010000;
        public const int WS_SYSMENU = 0x00080000;
        public const int DWMWA_WINDOW_CORNER_PREFERENCE = 33;

        [StructLayout(LayoutKind.Sequential)]
        public struct RECT { public int Left, Top, Right, Bottom; }

        [StructLayout(LayoutKind.Sequential)]
        public struct POINT { public int X, Y; }

        /* 字段顺序必须和 Win32 的 tagMINMAXINFO 一字不差：
           reserved、maxSize、maxPosition、minTrackSize、maxTrackSize。
           顺序错了系统读到的是另一回事，最大化会跑到别的屏幕上 */
        [StructLayout(LayoutKind.Sequential)]
        public struct MINMAXINFO
        {
            public POINT reserved, maxSize, maxPosition, minTrack, maxTrack;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct MONITORINFO
        {
            public int cbSize;
            public RECT rcMonitor, rcWork;
            public int dwFlags;
        }

        [DllImport("user32.dll")] static extern bool ReleaseCapture();
        [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h, int msg, IntPtr w, IntPtr l);
        [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, int flags);
        [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr h, ref MONITORINFO mi);
        [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr h, int attr, ref int value, int size);

        /* 最大化之后内容要往里缩多少：就是系统那条可拖动边框有多厚。
           无边框窗口铺满工作区时是贴着屏幕边的，不缩一下顶栏会紧贴屏幕上沿 */
        public static int Inset()
        {
            int w = SystemInformation.FrameBorderSize.Width;
            return w > 0 ? w : 7;
        }

        /* 最大化铺到"窗口所在那块屏"的工作区。注意 ptMaxPosition 是相对那块屏左上角的偏移，
           不是屏幕绝对坐标：主屏上两者恰好相同所以看不出问题，副屏上写成绝对坐标
           会把窗口推到屏外去（表现是最大化一下窗口滑出屏幕） */
        public static void MaxInfo(IntPtr h, out POINT size, out POINT pos)
        {
            MONITORINFO mi = new MONITORINFO();
            mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
            IntPtr mon = MonitorFromWindow(h, 2);   // 2 = 离窗口最近的显示器
            if (mon == IntPtr.Zero || !GetMonitorInfo(mon, ref mi))
            {
                Rectangle va = Screen.PrimaryScreen.WorkingArea;
                mi.rcWork = new RECT { Left = va.Left, Top = va.Top, Right = va.Right, Bottom = va.Bottom };
                mi.rcMonitor = mi.rcWork;
            }
            size = new POINT { X = mi.rcWork.Right - mi.rcWork.Left, Y = mi.rcWork.Bottom - mi.rcWork.Top };
            pos = new POINT { X = mi.rcWork.Left - mi.rcMonitor.Left, Y = mi.rcWork.Top - mi.rcMonitor.Top };
        }

        public static void StartDrag(IntPtr h)
        {
            ReleaseCapture();
            SendMessage(h, WM_NCLBUTTONDOWN, (IntPtr)HTCAPTION, IntPtr.Zero);
        }

        /* Win11 才认这个属性，Win10 上调用直接失败，直角放着不管也不影响使用 */
        public static void Round(IntPtr h, bool on)
        {
            try
            {
                int pref = on ? 2 : 1;   // 2=圆角 1=直角
                DwmSetWindowAttribute(h, DWMWA_WINDOW_CORNER_PREFERENCE, ref pref, 4);
            }
            catch { /* 没有圆角而已 */ }
        }
    }

    /* 组合键的" mods + vk "表示法，界面和壳共用一套数字，省得两边各翻一遍表 */
    static class Hotkey
    {
        public const uint FallbackMods = Native.MOD_CONTROL | Native.MOD_ALT;
        public const uint FallbackKey = 0x47;   // G

        public static string Describe(uint mods, uint vk)
        {
            var sb = new StringBuilder();
            if ((mods & Native.MOD_CONTROL) != 0) sb.Append("Ctrl+");
            if ((mods & Native.MOD_ALT) != 0) sb.Append("Alt+");
            if ((mods & Native.MOD_SHIFT) != 0) sb.Append("Shift+");
            if ((mods & Native.MOD_WIN) != 0) sb.Append("Win+");
            sb.Append(KeyName(vk));
            return sb.ToString();
        }

        static string KeyName(uint vk)
        {
            if (vk >= 0x70 && vk <= 0x87) return "F" + (vk - 0x6F);
            if (vk >= 0x30 && vk <= 0x39) return ((char)vk).ToString();
            if (vk >= 0x41 && vk <= 0x5A) return ((char)vk).ToString();
            switch (vk)
            {
                case 0x08: return "Backspace";
                case 0x09: return "Tab";
                case 0x0D: return "Enter";
                case 0x1D: return "菜单键";
                case 0x20: return "空格";
                case 0x21: return "PageUp";
                case 0x22: return "PageDown";
                case 0x23: return "End";
                case 0x24: return "Home";
                case 0x25: return "左箭头";
                case 0x26: return "上箭头";
                case 0x27: return "右箭头";
                case 0x28: return "下箭头";
                case 0x2D: return "Insert";
                case 0x2E: return "Delete";
                case 0x6A: return "小键盘*";
                case 0x6B: return "小键盘+";
                case 0x6D: return "小键盘-";
                case 0x6F: return "小键盘/";
            }
            return "键 " + vk;
        }

        /* 什么都不按修饰键的话，只允许 F1~F12，不然会把系统里正常的按键全吃掉 */
        public static bool Plausible(uint mods, uint vk)
        {
            if (vk == 0) return false;
            if (mods == 0) return vk >= 0x70 && vk <= 0x7B;
            return true;
        }
    }

    static class AutoStart
    {
        const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
        const string ValueName = "Tulan";

        public static bool Enabled()
        {
            try
            {
                using (RegistryKey k = Registry.CurrentUser.OpenSubKey(RunKey))
                {
                    return k != null && k.GetValue(ValueName) != null;
                }
            }
            catch { return false; }
        }

        /* 开机那次只挂到托盘，不弹一个占满屏幕的窗口 */
        public static string Set(bool on)
        {
            try
            {
                using (RegistryKey k = Registry.CurrentUser.CreateSubKey(RunKey))
                {
                    if (k == null) return "注册表没能打开";
                    if (on) k.SetValue(ValueName, "\"" + Application.ExecutablePath + "\" --hidden");
                    else k.DeleteValue(ValueName, false);
                }
                return "";
            }
            catch (Exception ex) { return ex.Message; }
        }
    }

    static class DesktopShortcut
    {
        /* 用 WScript.Shell 建 .lnk：系统自带，不用引 COM 程序集，也不用手写快捷方式二进制格式 */
        static Type ShellType()
        {
            return Type.GetTypeFromProgID("WScript.Shell");
        }

        public static string Path()
        {
            string dir = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
            return System.IO.Path.Combine(dir, "图览.lnk");
        }

        public static bool Exists()
        {
            return File.Exists(Path());
        }

        /* 用户自己右键建出来的快捷方式会跟着 exe 叫 Tulan，和软件名对不上；
           桌面上凡是名字不对、目标却是本程序的快捷方式，就地改成"图览" */
        public static string Normalize()
        {
            try
            {
                string dir = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
                string want = Path();
                Type t = ShellType();
                if (t == null) return "";
                object shell = Activator.CreateInstance(t);
                foreach (string f in Directory.GetFiles(dir, "*.lnk"))
                {
                    string name = System.IO.Path.GetFileNameWithoutExtension(f);
                    if (name == "图览") continue;
                    object lnk = t.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell,
                        new object[] { f });
                    object target = lnk.GetType().InvokeMember("TargetPath", BindingFlags.GetProperty, null, lnk,
                        new object[0]);
                    string tp = Convert.ToString(target) ?? "";
                    if (!tp.Equals(Application.ExecutablePath, StringComparison.OrdinalIgnoreCase)) continue;
                    if (File.Exists(want)) File.Delete(want);
                    File.Move(f, want);
                    return "桌面快捷方式「" + name + "」已改名成「图览」";
                }
                return "";
            }
            catch (Exception ex) { return "快捷方式改名没做成：" + ex.Message; }
        }

        /* 成功返回空串，失败返回能给人看的原因，别只说"没改成" */
        public static string Create()
        {
            try
            {
                Type t = ShellType();
                if (t == null) return "系统里没有建快捷方式用的组件";
                object shell = Activator.CreateInstance(t);
                object lnk = t.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell,
                    new object[] { Path() });
                Type lt = lnk.GetType();
                lt.InvokeMember("TargetPath", BindingFlags.SetProperty, null, lnk,
                    new object[] { Application.ExecutablePath });
                lt.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, lnk,
                    new object[] { AppDirectory() });
                lt.InvokeMember("Description", BindingFlags.SetProperty, null, lnk,
                    new object[] { "图览：GIS 文件速览" });
                string icon = System.IO.Path.Combine(AppDirectory(), "tulan.ico");
                lt.InvokeMember("IconLocation", BindingFlags.SetProperty, null, lnk,
                    new object[] { (File.Exists(icon) ? icon : Application.ExecutablePath) + ",0" });
                lt.InvokeMember("Save", BindingFlags.InvokeMethod, null, lnk, new object[0]);
                return File.Exists(Path()) ? "" : "桌面目录不让写";
            }
            catch (Exception ex) { return ex.Message; }
        }

        public static bool Remove()
        {
            try
            {
                if (File.Exists(Path())) File.Delete(Path());
                return true;
            }
            catch { return false; }
        }

        static string AppDirectory()
        {
            return System.IO.Path.GetDirectoryName(Application.ExecutablePath);
        }
    }

    /* 检查更新：只问"有没有新版"，下载和替换交给用户自己点开的页面。
       私有仓库要带访问令牌，令牌只在这次请求里用，不落盘。 */
    static class UpdateCheck
    {
        public class Result
        {
            public bool Ok;
            public bool Found;
            public string Latest = "";
            public string Notes = "";
            public string Url = "";
            public string Error = "";
        }

        public static string Current()
        {
            Version v = Assembly.GetExecutingAssembly().GetName().Version;
            return v.Major + "." + v.Minor;
        }

        /* 两段整数比大小，别用字符串比（"0.10" 会被判成比 "0.9" 小） */
        public static bool Newer(string latest, string current)
        {
            int[] a = Parse(latest), b = Parse(current);
            if (a == null || b == null) return false;
            if (a[0] != b[0]) return a[0] > b[0];
            return a[1] > b[1];
        }

        static int[] Parse(string s)
        {
            if (string.IsNullOrEmpty(s)) return null;
            string[] p = s.Trim().TrimStart('v', 'V').Split('.');
            int[] outv = new int[2];
            for (int i = 0; i < 2; i++)
            {
                outv[i] = 0;
                if (i < p.Length)
                {
                    int n;
                    if (!int.TryParse(p[i], out n)) return null;
                    outv[i] = n;
                }
            }
            return outv;
        }

        public static Result Query(string repo, string token)
        {
            Result r = new Result();
            try
            {
                if (string.IsNullOrEmpty(repo)) repo = "MorganWsy/GISViewer";
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(
                    "https://api.github.com/repos/" + repo.Trim('/') + "/releases/latest");
                req.Timeout = 9000;
                req.UserAgent = "gisviewer";
                req.Accept = "application/vnd.github+json";
                if (!string.IsNullOrEmpty(token)) req.Headers["Authorization"] = "Bearer " + token.Trim();
                using (HttpWebResponse res = (HttpWebResponse)req.GetResponse())
                using (Stream st = res.GetResponseStream())
                {
                    string body = ReadAll(st);
                    r.Ok = true;
                    r.Latest = Field(body, "tag_name");
                    r.Notes = Field(body, "name");
                    r.Url = Field(body, "html_url");
                    r.Found = Newer(r.Latest, Current());
                }
            }
            catch (WebException ex)
            {
                r.Ok = false;
                HttpWebResponse he = ex.Response as HttpWebResponse;
                int code = he == null ? 0 : (int)he.StatusCode;
                if (code == 404) r.Error = "还没有发布过版本";
                else if (code == 401 || code == 403) r.Error = "这个仓库不是公开的，需要在下面填一个只读的访问令牌";
                else if (code == 0) r.Error = "连不上，检查网络之后重试";
                else r.Error = "发布页有点不对劲，稍后再试";
            }
            catch (Exception ex)
            {
                r.Ok = false;
                r.Error = ex.Message;
            }
            return r;
        }

        static string ReadAll(Stream st)
        {
            using (var sr = new StreamReader(st, Encoding.UTF8)) return sr.ReadToEnd();
        }

        /* 只为取两三个字符串，不引 JSON 库；GitHub 的字段值里出现引号时会退化成空 */
        static string Field(string json, string key)
        {
            string needle = "\"" + key + "\"";
            int i = json.IndexOf(needle, StringComparison.Ordinal);
            if (i < 0) return "";
            i = json.IndexOf(':', i + needle.Length);
            if (i < 0) return "";
            i++;
            while (i < json.Length && (json[i] == ' ' || json[i] == '\t')) i++;
            if (i >= json.Length) return "";
            if (json[i] == '"')
            {
                int end = i + 1;
                var sb = new StringBuilder();
                while (end < json.Length)
                {
                    char c = json[end];
                    if (c == '\\' && end + 1 < json.Length) { sb.Append(json[end + 1]); end += 2; continue; }
                    if (c == '"') break;
                    sb.Append(c);
                    end++;
                }
                return sb.ToString();
            }
            int stop = i;
            while (stop < json.Length && json[stop] != ',' && json[stop] != '}' && json[stop] != '\n') stop++;
            return json.Substring(i, stop - i).Trim();
        }
    }

    static class Fonts
    {
        /* 符号字体和制图专用字体列出来只会碍事：ESRI 那一批整族都是图标字库，
           拿去做界面字体只会看到一排方块 */
        static readonly string[] Skip = new string[]
        {
            "ESRI", "Wingding", "Webding", "Marlett", "MT Extra", "Bookshelf", "Symbol",
            "Segoe MDL2", "Segoe Fluent", "Fixedsys", "Terminal", "Blackadder", "Souvenir",
            "Stigra", "Sitka", "Vladimir", "Old English", "Castellar", "Harlow", "Goudy Old",
        };

        /* Windows 把每个字重注册成一个独立族名，列表里留一份就够，
           选主族名时浏览器自己会挑字重 */
        static readonly string[] Weights = new string[]
        {
            " Thin", " ExtraLight", " Light", " DemiLight", " SemiBold", " Medium",
            " Black", " Bold", " Italic", " Regular", " ExtraBold", " Heavy", " Roman",
        };

        public static List<string> Usable()
        {
            List<string> all = new List<string>();
            foreach (FontFamily f in FontFamily.Families)
            {
                if (!string.IsNullOrEmpty(f.Name)) all.Add(f.Name);
            }
            List<string> keep = new List<string>();
            foreach (string n in all)
            {
                if (SkipName(n) || IsWeightVariant(n, all)) continue;
                keep.Add(n);
            }
            keep.Sort(delegate(string a, string b)
            {
                bool ca = HasCjk(a), cb = HasCjk(b);
                if (ca != cb) return ca ? -1 : 1;
                return string.Compare(a, b, StringComparison.OrdinalIgnoreCase);
            });
            return keep;
        }

        static bool SkipName(string n)
        {
            foreach (string bad in Skip)
            {
                if (n.StartsWith(bad, StringComparison.OrdinalIgnoreCase)) return true;
            }
            return n.IndexOf("Sym", StringComparison.OrdinalIgnoreCase) >= 0;
        }

        static bool IsWeightVariant(string name, List<string> all)
        {
            foreach (string w in Weights)
            {
                if (!name.EndsWith(w, StringComparison.OrdinalIgnoreCase)) continue;
                string root = name.Substring(0, name.Length - w.Length);
                if (root.Length == 0) continue;
                foreach (string other in all)
                {
                    if (string.Equals(other, root, StringComparison.OrdinalIgnoreCase)) return true;
                }
                return false;
            }
            return false;
        }

        static bool HasCjk(string name)
        {
            foreach (char c in name) if (c >= 0x4E00 && c <= 0x9FFF) return true;
            return false;
        }
    }
}
