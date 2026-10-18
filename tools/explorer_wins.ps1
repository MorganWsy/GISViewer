# 列出当前所有资源管理器窗口（类名 CabinetWClass）的标题与位置；可选先 /select 一个文件
# -Close：把标题含 -Title 的资源管理器窗口全关掉（堆积的旧窗口会让自动化点到错的地方）
param([string]$Select = '', [string]$Close = '')
if ($Close) {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class ExClose {
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, int m, IntPtr w, IntPtr l);
  public delegate int P(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(P cb, IntPtr l);
  public static int Close(string part) {
    int n = 0;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      StringBuilder c = new StringBuilder(128); GetClassName(h, c, 128);
      if (c.ToString() != "CabinetWClass") return 1;
      StringBuilder t = new StringBuilder(300); GetWindowText(h, t, 300);
      if (t.ToString().IndexOf(part, StringComparison.OrdinalIgnoreCase) < 0) return 1;
      SendMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero);   // WM_CLOSE
      n++;
      return 1;
    }, IntPtr.Zero);
    return n;
  }
}
"@
  $closed = [ExClose]::Close($Close)
  Write-Output "关掉 $closed 个含 '$Close' 的资源管理器窗口"
  Start-Sleep -Seconds 1
}
if ($Select) { Start-Process explorer.exe -ArgumentList ('/select,"' + $Select + '"'); Start-Sleep -Seconds 4 }
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class ExWinProbe {
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  public delegate int P(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(P cb, IntPtr l);
  public struct R { public int L,T,Rg,B; }
  public static List<string> All() {
    List<string> o = new List<string>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      StringBuilder c = new StringBuilder(128); GetClassName(h, c, 128);
      if (c.ToString() != "CabinetWClass") return 1;
      StringBuilder t = new StringBuilder(300); GetWindowText(h, t, 300);
      R r; GetWindowRect(h, out r);
      o.Add(string.Format("[{0}] {1},{2}-{3},{4}", t.ToString(), r.L, r.T, r.Rg, r.B));
      return 1;
    }, IntPtr.Zero);
    return o;
  }
}
"@
[ExWinProbe]::All()
