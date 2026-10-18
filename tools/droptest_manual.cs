// 对照实验：一个"不许用 WinForms 自己的拖放"的窗口，只挂图览那套手写 RegisterDragDrop。
// 用来判定：手写注册的接收器，外部拖放（资源管理器）到底能不能调进来。
// 编译：csc /target:winexe /out:%TEMP%\droptest_manual.exe tools\droptest_manual.cs
using System;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;

class DropTestManual : Form
{
    [StructLayout(LayoutKind.Sequential)]
    public struct POINTL { public int x; public int y; }

    [ComImport, Guid("00000122-0000-0000-C000-000000000046"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IDropTarget
    {
        void DragEnter([MarshalAs(UnmanagedType.Interface)] System.Windows.Forms.IDataObject data,
                       uint keys, POINTL pt, ref uint effect);
        void DragOver(uint keys, POINTL pt, ref uint effect);
        void DragLeave();
        void Drop([MarshalAs(UnmanagedType.Interface)] System.Windows.Forms.IDataObject data,
                  uint keys, POINTL pt, ref uint effect);
    }

    [DllImport("ole32.dll")] static extern int RegisterDragDrop(IntPtr hwnd, IDropTarget target);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetProp(IntPtr h, string n);

    const uint DROPEFFECT_COPY = 1, DROPEFFECT_NONE = 0;

    sealed class Target : IDropTarget
    {
        static readonly string LogPath = Path.Combine(Path.GetTempPath(), "droptest_manual.log");
        public static void Note(string s)
        {
            try { File.AppendAllText(LogPath, DateTime.Now.ToString("HH:mm:ss.fff ") + s + "\r\n"); }
            catch { }
        }
        static bool HasFiles(System.Windows.Forms.IDataObject d)
        {
            if (d == null) return false;
            try { return d.GetDataPresent(DataFormats.FileDrop); } catch { return false; }
        }
        public void DragEnter(System.Windows.Forms.IDataObject data, uint keys, POINTL pt, ref uint effect)
        {
            bool files = HasFiles(data);
            Note(files ? "拖放进来 files=True" : "拖放进来 files=False");
            effect = files ? DROPEFFECT_COPY : DROPEFFECT_NONE;
        }
        public void DragOver(uint keys, POINTL pt, ref uint effect)
        {
            if (effect != DROPEFFECT_NONE) effect = DROPEFFECT_COPY;
        }
        public void DragLeave() { Note("离开了"); }
        public void Drop(System.Windows.Forms.IDataObject data, uint keys, POINTL pt, ref uint effect)
        {
            string[] paths = null;
            try { paths = data.GetData(DataFormats.FileDrop) as string[]; } catch { }
            Note("松手 " + (paths == null || paths.Length == 0 ? "没取到路径" : paths.Length + " 项 " + paths[0]));
            effect = DROPEFFECT_COPY;
        }
    }

    static Target _t;   // 别让 GC 收了

    public DropTestManual()
    {
        Text = "DropTestManual";
        ClientSize = new Size(420, 300);
        BackColor = Color.FromArgb(225, 210, 190);
        Label lbl = new Label();
        lbl.Text = "手写注册的接收窗口";
        lbl.Dock = DockStyle.Fill;
        lbl.TextAlign = ContentAlignment.MiddleCenter;
        Controls.Add(lbl);
        /* 再加一条对照：WinForms 自己那套 AllowDrop 注册，窗口带透明度（层叠窗口），
           看它收不收得到资源管理器的拖放——正式的"松开打开"遮罩要按这个配 */
        AllowDrop = true;
        Opacity = 0.75;
        DragEnter += delegate(object s, DragEventArgs e)
        {
            bool files = e.Data.GetDataPresent(DataFormats.FileDrop);
            e.Effect = files ? DragDropEffects.Copy : DragDropEffects.None;
            Target.Note("WinForms拖放进来 files=" + files);
        };
        DragDrop += delegate(object s, DragEventArgs e)
        {
            string[] p = e.Data.GetData(DataFormats.FileDrop) as string[];
            Target.Note("WinForms松手 " + (p == null ? "null" : p.Length + " 项 " + p[0]));
        };
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        _t = new Target();
        int hr = RegisterDragDrop(Handle, _t);
        IntPtr prop = GetProp(Handle, "OleDropTargetInterface");
        Target.Note("注册结果 hr=0x" + hr.ToString("X") + " 属性=0x" + prop.ToString("X"));
    }

    [STAThread]
    static void Main()
    {
        /* 先让 OLE 在这条线程上就绪：没初始化时 RegisterDragDrop 会返回
           0x8007000E（内存不足），注册根本挂不上。图览里是 WebView2 初始化
           顺手把 OLE 带起来的，这个探针没别的东西可用，得自己来 */
        Application.OleRequired();
        Application.Run(new DropTestManual());
    }
}
