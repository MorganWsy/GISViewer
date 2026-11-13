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
using System.Security.Cryptography;
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
        /* 第三个：选中的文件不打开，直接做一次数据体检 */
        public const int HotkeyId3 = 0xC103;
        public const int VK_SPACE2 = 0x20;
        public const int VK_D = 0x44;

        /* 单实例：后启动的那个不要另开一套窗口和引擎，把已经在跑的叫回来 */
        public const int WM_TULAN_SHOW = 0x8000 + 17;
        /* 交接文件：后启动的那个把命令行里的路径带给已经开着的实例（资源管理器右键"用图览打开"） */
        public const int WM_COPYDATA = 0x004A;
        [StructLayout(LayoutKind.Sequential)]
        public struct COPYDATASTRUCT { public IntPtr dwData; public int cbData; public IntPtr lpData; }
        [DllImport("user32.dll")]
        public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr w, ref COPYDATASTRUCT cds);

        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, int msg, IntPtr w, IntPtr l);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int max);

        public static string ClassName(IntPtr h)
        {
            StringBuilder sb = new StringBuilder(128);
            try { GetClassName(h, sb, sb.Capacity); } catch { return ""; }
            return sb.ToString();
        }

        public static string WindowText(IntPtr h)
        {
            StringBuilder sb = new StringBuilder(512);
            try { GetWindowText(h, sb, sb.Capacity); } catch { return ""; }
            return sb.ToString();
        }

        /* 壳路径（::{GUID} 这类）转成磁盘路径。在"此电脑"里选中桌面、文档、下载这类
           已知文件夹时，资源管理器给的 Path 是壳路径，直接当文件名用会报"找不到"。
           转得出来就用转出来的，转不出来（此电脑、回收站本身）说明确实不是磁盘上的东西 */
        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        static extern int SHParseDisplayName(string name, IntPtr pbc, out IntPtr ppidl, uint sfgao, out uint psfgao);
        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        static extern bool SHGetPathFromIDListW(IntPtr pidl, StringBuilder path);
        /* CoTaskMemFree 在 ole32 里，不在 shell32——写错 dll 名会在第一次调用时抛
           EntryPointNotFoundException，整个"选中即开"直接失效 */
        [DllImport("ole32.dll")]
        static extern void CoTaskMemFree(IntPtr pv);

        public static string RealPath(string shellPath)
        {
            if (string.IsNullOrEmpty(shellPath)) return "";
            if (!shellPath.StartsWith("::", StringComparison.Ordinal)) return shellPath;
            IntPtr pidl;
            uint attrs;
            try
            {
                if (SHParseDisplayName(shellPath, IntPtr.Zero, out pidl, 0, out attrs) != 0) return "";
            }
            catch { return ""; }
            try
            {
                StringBuilder sb = new StringBuilder(1024);
                return SHGetPathFromIDListW(pidl, sb) ? sb.ToString() : "";
            }
            finally { CoTaskMemFree(pidl); }
        }

        /* 环境里可能同时存在大小写两份同名变量（Git Bash 会给出 HTTPS_PROXY 和 https_proxy）。
           ProcessStartInfo.EnvironmentVariables 复制父环境时按"不区分大小写"建字典，
           第二次 Add 会抛"已添加项"，引擎直接拉不起来。启动时先去掉重复的那一份 */
        public static string DedupeEnv()
        {
            HashSet<string> seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            List<string> kill = new List<string>();
            foreach (System.Collections.DictionaryEntry kv in Environment.GetEnvironmentVariables())
            {
                string k = (string)kv.Key;
                if (!seen.Add(k)) kill.Add(k);
            }
            foreach (string k in kill)
            {
                try { Environment.SetEnvironmentVariable(k, null); } catch { }
            }
            return string.Join(",", kill.ToArray());
        }

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

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern IntPtr FindWindow(string cls, string title);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string title);

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
        public const int WM_WINDOWPOSCHANGING = 0x0046;
        public const uint SWP_NOSIZE = 0x0001, SWP_NOMOVE = 0x0002;
        public const uint SWP_NOZORDER = 0x0004, SWP_NOACTIVATE = 0x0010;
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

        /* tagWINDOWPOS：改目标位置/尺寸要在 WM_WINDOWPOSCHANGING 里改这个结构，
           字段顺序同样不能动（前面两个句柄，然后 x/y/cx/cy，最后 flags） */
        [StructLayout(LayoutKind.Sequential)]
        public struct WINDOWPOS
        {
            public IntPtr hwnd, hwndInsertAfter;
            public int x, y, cx, cy;
            public uint flags;
        }

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
        [DllImport("user32.dll")] static extern bool SetWindowPos(
            IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
        [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, int flags);
        [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr h, ref MONITORINFO mi);
        [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr h, int attr, ref int value, int size);

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

        /* 边缘拖动改大小：网页那边感知到鼠标进了窗口边缘，就把方向报过来。
           这里交给系统的缩放循环来做——发 WM_NCLBUTTONDOWN，wParam 带上命中码
           （HTLEFT/HTRIGHT/HTTOP/HTBOTTOM 与四个角），DefWindowProc 就会接管鼠标，
           拖到哪算哪，松手结束。

           为什么用 WM_NCLBUTTONDOWN 而不是 WM_SYSCOMMAND+SC_SIZE：
           SC_SIZE 那条路要求"按下"这件事由系统自己观察到，
           而真实的按下发生在网页那个子窗口上，系统那边不认；
           WM_NCLBUTTONDOWN 是主动告诉系统"从这条边开始缩放"，
           和上面顶栏拖动用 HTCAPTION 是同一个入口，已验证可用。

           为什么不让网页自己算尺寸：网页只看得见客户区，看不见窗口外那圈，
           而且拖出窗口后指针坐标会丢，缩到一半就断了。 */
        /* 直接摆窗口，绕开 WinForms 的 Size 属性：那个 setter 会先按它自己记的边框尺寸
           发一次 SetWindowPos、再补一次 FRAMECHANGED，中间那一手会让网页白挨一次重排 */
        public static void MoveSize(IntPtr h, int x, int y, int cx, int cy, uint flags)
        {
            SetWindowPos(h, IntPtr.Zero, x, y, cx, cy, flags);
        }

        public static void StartResize(IntPtr h, int hit)
        {
            /* hit 用的就是系统命中测试那套编码：
               10=HTLEFT 11=HTRIGHT 12=HTTOP 13=HTTOPLEFT 14=HTTOPRIGHT
               15=HTBOTTOM 16=HTBOTTOMLEFT 17=HTBOTTOMRIGHT */
            if (hit < 10 || hit > 17) return;
            ReleaseCapture();
            SendMessage(h, WM_NCLBUTTONDOWN, (IntPtr)hit, IntPtr.Zero);
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

    /* 检查更新：读发布清单（latest.json），有新版本就交给界面提示；用户点了"更新"才下载。
       清单与安装包放在同一个静态目录（默认阿里云 OSS 的只读桶，与历书同一套思路：
       静态文件、无鉴权、按 sha256 校验整包）。换发布位置改 ManifestBase，
       调试试本地目录时用环境变量 TULAN_UPD_BASE 覆盖。
       下载 → 校验 → 替换 分三步，任何一步失败都留着现有文件不动。 */
    static class UpdateCheck
    {
        public const string ManifestBase = "https://wsy-release.oss-cn-hangzhou.aliyuncs.com/tulan";

        /* 清单签名用的公钥（ECDSA P-256）。私钥在 D:\tulan-keys\update-private.txt，
           由 tools\publish.ps1 拿去签；这里只有公钥，泄了也只能验不能签。
           指纹（SHA-256 前 8 位）由发布脚本每次打印，升级排查时先对一眼。
           换密钥等于断掉所有已安装副本的更新通道——别随手重生成。 */
        const string PubX = "N9DJcBihO/Xrk4o+SCRdeT9p5eo8D8wGNLqfUtyIFbQ=";
        const string PubY = "oDXjsYdfD8pGbpk+6ebEEctNHW36+nFC9yKcnI+RD84=";

        public class Result
        {
            public bool Ok;
            public bool Found;
            public string Current = "";
            public string Latest = "";
            public string Date = "";
            public string Page = "";
            public string Pkg = "";
            public long Size;
            public string Sha256 = "";
            public List<string> Notes = new List<string>();
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

        static string Base()
        {
            string env = Environment.GetEnvironmentVariable("TULAN_UPD_BASE");
            if (!string.IsNullOrEmpty(env)) return env.TrimEnd('/');
            return ManifestBase;
        }

        /* 验签：签名是对"清单字节的 SHA-256"做的 ECDSA P-256，IEEE P1363 那串 r‖s，64 字节。
           这里必须自己先算摘要再 VerifyHash——早先图省事把清单原始字节直接当哈希传，
           CNG 只取前 32 字节参与运算，改清单后半段照样验得过（实测），等于只保护了开头一小段。
           发布脚本那边是同样的口径：SignHash(SHA256(清单字节))。 */
        static bool Verify(byte[] man, string sigB64)
        {
            try
            {
                byte[] sig = Convert.FromBase64String(sigB64.Trim());
                if (sig.Length != 64) return false;
                using (ECDsa e = ECDsa.Create())
                {
                    ECParameters p = new ECParameters();
                    p.Curve = ECCurve.NamedCurves.nistP256;
                    p.Q = new ECPoint { X = Convert.FromBase64String(PubX), Y = Convert.FromBase64String(PubY) };
                    e.ImportParameters(p);
                    byte[] digest = SHA256.Create().ComputeHash(man);
                    return e.VerifyHash(digest, sig);
                }
            }
            catch (Exception)
            {
                return false;
            }
        }

        /* 问一次"有没有新版"。清单读不到就返回可读的原因，不抛异常 */
        public static Result Query(string current)
        {
            Result r = new Result();
            r.Current = string.IsNullOrEmpty(current) ? Current() : current;
            string err;
            byte[] raw = Get(Base() + "/latest.json", 9000, 256 * 1024, out err);
            if (raw == null)
            {
                r.Ok = false;
                r.Error = err;
                return r;
            }
            string text = Encoding.UTF8.GetString(raw).TrimStart('\uFEFF');
            /* 验签必须在解析之前：清单里的 pkg / sha256 都是"要执行什么"的指令，
               只信"这些字节出自私钥持有者"，后面的字段才能当数据用。
               否则 sha256 与包名写在同一个文件里，改包顺手改校验和就绕过去了 */
            byte[] sigRaw = Get(Base() + "/latest.json.sig", 9000, 4096, out err);
            if (sigRaw == null)
            {
                /* 走到这里说明清单已经读到了，缺的是签名——发布不完整，不是"还没发过版"。
                   （清单本身 404 的情况在上一步就返回了。） */
                r.Ok = false;
                r.Error = "更新清单缺少签名文件，发布不完整，这次不更新";
                return r;
            }
            if (!Verify(raw, Encoding.ASCII.GetString(sigRaw)))
            {
                r.Ok = false;
                r.Error = "更新清单的签名对不上，这次不更新";
                return r;
            }
            Dictionary<string, object> map;
            try
            {
                var ser = new System.Web.Script.Serialization.JavaScriptSerializer();
                map = ser.Deserialize<Dictionary<string, object>>(text);
            }
            catch (Exception)
            {
                r.Ok = false;
                r.Error = "更新清单格式不对，先跳过这次检查";
                return r;
            }
            if (map == null)
            {
                r.Ok = false;
                r.Error = "更新清单是空的";
                return r;
            }
            r.Ok = true;
            r.Latest = Str(map, "ver");
            r.Date = Str(map, "date");
            r.Page = Str(map, "page");
            r.Pkg = Str(map, "pkg");
            r.Sha256 = Str(map, "sha256").ToLowerInvariant();
            r.Size = Num(map, "size");
            r.Notes = NotesOf(map);
            if (!IsVer(r.Latest))
            {
                r.Ok = false;
                r.Error = "更新清单里的版本号看不懂";
                return r;
            }
            r.Found = Newer(r.Latest, r.Current);
            return r;
        }

        /* notes 可以是数组，也可以是一段用换行分开的文字。两种都收 */
        static List<string> NotesOf(Dictionary<string, object> map)
        {
            var list = new List<string>();
            object v;
            if (!map.TryGetValue("notes", out v) || v == null) return list;
            string one = v as string;
            if (one != null)
            {
                foreach (string line in one.Replace("\r\n", "\n").Split('\n'))
                {
                    string s = line.Trim().TrimStart('-', '*', '·').Trim();
                    if (s.Length > 0) list.Add(s);
                }
                return list;
            }
            var many = v as System.Collections.IEnumerable;
            if (many == null) return list;
            foreach (object o in many)
            {
                string s = Convert.ToString(o);
                if (!string.IsNullOrEmpty(s) && s.Trim().Length > 0) list.Add(s.Trim());
            }
            return list;
        }

        static string Str(Dictionary<string, object> map, string key)
        {
            object v;
            if (!map.TryGetValue(key, out v) || v == null) return "";
            return Convert.ToString(v).Trim();
        }

        static long Num(Dictionary<string, object> map, string key)
        {
            object v;
            if (!map.TryGetValue(key, out v) || v == null) return 0;
            long n;
            return long.TryParse(Convert.ToString(v).Trim(), out n) ? n : 0;
        }

        static bool IsVer(string s)
        {
            if (string.IsNullOrEmpty(s) || s.Length > 16) return false;
            string[] p = s.TrimStart('v', 'V').Split('.');
            if (p.Length < 1 || p.Length > 3) return false;
            foreach (string part in p)
            {
                if (part.Length == 0 || part.Length > 4) return false;
                foreach (char c in part) if (c < '0' || c > '9') return false;
            }
            return true;
        }

        /* ---------- 取文件：整包读进内存，体积有上限，防止被一个坏地址撑爆 ---------- */

        static byte[] Get(string url, int timeoutMs, int maxBytes, out string err)
        {
            err = "";
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
                req.Timeout = timeoutMs;
                req.ReadWriteTimeout = timeoutMs;
                req.UserAgent = "tulan-updater";
                /* 清单每次都问最新的：中间可能隔着 CDN。
                   只写请求头不够——HttpWebRequest 自带一层进程内缓存，python http.server
                   这种只给 Last-Modified 的源会被它按"启发式新鲜度"存住，第二次问还回旧字节
                   （实测：改了清单再查，签名照样通过）。CachePolicy 才是那层缓存的开关。 */
                req.Headers["Cache-Control"] = "no-cache";
                req.CachePolicy = new System.Net.Cache.RequestCachePolicy(
                    System.Net.Cache.RequestCacheLevel.BypassCache);
                using (HttpWebResponse res = (HttpWebResponse)req.GetResponse())
                using (Stream st = res.GetResponseStream())
                using (var ms = new MemoryStream())
                {
                    byte[] buf = new byte[32768];
                    int n;
                    while ((n = st.Read(buf, 0, buf.Length)) > 0)
                    {
                        ms.Write(buf, 0, n);
                        if (ms.Length > maxBytes)
                        {
                            err = "更新清单大得离谱，先跳过这次检查";
                            return null;
                        }
                    }
                    return ms.ToArray();
                }
            }
            catch (WebException ex)
            {
                HttpWebResponse he = ex.Response as HttpWebResponse;
                int code = he == null ? 0 : (int)he.StatusCode;
                // 清单还没发布过：这不是故障，说清楚就行
                if (code == 404) err = "还没有发布过版本";
                else if (code == 0) err = "连不上更新服务器，检查网络之后重试";
                else err = "更新服务器返回 " + code;
                return null;
            }
            catch (Exception ex)
            {
                err = ex.Message;
                return null;
            }
        }

        /* ---------- 下载与暂存 ---------- */

        public static string WorkDir()
        {
            string baseDir = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            return Path.Combine(Path.Combine(baseDir, "GISViewer"), "update");
        }

        public static string StageOf(Result r)
        {
            return Path.Combine(Path.Combine(WorkDir(), "v" + r.Latest), "stage");
        }

        /* 下载整包、核对大小与 sha256、解压到 stage。返回 null 表示成功，否则是可读的原因 */
        public static string Fetch(Result r, Action<int> progress)
        {
            if (string.IsNullOrEmpty(r.Pkg)) return "更新清单里没写安装包的文件名";
            string dir = Path.Combine(WorkDir(), "v" + r.Latest);
            string zip = Path.Combine(dir, "pkg.zip");
            try
            {
                if (Directory.Exists(dir)) Directory.Delete(dir, true);
                Directory.CreateDirectory(dir);
            }
            catch (Exception ex) { return "建不了暂存目录：" + ex.Message; }

            string url = Base() + "/" + r.Pkg.TrimStart('/');
            string err = Download(url, zip, r.Size, progress);
            if (err != null) return err;

            if (r.Sha256.Length == 64)
            {
                string got = Sha256File(zip);
                if (!string.Equals(got, r.Sha256, StringComparison.OrdinalIgnoreCase))
                    return "下载下来的文件校验不一致，可能没下完整";
            }

            string stage = StageOf(r);
            try
            {
                if (Directory.Exists(stage)) Directory.Delete(stage, true);
                Directory.CreateDirectory(stage);
                System.IO.Compression.ZipFile.ExtractToDirectory(zip, stage);
            }
            catch (Exception ex) { return "安装包解不开：" + ex.Message; }

            /* 包里如果套了一层"和包同名"的目录（tulan-v0.14\...），把那一层让出来，
               否则替换时会多出一层壳。只认这一个判据：按包名对齐，别拿"只有一个目录"
               当条件——增量包可能整包只有一个 web\，被误拆就会把文件摆到安装目录根上 */
            string[] dirs = Directory.GetDirectories(stage);
            string[] files = Directory.GetFiles(stage);
            string wrap = Path.GetFileNameWithoutExtension(r.Pkg);
            if (dirs.Length == 1 && files.Length == 0 &&
                string.Equals(Path.GetFileName(dirs[0]), wrap, StringComparison.OrdinalIgnoreCase))
            {
                string inner = dirs[0];
                foreach (string f in Directory.GetFiles(inner))
                    File.Move(f, Path.Combine(stage, Path.GetFileName(f)));
                foreach (string d in Directory.GetDirectories(inner))
                    Directory.Move(d, Path.Combine(stage, Path.GetFileName(d)));
                Directory.Delete(inner, true);
            }
            return null;
        }

        static string Download(string url, string to, long expectSize, Action<int> progress)
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
                req.Timeout = 20000;
                req.ReadWriteTimeout = 60000;
                req.UserAgent = "tulan-updater";
                // 包也绕开缓存：同一版本号重发过一次的情况下，缓存会给出旧包
                req.CachePolicy = new System.Net.Cache.RequestCachePolicy(
                    System.Net.Cache.RequestCacheLevel.BypassCache);
                using (HttpWebResponse res = (HttpWebResponse)req.GetResponse())
                using (Stream st = res.GetResponseStream())
                using (FileStream fs = new FileStream(to, FileMode.Create, FileAccess.Write))
                {
                    long total = res.ContentLength > 0 ? res.ContentLength : expectSize;
                    byte[] buf = new byte[65536];
                    long got = 0;
                    int n, last = -1;
                    while ((n = st.Read(buf, 0, buf.Length)) > 0)
                    {
                        fs.Write(buf, 0, n);
                        got += n;
                        if (progress != null && total > 0)
                        {
                            int pc = (int)(got * 100 / total);
                            if (pc != last) { last = pc; progress(pc); }
                        }
                    }
                    if (expectSize > 0 && got != expectSize)
                        return "下载的大小与清单写的不一致（" + got + " / " + expectSize + " 字节）";
                }
                return null;
            }
            catch (WebException ex)
            {
                HttpWebResponse he = ex.Response as HttpWebResponse;
                int code = he == null ? 0 : (int)he.StatusCode;
                return code == 404 ? "安装包还没传上去（404）" : "下载失败：" + ex.Message;
            }
            catch (Exception ex)
            {
                return "下载失败：" + ex.Message;
            }
        }

        static string Sha256File(string path)
        {
            using (var sha = System.Security.Cryptography.SHA256.Create())
            using (FileStream fs = File.OpenRead(path))
            {
                byte[] hash = sha.ComputeHash(fs);
                var sb = new StringBuilder(hash.Length * 2);
                foreach (byte b in hash) sb.Append(b.ToString("x2"));
                return sb.ToString();
            }
        }

        /* ---------- 替换 ----------
           本进程还占着 exe 与 dll，自己换不了自己：交给 TulanUpdater.exe，
           它等本进程退出后把 stage 里的文件盖过去，再启动新版。 */
        public static string Apply(Result r)
        {
            string stage = StageOf(r);
            if (!Directory.Exists(stage)) return "还没有下载好，先点一次更新";
            string exeDir = Path.GetDirectoryName(Application.ExecutablePath);
            string updater = Path.Combine(exeDir, "TulanUpdater.exe");
            if (!File.Exists(updater)) return "缺少更新组件 TulanUpdater.exe，请重新下载完整包";
            try
            {
                var psi = new ProcessStartInfo(updater);
                psi.Arguments = Process.GetCurrentProcess().Id + " \"" + stage + "\" \"" + exeDir + "\"";
                psi.UseShellExecute = false;
                psi.WorkingDirectory = exeDir;
                Process.Start(psi);
                return null;
            }
            catch (Exception ex)
            {
                return "启动更新组件失败：" + ex.Message;
            }
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
