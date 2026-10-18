# 抓某个进程的窗口位图（PrintWindow + PW_RENDERFULLCONTENT，WebView2 的内容也抓得到）。
# 用法：pwsh -File tools/grabwin.ps1 -Proc Tulan -Tag native
# 探针图是排查用的临时产物，默认写到 %TEMP%，不往仓库里堆
param(
  [string]$Proc = 'Tulan',
  [string]$Tag = 'win',
  [string]$Out = (Join-Path $env:TEMP 'gisviewer-probe')
)
$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Gw {
  public delegate bool CB(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(CB c, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, int flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
Add-Type -AssemblyName System.Drawing

$pids = @(Get-Process $Proc -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
if (-not $pids) { Write-Output "PROC_NOT_RUNNING $Proc"; exit 0 }

$cand = @()
$cb = [Gw+CB] {
  param($h, $l)
  $p = [uint32]0
  [Gw]::GetWindowThreadProcessId($h, [ref]$p) | Out-Null
  if ($pids -contains [int]$p) {
    $r = New-Object Gw+RECT
    [Gw]::GetWindowRect($h, [ref]$r) | Out-Null
    $w = $r.Right - $r.Left; $hh = $r.Bottom - $r.Top
    $len = [Gw]::GetWindowTextLength($h)
    $sb = New-Object System.Text.StringBuilder ($len + 2)
    [Gw]::GetWindowText($h, $sb, $sb.Capacity) | Out-Null
    if ($w -gt 400 -and $hh -gt 300 -and [Gw]::IsWindowVisible($h)) {
      $script:cand += ,@{ H = $h; X = $r.Left; Y = $r.Top; W = $w; Ht = $hh; Title = $sb.ToString() }
    }
  }
  return $true
}
[Gw]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
if (-not $cand) { Write-Output "NO_WINDOW $Proc"; exit 0 }

$best = $cand | Sort-Object { -($_.W * $_.Ht) } | Select-Object -First 1
if ([Gw]::IsIconic([IntPtr]$best.H)) { [Gw]::ShowWindow([IntPtr]$best.H, 9) | Out-Null; Start-Sleep -Milliseconds 700 }
[Gw]::SetForegroundWindow([IntPtr]$best.H) | Out-Null
Start-Sleep -Milliseconds 700

New-Item -ItemType Directory -Force -Path $Out | Out-Null
$png = Join-Path $Out ('win-' + $Tag + '.png')
$bmp = [System.Drawing.Bitmap]::new($best.W, $best.Ht)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
$ok = [Gw]::PrintWindow([IntPtr]$best.H, $hdc, 2)
$g.ReleaseHdc($hdc); $g.Dispose()
$bmp.Save($png, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output ("win '{0}' at ({1},{2}) {3}x{4} print={5} saved={6}" -f $best.Title, $best.X, $best.Y, $best.W, $best.Ht, $ok, $png)
