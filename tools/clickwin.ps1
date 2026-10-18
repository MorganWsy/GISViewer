# 真实鼠标点击：把目标窗口提到最前，然后在它客户区内的指定坐标按一次左键。
# 用来验证地图上的点选识别——浏览器不认合成事件，只能走真输入。
# 用法：pwsh -File tools/clickwin.ps1 -Proc Tulan -X 493 -Y 466
param(
  [string]$Proc = 'Tulan',
  [Parameter(Mandatory = $true)][int]$X,
  [Parameter(Mandatory = $true)][int]$Y,
  # 给的是屏幕绝对坐标时用它，不再叠加窗口左上角
  [switch]$Absolute,
  # 只把窗口提到最前，不点击（用来排除"窗口在后台被限帧"造成的画面不对）
  [switch]$RaiseOnly,
  [switch]$NoRaise
)
$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Clk {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static void Raise(IntPtr h) {
    ShowWindow(h, 9);
    BringWindowToTop(h);
    uint pid; uint tid = GetWindowThreadProcessId(h, out pid);
    uint cur = GetCurrentThreadId();
    AttachThreadInput(cur, tid, true);
    SetForegroundWindow(h);
    AttachThreadInput(cur, tid, false);
  }
  public static int[] Origin(IntPtr h) {
    RECT r; GetWindowRect(h, out r);
    return new int[] { r.Left, r.Top };
  }
}
"@

$p = Get-Process -Name $Proc -ErrorAction Stop | Sort-Object StartTime -Descending | Select-Object -First 1
if (-not $NoRaise) { [Clk]::Raise($p.MainWindowHandle); Start-Sleep -Milliseconds 400 }
if ($RaiseOnly) { Write-Output "已提到最前，没有点击"; return }
$ox = 0; $oy = 0
if (-not $Absolute) { $o = [Clk]::Origin($p.MainWindowHandle); $ox = $o[0]; $oy = $o[1] }
$sx = $ox + $X; $sy = $oy + $Y
Write-Output ("窗口 0x{0:X} pid={1} 可见={2}；点击屏幕 ({3},{4})" -f $p.MainWindowHandle.ToInt64(), $p.Id, [Clk]::IsWindowVisible($p.MainWindowHandle), $sx, $sy)
[Clk]::SetCursorPos($sx, $sy) | Out-Null
Start-Sleep -Milliseconds 250
[Clk]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 90
[Clk]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 250
Write-Output '已按下并松开左键'
