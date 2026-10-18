# 用真正的资源管理器发起一次文件拖放：开一个选中了目标文件的资源管理器窗口，
# 用真实鼠标从文件项上按下、移到目标窗口上、松开。用来复现"从资源管理器拖进来没反应"。
# 用法：pwsh -File tools/explorer_drag.ps1 -Proc Tulan [-File D:\...\x.json] [-DstFracX 0.5] [-DstFracY 0.45]
param(
  [string]$Proc = 'Tulan',
  # 样例数据在源码树之外（见 PLAN §11），默认 ..\GISViewer-data\samples，可用 TULAN_DATA 覆盖
  [string]$Data = $(if ($env:TULAN_DATA) { $env:TULAN_DATA } else { Join-Path (Split-Path $PSScriptRoot -Parent) 'GISViewer-data' }),
  [string]$File = '',
  [double]$DstFracX = 0.5,
  [double]$DstFracY = 0.45,
  # 资源管理器窗口放到哪块屏（屏幕左边界坐标），默认副屏
  [int]$ExplorerX = 1920,
  # 把资源管理器窗口压在目标窗口上面（只盖左半边），落点选在目标窗口露出来的右半边：
  # 复现"软件被资源管理器盖住一点就拖不进来"那种情况
  [switch]$Overlap
)
$ErrorActionPreference = 'Stop'
if (-not $File) { $File = Join-Path $Data 'samples\wuningGEP.json' }
# /select 只认反斜杠路径；从 Git Bash 传进来的正斜杠要换回来
$File = $File -replace '/', '\'

Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class Ex {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int ht, uint fl);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  public delegate int EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f);
  /* 那个点在屏幕上最上面的窗口是不是样本窗口($eh)本身；被别的窗口盖着拖放就会落空 */
  public static bool OnTopOf(IntPtr eh, int x, int y) {
    POINT p; p.X = x; p.Y = y;
    IntPtr hit = WindowFromPoint(p);
    return hit != IntPtr.Zero && GetAncestor(hit, 2) == eh;   // 2 = GA_ROOT
  }
  public static void Raise(IntPtr h) {
    ShowWindow(h, 9);
    BringWindowToTop(h);
    uint pid; uint tid = GetWindowThreadProcessId(h, out pid);
    uint cur = GetCurrentThreadId();
    AttachThreadInput(cur, tid, true);
    SetForegroundWindow(h);
    AttachThreadInput(cur, tid, false);
  }
  /* 资源管理器的所有窗口都挂在同一个 explorer 进程上，只能按窗口类名和标题找 */
  public static List<IntPtr> ExplorerWindows(string titlePart) {
    List<IntPtr> found = new List<IntPtr>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      StringBuilder c = new StringBuilder(128);
      GetClassName(h, c, c.Capacity);
      if (c.ToString() != "CabinetWClass") return 1;
      StringBuilder t = new StringBuilder(300);
      GetWindowText(h, t, t.Capacity);
      if (titlePart.Length == 0 || t.ToString().IndexOf(titlePart, StringComparison.OrdinalIgnoreCase) >= 0)
        found.Add(h);
      return 1;
    }, IntPtr.Zero);
    return found;
  }
}
"@
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$dst = Get-Process -Name $Proc -ErrorAction Stop | Sort-Object StartTime -Descending | Select-Object -First 1
$leaf = Split-Path $File -Leaf
$stem = [System.IO.Path]::GetFileNameWithoutExtension($File)

# 开一个选中了该文件的资源管理器窗口，并挪到指定的屏上
$folder = Split-Path (Split-Path $File -Parent) -Leaf
Start-Process explorer.exe -ArgumentList ('/select,"' + $File + '"')
Start-Sleep -Seconds 5
$wins = [Ex]::ExplorerWindows($folder)
if ($wins.Count -eq 0) { throw "没找到标题含 '$folder' 的资源管理器窗口" }
$eh = $wins[$wins.Count - 1]

# 目标窗口的位置：压过去也好、算落点也好，都按客户区实际矩形来
$dr0 = New-Object Ex+RECT
[Ex]::GetWindowRect($dst.MainWindowHandle, [ref]$dr0) | Out-Null
$ew = 900; $ehh = 900; $exx = $ExplorerX; $exy = 0
if ($Overlap) {
  # 盖住目标窗口左半边，留右半边露着——落点就选在那块露着的区域
  $ew = [int](($dr0.Right - $dr0.Left) * 0.5)
  $ehh = [int](($dr0.Bottom - $dr0.Top) * 0.9)
  $exx = $dr0.Left + 16
  $exy = $dr0.Top + 16
}
[Ex]::SetWindowPos($eh, [IntPtr]::Zero, $exx, $exy, $ew, $ehh, 0x0040) | Out-Null
[Ex]::Raise($eh)
Start-Sleep -Milliseconds 800

# 用 UI 自动化找到那个文件项在屏幕上的位置；同名的旧窗口可能还在，逐个找
$listCond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::ListItem)
$root = $null
$item = $null
$seen = @()
foreach ($w in @([Ex]::ExplorerWindows($folder))[-1..0]) {
  [Ex]::SetWindowPos($w, [IntPtr]::Zero, $exx, $exy, $ew, $ehh, 0x0040) | Out-Null
  [Ex]::Raise($w)
  Start-Sleep -Milliseconds 700
  $r = [System.Windows.Automation.AutomationElement]::FromHandle($w)
  # 列表是虚拟化的，没滚到视野里的项在 UI 自动化里不存在，得一边翻一边找
  $list = $r.FindFirst([System.Windows.Automation.TreeScope]::Descendants,
    (New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::List)))
  for ($k = 0; $k -lt 14; $k++) {
    $its = $r.FindAll([System.Windows.Automation.TreeScope]::Descendants, $listCond)
    foreach ($it in $its) {
      $seen += $it.Current.Name
      if ($it.Current.Name -like ("*" + $stem + "*")) { $item = $it; $root = $r; $eh = $w; break }
    }
    if ($item) { break }
    if (-not $list) { break }
    try {
      $vp = $list.GetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern)
      $pct = $vp.Current.VerticalScrollPercent
      if ($pct -ge 99.9) { break }
      $vp.SetScrollPercent(-1, [Math]::Min(100, $pct + 25))
      Start-Sleep -Milliseconds 400
    } catch { break }
  }
  if ($item) { break }
}
if (-not $item) { throw "资源管理器里没找到 $leaf，看到的列表项：" + ($seen -join ' / ') }
# 虚拟化的列表里，没真正露到屏幕上的项，UI 自动化给的坐标是错的（实测会把最后一行报成第一行）。
# 把列表滚到底、等这一屏刷新后，用名字重新找一遍，拿到的坐标才可信
if ($list) {
  try {
    $vp2 = $list.GetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern)
    $vp2.SetScrollPercent(-1, 100)
    Start-Sleep -Milliseconds 600
  } catch { }
  $its2 = ([System.Windows.Automation.AutomationElement]::FromHandle($eh)).FindAll(
    [System.Windows.Automation.TreeScope]::Descendants, $listCond)
  foreach ($it in $its2) {
    if ($it.Current.Name -like ("*" + $stem + "*")) { $item = $it; break }
  }
}
try {
  $sp = $item.GetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern)
  $sp.ScrollIntoView()
  Start-Sleep -Milliseconds 500
} catch { }
$wr = New-Object Ex+RECT
[Ex]::GetWindowRect($eh, [ref]$wr) | Out-Null
$rect = $item.Current.BoundingRectangle
if ($rect.IsEmpty) { throw "文件项不在可见区域，拿不到屏幕坐标" }
if ($rect.Height -lt 8 -or $rect.Top -lt $wr.Top -or $rect.Bottom -gt $wr.Bottom) {
  throw ("UI 自动化给的坐标不可信：'{0}' rect={1},{2} {3}x{4}，窗口 {5},{6}-{7},{8}" -f `
    $item.Current.Name, $rect.X, $rect.Y, $rect.Width, $rect.Height, $wr.Left, $wr.Top, $wr.Right, $wr.Bottom)
}
$fromX = [int]($rect.X + $rect.Width / 2)
$fromY = [int]($rect.Y + $rect.Height / 2)

# 按下之前核对：那个点最上面的窗口得是资源管理器窗口本身，被"下载"之类盖着就白拖
for ($t = 0; $t -lt 3; $t++) {
  if ([Ex]::OnTopOf($eh, $fromX, $fromY)) { break }
  [Ex]::Raise($eh)
  Start-Sleep -Milliseconds 700
}
if (-not [Ex]::OnTopOf($eh, $fromX, $fromY)) { throw "($fromX,$fromY) 上盖着别的窗口，拖放落点会错" }

$dr = New-Object Ex+RECT
[Ex]::GetWindowRect($dst.MainWindowHandle, [ref]$dr) | Out-Null
if ($Overlap) {
  # 压在上面的时候只能落在露出来的右半边
  $toX = [int]($dr.Right - ($dr.Right - $dr.Left) * 0.12)
  $toY = [int]($dr.Top + ($dr.Bottom - $dr.Top) * 0.5)
} else {
  $toX = [int]($dr.Left + ($dr.Right - $dr.Left) * $DstFracX)
  $toY = [int]($dr.Top + ($dr.Bottom - $dr.Top) * $DstFracY)
}
Write-Output ("文件项 '{0}' 在 ({1},{2})；目标 {3} 落点 ({4},{5})，目标窗口 ({6},{7})-({8},{9})" -f `
  $item.Current.Name, $fromX, $fromY, $Proc, $toX, $toY, $dr.Left, $dr.Top, $dr.Right, $dr.Bottom)

if (-not $Overlap) { [Ex]::Raise($dst.MainWindowHandle) }   # 压着测的时候别把目标窗口提到资源管理器上面
Start-Sleep -Milliseconds 400
[Ex]::SetCursorPos($fromX, $fromY) | Out-Null
Start-Sleep -Milliseconds 400
[Ex]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 500
for ($i = 1; $i -le 16; $i++) {
  [Ex]::SetCursorPos([int]($fromX + ($toX - $fromX) * $i / 16), [int]($fromY + ($toY - $fromY) * $i / 16)) | Out-Null
  Start-Sleep -Milliseconds 70
}
Start-Sleep -Milliseconds 500
[Ex]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 400
Write-Output '已从资源管理器拖过去并松开左键'
