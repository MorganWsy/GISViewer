// 图览 更新组件：把下载好的新版本盖到安装目录，再把软件拉起来。
//
// 为什么要单独一个 exe：主程序运行时会锁住 Tulan.exe 与旁边的 dll，自己换不了自己。
// 主程序把本进程叫起来之后立刻退出，这里等它退干净再动手。
//
// 用法（由主程序传，不给人手敲）：
//   TulanUpdater.exe <主程序PID> <新版本目录> <安装目录>
//
// 三条原则：
//   ① 只覆盖、不删除：包是增量包，目录里多出来的文件（用户自己的配置、缓存）保持原样。
//   ② 逐个文件重试：WebView2 的子进程会多占几百毫秒，锁着的文件等一等再试。
//   ③ 出问题留证据：每一步都写进 update.log，替换失败时能看到卡在哪个文件上。
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;

static class Program
{
    static string _log;
    static readonly List<string> Failures = new List<string>();

    [STAThread]
    static int Main(string[] args)
    {
        if (args.Length < 3) return 2;
        int pid;
        if (!int.TryParse(args[0], out pid)) return 2;
        string stage = Path.GetFullPath(args[1]);
        string target = Path.GetFullPath(args[2]);

        Directory.CreateDirectory(Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "GISViewer"));
        /* 日志放在版本目录之外：替换成功后要删掉整份暂存，日志跟着删就什么都查不到了 */
        _log = Path.Combine(Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "GISViewer"), "update.log");

        Log("=== 开始更新 ===");
        Log("等待主程序 " + pid + " 退出");
        if (!WaitExit(pid, 120000))
        {
            Log("主程序在 120 秒内没有退出，放弃这次更新");
            return 3;
        }
        Log("主程序已退出，开始替换");
        Thread.Sleep(300);   // 给 WebView2 的子进程一点收尾时间

        if (!Directory.Exists(stage))
        {
            Log("新版本目录不见了：" + stage);
            return 4;
        }

        CopyTree(stage, target);
        Log("替换完成，失败 " + Failures.Count + " 个文件");

        string exe = Path.Combine(target, "Tulan.exe");
        if (File.Exists(exe))
        {
            try
            {
                Process.Start(new ProcessStartInfo(exe) { WorkingDirectory = target });
                Log("已启动新版");
            }
            catch (Exception ex) { Log("启动新版失败：" + ex.Message); }
        }
        else
        {
            Log("安装目录里没有 Tulan.exe，请手动打开");
        }

        try
        {
            /* 有文件没盖上就留着暂存目录：下次启动还能重来，日志里也指得着具体哪个文件 */
            if (Failures.Count == 0)
            {
                Directory.Delete(Path.GetDirectoryName(stage.TrimEnd('\\')), true);
                Log("清理暂存目录完成");
            }
            else
            {
                Log("有文件没覆盖成功，暂存目录留着：" + stage);
            }
        }
        catch (Exception ex) { Log("清理暂存目录失败（不影响使用）：" + ex.Message); }
        return Failures.Count == 0 ? 0 : 1;
    }

    static bool WaitExit(int pid, int timeoutMs)
    {
        try
        {
            Process p = Process.GetProcessById(pid);
            return p.WaitForExit(timeoutMs);
        }
        catch (ArgumentException)
        {
            return true;   // 已经退了
        }
        catch (Exception ex)
        {
            Log("等待退出出错：" + ex.Message);
            return true;   // 拿不到就当它退了，别把更新卡死
        }
    }

    static void CopyTree(string from, string to)
    {
        string self = Path.GetFullPath(Process.GetCurrentProcess().MainModule.FileName);
        string[] files;
        try { files = Directory.GetFiles(from, "*", SearchOption.AllDirectories); }
        catch (Exception ex) { Log("列不出新版本文件：" + ex.Message); return; }

        int ok = 0;
        foreach (string src in files)
        {
            string rel = src.Substring(from.Length).TrimStart('\\', '/');
            string dst = Path.Combine(to, rel);
            if (string.Equals(Path.GetFullPath(dst), self, StringComparison.OrdinalIgnoreCase))
            {
                Log("跳过正在运行的更新组件自身");
                continue;
            }
            try
            {
                string dir = Path.GetDirectoryName(dst);
                if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
                CopyWithRetry(src, dst);
                ok++;
            }
            catch (Exception ex)
            {
                Failures.Add(rel);
                Log("覆盖失败 " + rel + "：" + ex.Message);
            }
        }
        Log("已覆盖 " + ok + " 个文件");
    }

    /* 被占用时等一等再试：WebView2 退出时还在写缓存，头几次 copy 会报 0x80070020 */
    static void CopyWithRetry(string src, string dst)
    {
        for (int i = 0; i < 12; i++)
        {
            try
            {
                File.Copy(src, dst, true);
                return;
            }
            catch (IOException)
            {
                Thread.Sleep(250);
            }
            catch (UnauthorizedAccessException)
            {
                Thread.Sleep(250);
            }
        }
        File.Copy(src, dst, true);   // 最后一次不再吞异常，交给上层记账
    }

    static void Log(string line)
    {
        try
        {
            File.AppendAllText(_log,
                DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + line + "\r\n",
                new UTF8Encoding(false));
        }
        catch (Exception) { /* 日志写不进去也不能影响替换 */ }
    }
}
