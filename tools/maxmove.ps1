# 把主窗口挪到副屏再最大化，看看它停在哪块屏、有没有滑出去
param([string]$Proc = 'Tulan', [int]$SecondaryX = 1920)
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class MM {
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int ht, uint f);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  public struct R { public int L, T, Rg, B; }
  public static string Rect(IntPtr h) {
    R r; GetWindowRect(h, out r);
    return string.Format("{0},{1} - {2},{3}（{4}）", r.L, r.T, r.Rg, r.B, IsZoomed(h) ? "已最大化" : "普通");
  }
}
"@
$p = Get-Process -Name $Proc | Sort-Object StartTime -Descending | Select-Object -First 1
$h = $p.MainWindowHandle
Write-Output ("挪到副屏之前：" + [MM]::Rect($h))
[MM]::ShowWindow($h, 9) | Out-Null                       # SW_RESTORE
[MM]::SetWindowPos($h, [IntPtr]::Zero, $SecondaryX + 200, 120, 1000, 700, 0x0040) | Out-Null
Start-Sleep -Milliseconds 600
Write-Output ("挪到副屏之后：" + [MM]::Rect($h))
[MM]::ShowWindow($h, 3) | Out-Null                       # SW_MAXIMIZE
Start-Sleep -Milliseconds 800
Write-Output ("副屏最大化之后：" + [MM]::Rect($h))
Write-Output ("副屏工作区应是 x={0} 往右" -f $SecondaryX)
[MM]::ShowWindow($h, 9) | Out-Null
