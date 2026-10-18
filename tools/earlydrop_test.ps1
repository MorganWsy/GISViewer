# 启动期拖放测试：先把拖放拉起来（鼠标已经按住并在半路上），再启动图览，
# 让它的窗口正好出现在光标底下，然后松手。用来验证"第一次打开就拖文件"这一种时机。
# 用法：pwsh -File tools/earlydrop_test.ps1 -SrcPid 1234 [-DelayMs 350]
param(
  [Parameter(Mandatory = $true)][int]$SrcPid,
  [string]$Exe = 'D:\GISViewer\dist\Tulan.exe',
  [string]$DataDir = 'C:\Users\wsy\AppData\Local\Temp\tulan-test',
  [int]$DelayMs = 350
)
$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Mz2 {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
Add-Type -AssemblyName System.Windows.Forms

$src = Get-Process -Id $SrcPid
$r = New-Object Mz2+RECT
[Mz2]::GetWindowRect($src.MainWindowHandle, [ref]$r) | Out-Null
$fromX = [int]($r.Left + ($r.Right - $r.Left) / 2)
$fromY = [int]($r.Top + ($r.Bottom - $r.Top) / 2)

# 图览是居中显示的，落点就取它将要出现的那个中心
$wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$toX = [int]($wa.Left + ($wa.Width - 1440) / 2 + 720)
$toY = [int]($wa.Top + ($wa.Height - 900) / 2 + 450)
Write-Output ("源窗口中心 ({0},{1})，图览将要出现在中心 ({2},{3})" -f $fromX, $fromY, $toX, $toY)

[Mz2]::SetCursorPos($fromX, $fromY) | Out-Null
Start-Sleep -Milliseconds 350
[Mz2]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)     # 左键按下，源窗口开始真正的 OLE 拖动
Start-Sleep -Milliseconds 450
for ($i = 1; $i -le 8; $i++) {
  [Mz2]::SetCursorPos([int]($fromX + ($toX - $fromX) * $i / 8), [int]($fromY + ($toY - $fromY) * $i / 8)) | Out-Null
  Start-Sleep -Milliseconds 60
}

$env:GISVIEWER_DATA_DIR = $DataDir
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9233'
$p = Start-Process -FilePath $Exe -PassThru
Write-Output ("图览已启动 pid={0}，等 {1} 毫秒让它把窗口显示出来" -f $p.Id, $DelayMs)
Start-Sleep -Milliseconds $DelayMs
# 轻微动一下：拖放过程中窗口是新出现的，得让系统重新认一次落点
[Mz2]::SetCursorPos($toX + 3, $toY) | Out-Null
Start-Sleep -Milliseconds 80
[Mz2]::SetCursorPos($toX - 3, $toY + 2) | Out-Null
Start-Sleep -Milliseconds 80
[Mz2]::SetCursorPos($toX, $toY) | Out-Null
Start-Sleep -Milliseconds 120
[Mz2]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 400
Write-Output ("已松手，图览 pid={0}" -f $p.Id)
