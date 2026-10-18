# 把开发用的 conda 环境做成免安装包里的 runtime。
# 直接整目录复制就能跑（python.exe 按自己所在位置找 prefix，GDAL/PROJ 路径由
# gisviewer/bootstrap.py 从 sys.prefix 推），conda-pack 反而不是必需的。
# 只把运行时用不上的东西剔掉：头文件、静态库、Perl/Tk 运行时、conda 元数据。
# 用法：pwsh -File tools/pack_runtime.ps1 [-Full]   （-Full 表示一点不删，整份复制）
param(
  [string]$Src = 'D:\miniAnaconda\envs\gisviewer',
  [string]$Dst = 'D:\GISViewer\dist\runtime',
  [switch]$Full
)
$ErrorActionPreference = 'Stop'

# 这些目录里是编译期或 Perl/Tk 绑定的东西，运行时不碰
$excludeDir = @(
  'Library\include', 'Library\cmake', 'Library\pkgconfig', 'Library\vendor',
  'Library\share\doc', 'Library\share\man', 'Library\share\zoneinfo',
  'Library\lib\pods', 'Library\lib\auto', 'Library\lib\CORE', 'Library\lib\unicore',
  'Library\lib\Unicode', 'Library\lib\tcl8.6', 'Library\lib\tk8.6', 'Library\lib\sqlite3.40.0',
  'Library\lib\perl', 'Library\lib\perlcore', 'include', 'libs', 'Tools', 'share\man',
  'conda-meta', 'Lib\site-packages\pip', 'Lib\site-packages\setuptools',
  'Lib\site-packages\wheel', 'Lib\site-packages\pkg_resources',
  'Lib\site-packages\test', 'Lib\test', 'Lib\idlelib'
)
# 静态链接库和头文件；注意 gdalplugins 要留着，格式驱动插件都在里面
$excludeFile = @('*.lib', '*.a', '*.exp')
if ($Full) { $excludeDir = @(); $excludeFile = @() }

if (Test-Path $Dst) { Remove-Item $Dst -Recurse -Force }
New-Item -ItemType Directory -Force -Path $Dst | Out-Null

$rcArgs = @($Src, $Dst, '/E', '/MT:14', '/NFL', '/NDL', '/NJH', '/NJS', '/R:1', '/W:1')
if ($excludeDir.Count) { $rcArgs += '/XD'; $rcArgs += ($excludeDir | ForEach-Object { (Join-Path $Src $_) }) }
if ($excludeFile.Count) { $rcArgs += '/XF'; $rcArgs += $excludeFile }

& robocopy @rcArgs | Out-Null
$code = $LASTEXITCODE
if ($code -ge 8) { throw "robocopy 失败，退出码 $code" }

# 缓存和字节码不带，首启动反而更快也更小
Get-ChildItem -Path $Dst -Recurse -Directory -Filter '__pycache__' | Remove-Item -Recurse -Force
$bytes = (Get-ChildItem $Dst -Recurse -File | Measure-Object -Property Length -Sum).Sum
Write-Host ("runtime 已生成：{0}  ({1:N0} MB)" -f $Dst, ($bytes / 1MB))
