# 自动化拖放测试：把 tools\dropsrc.cs 编译出的源窗口作为拖放发起方，
# 用真实鼠标输入按下去、移过去、松开，验证目标窗口能不能收到文件拖放。
# 用法：pwsh -File tools/dragdrop_test.ps1 -SrcPid 1234 -DstPid 5678
param(
  [Parameter(Mandatory = $true)][int]$SrcPid,
  [Parameter(Mandatory = $true)][int]$DstPid,
  [double]$DstFracX = 0.55,
  [double]$DstFracY = 0.45,
  # 只把文件悬到目标窗口上再收回来，不真的放下：用来验证接收器收不收得到 DragEnter
  [switch]$Hover
)
$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Mz {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  /* 硬置顶/取消置顶：BringWindowToTop 在前台锁面前会被静默拒绝，源窗口被别的窗口盖着时靠它 */
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x, y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

function Get-Rect($proc) {
  $p = Get-Process -Id $proc
  if (-not $p.MainWindowHandle -or $p.MainWindowHandle -eq 0) { throw "进程 $proc 没有主窗口" }
  $r = New-Object Mz+RECT
  [Mz]::GetWindowRect($p.MainWindowHandle, [ref]$r) | Out-Null
  if ($r.Right - $r.Left -lt 50) { throw "进程 $proc 的窗口太小，可能还没显示" }
  @{ H = $p.MainWindowHandle; L = $r.Left; T = $r.Top; W = $r.Right - $r.Left; Ht = $r.Bottom - $r.Top; Title = $p.MainWindowTitle }
}

$src = Get-Rect $SrcPid
$dst = Get-Rect $DstPid
$fromX = [int]($src.L + $src.W / 2); $fromY = [int]($src.T + $src.Ht / 2)
$toX = [int]($dst.L + $dst.W * $DstFracX); $toY = [int]($dst.T + $dst.Ht * $DstFracY)
Write-Output ("源 '{0}' 在 ({1},{2}) {3}x{4}" -f $src.Title, $src.L, $src.T, $src.W, $src.Ht)
Write-Output ("目标 '{0}' 在 ({1},{2}) {3}x{4}" -f $dst.Title, $dst.L, $dst.T, $dst.W, $dst.Ht)
Write-Output ("拖动 ({0},{1}) -> ({2},{3})" -f $fromX, $fromY, $toX, $toY)

# 目标窗口要先到最前：它被别的窗口盖着的话，拖过去落在别的窗口上，等于没测
[Mz]::ShowWindow($dst.H, 9) | Out-Null
[Mz]::BringWindowToTop($dst.H) | Out-Null
[Mz]::SetForegroundWindow($dst.H) | Out-Null
Start-Sleep -Milliseconds 500
$under = New-Object Mz+POINT
$under.x = $toX; $under.y = $toY
$uh = [Mz]::WindowFromPoint($under)
$uc = New-Object System.Text.StringBuilder 200
[Mz]::GetClassName($uh, $uc, $uc.Capacity) | Out-Null
Write-Output ("落点处的窗口：0x{0} class='{1}'" -f $uh.ToString("X"), $uc.ToString())

# 源窗口必须露在最上面才收得到按下的那一下，否则拖动根本不会发起。
# 用户的浏览器等窗口经常正好盖着它，而 BringWindowToTop 在后台进程里会被前台锁拒绝（静默失败），
# 所以这里用 TOPMOST 硬置顶，并按进程号验证按下点归属，盖错了当场警告。
[Mz]::SetWindowPos($src.H, [IntPtr](-1), 0, 0, 0, 0, 0x0001 -bor 0x0002 -bor 0x0010) | Out-Null
Start-Sleep -Milliseconds 300
$spt = New-Object Mz+POINT
$spt.x = $fromX; $spt.y = $fromY
$spid = 0
[Mz]::GetWindowThreadProcessId([Mz]::WindowFromPoint($spt), [ref]$spid) | Out-Null
if ($spid -ne $SrcPid) {
  Write-Output ("警告：按下点被 pid={0} 的窗口盖着（源进程 {1}），拖动可能发不出去" -f $spid, $SrcPid)
}

[Mz]::SetCursorPos($fromX, $fromY) | Out-Null
Start-Sleep -Milliseconds 350
# 左键按下：源窗口的 MouseDown 会开始真正的 OLE 拖动
[Mz]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 500
$steps = 14
for ($i = 1; $i -le $steps; $i++) {
  $x = [int]($fromX + ($toX - $fromX) * $i / $steps)
  $y = [int]($fromY + ($toY - $fromY) * $i / $steps)
  [Mz]::SetCursorPos($x, $y) | Out-Null
  Start-Sleep -Milliseconds 70
}
Start-Sleep -Milliseconds 400
if ($Hover) {
  # 悬停模式：在目标上停一会儿，让它的 DragEnter/DragOver 都走一遍，然后收回源窗口再松手
  Start-Sleep -Milliseconds 900
  for ($i = $steps - 1; $i -ge 0; $i--) {
    $x = [int]($fromX + ($toX - $fromX) * $i / $steps)
    $y = [int]($fromY + ($toY - $fromY) * $i / $steps)
    [Mz]::SetCursorPos($x, $y) | Out-Null
    Start-Sleep -Milliseconds 50
  }
  Start-Sleep -Milliseconds 300
  [Mz]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
  # 测完收掉置顶，别让测试窗口一直压着别的窗口
  [Mz]::SetWindowPos($src.H, [IntPtr](-2), 0, 0, 0, 0, 0x0001 -bor 0x0002 -bor 0x0010) | Out-Null
  Start-Sleep -Milliseconds 300
  Write-Output "已收回源窗口并松开左键（没有放下）"
  return
}
[Mz]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
# 测完收掉置顶，别让测试窗口一直压着别的窗口
[Mz]::SetWindowPos($src.H, [IntPtr](-2), 0, 0, 0, 0, 0x0001 -bor 0x0002 -bor 0x0010) | Out-Null
Start-Sleep -Milliseconds 300
Write-Output "已松开左键"
