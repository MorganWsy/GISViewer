# 从 logo.png 出一个四角透明的 tulan.ico。
# 桌面快捷方式上显白角是原图的白色底：这里从四角往里灌水，只把外圈白底变透明，
# 图形内部的白色（地球、放大镜的高光）不动。
# 用法：pwsh -File tools/make_icon.ps1
param(
  [string]$Source = (Join-Path $PSScriptRoot '..\shell\logo.png'),
  [string]$Dest = (Join-Path $PSScriptRoot '..\shell\tulan.ico'),
  [int]$Tolerance = 232
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$srcPath = (Resolve-Path $Source).Path
$img = [System.Drawing.Bitmap]::FromFile($srcPath)
$w = $img.Width; $h = $img.Height
$bmp = New-Object System.Drawing.Bitmap -ArgumentList ([int]$w), ([int]$h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.DrawImage($img, 0, 0, $w, $h)
$g.Dispose(); $img.Dispose()

$stack = New-Object System.Collections.Stack
$stack.Push(@(0, 0))
$stack.Push(@(($w - 1), 0))
$stack.Push(@(0, ($h - 1)))
$stack.Push(@(($w - 1), ($h - 1)))
$seen = New-Object 'bool[,]' $w, $h
$clear = [System.Drawing.Color]::FromArgb(0, 255, 255, 255)
while ($stack.Count -gt 0) {
  $pt = $stack.Pop(); $x = [int]($pt[0]); $y = [int]($pt[1])
  if ($x -lt 0 -or $y -lt 0 -or $x -ge $w -or $y -ge $h) { continue }
  if ($seen[$x, $y]) { continue }
  $seen[$x, $y] = $true
  $c = $bmp.GetPixel($x, $y)
  if ($c.A -lt 8) { continue }
  if ($c.R -lt $Tolerance -or $c.G -lt $Tolerance -or $c.B -lt $Tolerance) { continue }
  $bmp.SetPixel($x, $y, $clear)
  $stack.Push(@(($x + 1), $y)); $stack.Push(@(($x - 1), $y))
  $stack.Push(@($x, ($y + 1))); $stack.Push(@($x, ($y - 1)))
}

$sizes = 16, 24, 32, 48, 64, 128, 256
$frames = @()
foreach ($s in $sizes) {
  $b = New-Object System.Drawing.Bitmap -ArgumentList ([int]$s), ([int]$s)
  $g2 = [System.Drawing.Graphics]::FromImage($b)
  $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g2.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g2.Clear([System.Drawing.Color]::Transparent)
  $g2.DrawImage($bmp, 0, 0, $s, $s)
  $g2.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $b.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $frames += @{ size = $s; bytes = $ms.ToArray() }
  $b.Dispose(); $ms.Dispose()
}
$bmp.Dispose()

$fs = [System.IO.File]::Create($Dest)
$bw = New-Object System.IO.BinaryWriter($fs)
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$frames.Count)
$offset = 6 + 16 * $frames.Count
foreach ($f in $frames) {
  $dim = if ($f.size -ge 256) { 0 } else { $f.size }
  $bw.Write([byte]$dim); $bw.Write([byte]$dim)
  $bw.Write([byte]0); $bw.Write([byte]0)
  $bw.Write([uint16]1); $bw.Write([uint16]32)
  $bw.Write([uint32]$f.bytes.Length); $bw.Write([uint32]$offset)
  $offset += $f.bytes.Length
}
foreach ($f in $frames) { $bw.Write($f.bytes) }
$bw.Flush(); $bw.Close(); $fs.Close()

$ico = New-Object System.Drawing.Icon($Dest)
$chk = $ico.ToBitmap()
Write-Output ("已生成 {0}，{1} 个尺寸；{2}x{3} 帧角点 A={4}" -f $Dest, $sizes.Count,
  $chk.Width, $chk.Height, $chk.GetPixel(0, 0).A)
$chk.Dispose(); $ico.Dispose()
