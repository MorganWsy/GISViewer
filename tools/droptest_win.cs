// 对照用的"最朴素接收窗口"：一个 AllowDrop 的 WinForms 窗体，把拖放的每一步写进日志。
// 用来分清是"资源管理器发起的拖放本身没起来"，还是"图览的窗口收不到"。
// 编译：csc /target:winexe /out:%TEMP%\droptest.exe tools\droptest_win.cs
using System;
using System.Drawing;
using System.Windows.Forms;

class DropTest : Form
{
    public DropTest()
    {
        Text = "DropTest";
        ClientSize = new Size(420, 300);
        BackColor = Color.FromArgb(190, 225, 190);
        AllowDrop = true;
        Label lbl = new Label();
        lbl.Text = "把文件从资源管理器拖到这里";
        lbl.Dock = DockStyle.Fill;
        lbl.TextAlign = ContentAlignment.MiddleCenter;
        Controls.Add(lbl);
        DragEnter += delegate(object s, DragEventArgs e)
        {
            bool files = e.Data.GetDataPresent(DataFormats.FileDrop);
            e.Effect = files ? DragDropEffects.Copy : DragDropEffects.None;
            Note("dragenter files=" + files);
        };
        DragDrop += delegate(object s, DragEventArgs e)
        {
            string[] p = e.Data.GetData(DataFormats.FileDrop) as string[];
            Note("drop " + (p == null ? "null" : p.Length + " 项 " + p[0]));
        };
        DragLeave += delegate { Note("dragleave"); };
    }

    static void Note(string s)
    {
        try
        {
            string path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "droptest.log");
            System.IO.File.AppendAllText(path, DateTime.Now.ToString("HH:mm:ss.fff") + " " + s + "\r\n");
        }
        catch { }
    }

    [STAThread]
    static void Main()
    {
        Application.EnableVisualStyles();
        Application.Run(new DropTest());
    }
}
