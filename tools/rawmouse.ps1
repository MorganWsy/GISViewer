# 裸鼠标序列：在 A 点按下、移到 B 点停住、再移回 A 点松开。用来测接收层的轮询触发。
# 用法：pwsh -File tools/rawmouse.ps1 -DownX 100 -DownY 100 -ToX 960 -ToY 471 [-HoldMs 1500]
param(
  [int]$DownX = 100, [int]$DownY = 100,
  [int]$ToX = 960, [int]$ToY = 471,
  [int]$HoldMs = 1500
)
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class RawM {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  public static void Down() { mouse_event(0x0002, 0, 0, 0, IntPtr.Zero); }
  public static void Up() { mouse_event(0x0004, 0, 0, 0, IntPtr.Zero); }
}
"@
[RawM]::SetCursorPos($DownX, $DownY) | Out-Null
Start-Sleep -Milliseconds 300
[RawM]::Down()
Start-Sleep -Milliseconds 300
# 分几步挪过去，模拟真实移动，每一步都给轮询留出至少一个 tick
for ($i = 1; $i -le 8; $i++) {
  $x = [int]($DownX + ($ToX - $DownX) * $i / 8)
  $y = [int]($DownY + ($ToY - $DownY) * $i / 8)
  [RawM]::SetCursorPos($x, $y) | Out-Null
  Start-Sleep -Milliseconds 60
}
Start-Sleep -Milliseconds $HoldMs
[RawM]::SetCursorPos($DownX, $DownY) | Out-Null
Start-Sleep -Milliseconds 200
[RawM]::Up()
Write-Output ("按住 ({0},{1}) 经过 ({2},{3}) 再松手" -f $DownX, $DownY, $ToX, $ToY)
