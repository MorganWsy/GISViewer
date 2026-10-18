// 拖放测试的“源窗口”：按住它往别处拖，就是从另一个进程发起的真实 OLE 拖放。
// 只为验证图览窗口能不能收到文件拖放，不参与打包。
// 编译：csc /target:winexe /out:%TEMP%\dropsrc.exe tools\dropsrc.cs
using System;
using System.Drawing;
using System.Windows.Forms;

class DropSrc : Form
{
    readonly string _path;
    readonly bool _asText;

    public DropSrc(string path, bool asText)
    {
        _path = path;
        _asText = asText;
        Text = asText ? "DropSrcText" : "DropSrc";
        ClientSize = new Size(260, 140);
        BackColor = Color.FromArgb(250, 214, 96);
        Label lbl = new Label();
        lbl.Text = (asText ? "按住这里拖一段文字过去\n" : "按住这里拖到图览窗口\n") + _path;
        lbl.Dock = DockStyle.Fill;
        lbl.TextAlign = ContentAlignment.MiddleCenter;
        Controls.Add(lbl);
        MouseDown += delegate { Start(); };
        // 点在 Label 上时消息不一定冒泡到窗体，两边都接
        lbl.MouseDown += delegate { Start(); };
    }

    void Start()
    {
        Note("mouse down");
        /* text: 开头就拖一段纯文字——用来验图览的遮罩不会被非文件的拖放误亮 */
        DataObject data = _asText
            ? new DataObject(DataFormats.UnicodeText, _path)
            : new DataObject(DataFormats.FileDrop, new string[] { _path });
        DragDropEffects eff = DoDragDrop(data, DragDropEffects.Copy);
        Note("drag done " + eff);
    }

    static void Note(string s)
    {
        try
        {
            string p = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "dropsrc.log");
            System.IO.File.AppendAllText(p, DateTime.Now.ToString("HH:mm:ss.fff") + " " + s + "\r\n");
        }
        catch { }
    }

    [STAThread]
    static void Main(string[] args)
    {
        Application.EnableVisualStyles();
        string p = args.Length > 0 ? args[0] : DefaultSample();
        bool asText = p.StartsWith("text:");
        if (asText) p = p.Substring(5);
        Application.Run(new DropSrc(p, asText));
    }

    // 样例数据在源码树之外（见 PLAN §11），默认 ..\GISViewer-data\samples，可用 TULAN_DATA 覆盖
    static string DefaultSample()
    {
        string data = Environment.GetEnvironmentVariable("TULAN_DATA");
        if (string.IsNullOrEmpty(data))
            data = System.IO.Path.GetFullPath(System.IO.Path.Combine(
                AppDomain.CurrentDomain.BaseDirectory, @"..\..\..\GISViewer-data"));
        return System.IO.Path.Combine(data, "samples", "wuningGEP.json");
    }
}
