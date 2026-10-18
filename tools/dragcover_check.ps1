# 拖放期间"谁盖住谁"的实测：把图览最大化，旁边压一个资源管理器窗口，
# 然后从 dropsrc 拖一个文件悬在图览上不放，中途用 WindowFromPoint 逐点问：
#   - 图览露出来的那块 → 应该是我们自己的接收层（说明还接得住拖放）
#   - 资源管理器压住的那块 → 应该是资源管理器的窗口（说明接收层没有骑到别人头上）
# 用法：pwsh -File tools/dragcover_check.ps1 [-Proc Tulan]
param(
  [string]$Proc = 'Tulan',
  # 样例数据在源码树之外（见 PLAN §11），默认 ..\GISViewer-data\samples，可用 TULAN_DATA 覆盖
  [string]$Data = $(if ($env:TULAN_DATA) { $env:TULAN_DATA } else { Join-Path (Split-Path $PSScriptRoot -Parent) 'GISViewer-data' }),
  [string]$File = '',
  [string]$Folder = ''
)
if (-not $File) { $File = Join-Path $Data 'samples\wuningGEP.json' }
if (-not $Folder) { $Folder = Join-Path $Data 'samples' }
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class Dc {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int ht, uint fl);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(PT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  public delegate int EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct PT { public int X; public int Y; }

  public static string Cls(IntPtr h) { StringBuilder s = new StringBuilder(160); GetClassName(h, s, s.Capacity); return s.ToString(); }
  public static string Title(IntPtr h) { StringBuilder s = new StringBuilder(300); GetWindowText(h, s, s.Capacity); return s.ToString(); }
  public static IntPtr Hit(int x, int y) { PT p = new PT(); p.X = x; p.Y = y; return WindowFromPoint(p); }
  public static IntPtr Root(int x, int y) { return GetAncestor(Hit(x, y), 2); }

  /* 某个进程名下所有顶层窗口（接收层也是顶层窗口，只是没有任务栏按钮） */
  public static List<IntPtr> TopWindows(uint pid) {
    List<IntPtr> found = new List<IntPtr>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p == pid && IsWindowVisible(h)) found.Add(h);
      return 1;
    }, IntPtr.Zero);
    return found;
  }
}
"@
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$dst = Get-Process -Name $Proc -ErrorAction Stop | Sort-Object StartTime -Descending | Select-Object -First 1
$mh = $dst.MainWindowHandle

# 1) 图览最大化，铺满整屏，这样"遮挡别家窗口"最容易暴露
[void][Dc]::ShowWindow($mh, 3)
Start-Sleep -Milliseconds 700
$r = New-Object Dc+RECT
[void][Dc]::GetWindowRect($mh, [ref]$r)
Write-Output ("图览最大化后 " + $r.Left + "," + $r.Top + "-" + $r.Right + "," + $r.Bottom)

# 2) 开一个资源管理器窗口压在图览左半边上面
Start-Process explorer.exe -ArgumentList ('/select,"' + ($File -replace '/', '\') + '"')
Start-Sleep -Seconds 4
$ew = [IntPtr]::Zero
$root = [System.Windows.Automation.AutomationElement]::RootElement
foreach ($k in $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
  if ($k.Current.ClassName -eq 'CabinetWClass') { $ew = $k.Current.NativeWindowHandle; break }
}
if ($ew -eq [IntPtr]::Zero) { throw "没找到资源管理器窗口" }
$ew = [IntPtr]$ew
$w = [int](($r.Right - $r.Left) * 0.42)
[void][Dc]::SetWindowPos($ew, [IntPtr]::Zero, $r.Left + 30, $r.Top + 60, $w, 700, 0x0040)
[void][Dc]::BringWindowToTop($ew)
Start-Sleep -Milliseconds 500
$er = New-Object Dc+RECT
[void][Dc]::GetWindowRect($ew, [ref]$er)
Write-Output ("资源管理器压在它上面 " + $er.Left + "," + $er.Top + "-" + $er.Right + "," + $er.Bottom)

# 3) 起拖放源，按住拖到图览露出来的右半边，悬着不放，中途逐点问命中
$src = Start-Process -FilePath "$env:TEMP\dropsrc.exe" -ArgumentList $File -PassThru
Start-Sleep -Seconds 2
$sr = New-Object Dc+RECT
[void][Dc]::GetWindowRect($src.MainWindowHandle, [ref]$sr)
$fx = [int]($sr.Left + ($sr.Right - $sr.Left) / 2)
$fy = [int]($sr.Top + ($sr.Bottom - $sr.Top) / 2)
$tx = [int]($r.Right - ($r.Right - $r.Left) * 0.12)
$ty = [int]($r.Top + ($r.Bottom - $r.Top) * 0.5)

[void][Dc]::SetCursorPos($fx, $fy); Start-Sleep -Milliseconds 300
[Dc]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
for ($i = 1; $i -le 12; $i++) {
  [void][Dc]::SetCursorPos([int]($fx + ($tx - $fx) * $i / 12), [int]($fy + ($ty - $fy) * $i / 12))
  Start-Sleep -Milliseconds 60
}
Start-Sleep -Milliseconds 900
$mine = [Dc]::Root($tx, $ty)
$overExplorer = [Dc]::Root([int](($er.Left + $er.Right) / 2), [int]($er.Top + 40))
Write-Output ("落点 (" + $tx + "," + $ty + ") 最上面：" + [Dc]::Cls($mine) + " 属于本进程=" + ($mine -eq $mh))
Write-Output ("资源管理器那块 (" + [int](($er.Left + $er.Right) / 2) + "," + ($er.Top + 40) + ") 最上面：" + [Dc]::Cls($overExplorer) + " 是资源管理器=" + ($overExplorer -eq $ew))
foreach ($h in [Dc]::TopWindows([uint32]$dst.Id)) {
  if ($h -eq $mh) { continue }
  $vr = New-Object Dc+RECT
  [void][Dc]::GetWindowRect($h, [ref]$vr)
  Write-Output ("  接收层窗口 " + [Dc]::Cls($h) + " " + $vr.Left + "," + $vr.Top + "-" + $vr.Right + "," + $vr.Bottom)
}
[Dc]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 400
Stop-Process -Id $src.Id -Force -ErrorAction SilentlyContinue
