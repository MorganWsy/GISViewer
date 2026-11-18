# 把开发用的 conda 环境做成免安装包里的 runtime。
# 直接整目录复制就能跑（python.exe 按自己所在位置找 prefix，GDAL/PROJ 路径由
# gisviewer/bootstrap.py 从 sys.prefix 推），conda-pack 反而不是必需的。
# 只把运行时用不上的东西剔掉：头文件、静态库、调试符号、Perl/Tk 运行时、conda 元数据。
# 用法：pwsh -File tools/pack_runtime.ps1 [-Full]   （-Full 表示一点不删，整份复制）
param(
  [string]$Src = 'D:\miniAnaconda\envs\gisviewer',
  [string]$Dst = 'D:\GISViewer\app\runtime',
  [switch]$Full
)
$ErrorActionPreference = 'Stop'

# 这些目录里是编译期或 Perl/Tk 绑定的东西，运行时不碰
$excludeDir = @(
  'Library\include', 'Library\cmake', 'Library\pkgconfig', 'Library\vendor',
  # 用不上的 Python 包：pyogrio 全项目没有一处 import；rasterio 要留（栅格统计、切片、重投影在用）；
  # tkinter 只有另装界面才用得上
  'Lib\site-packages\pyogrio',
  'Lib\site-packages\pyogrio-0.11.0.dist-info',
  # osgeo_utils 是 GDAL 的命令行小工具，snuggs 只有 rasterio 的表达式解析才用
  'Lib\site-packages\osgeo_utils', 'Lib\site-packages\snuggs',
  'Lib\site-packages\snuggs-1.4.7.dist-info',
  'Lib\ensurepip', 'Lib\tkinter',
  # Perl / CGI 的零碎
  'Library\mod', 'Library\libexec', 'Library\perl_licenses',
  'Library\share\bash-completion', 'Library\share\info', 'Library\share\examples',
  'Library\share\doc', 'Library\share\man', 'Library\share\zoneinfo',
  'Library\lib\pods', 'Library\lib\auto', 'Library\lib\CORE', 'Library\lib\unicore',
  'Library\lib\Unicode', 'Library\lib\tcl8.6', 'Library\lib\tk8.6', 'Library\lib\sqlite3.40.0',
  'Library\lib\perl', 'Library\lib\perlcore', 'include', 'libs', 'Tools', 'share\man',
  'conda-meta', 'Lib\site-packages\pip', 'Lib\site-packages\setuptools',
  'Lib\site-packages\wheel', 'Lib\site-packages\pkg_resources',
  'Lib\site-packages\test', 'Lib\test', 'Lib\idlelib'
)
# 静态链接库和头文件；注意 gdalplugins 要留着，格式驱动插件都在里面
# 调试符号占 52 MB（libcrypto 24.5、python312 17、libssl 5.7、openssl 3.8），运行时不读；
# tcl/tk 的两个 dll 与 _tkinter 一起删，tkinter 目录已经不带了
# icu*（不带 78 的旧版）是 spatialite 那一代用的，78 系列不能动：
# 把 icudt78/icuuc78/icuin78 一起删掉，连 _gdal 都加载不起来（实测）
# perl* 全是 conda 带的 Perl 运行时，本软件不跑 Perl
$excludeFile = @('*.lib', '*.a', '*.exp', '*.pdb', '_tkinter.pyd', 'tcl86t.dll', 'tk86t.dll',
                 'icudt.dll', 'icuin.dll', 'icuio.dll', 'icutest.dll', 'icutu.dll', 'icuuc.dll',
                 'perl*')
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

# Library\bin 里 190 个命令行工具（gdal_translate、ogr2ogr、projinfo、sqlite3…）合 24 MB，
# 全项目只用到 dwg2dxf 一个（gisviewer/dwg.py 转 DWG 用），其余清掉
Get-ChildItem (Join-Path $Dst 'Library\bin') -Filter '*.exe' |
  Where-Object { $_.Name -ne 'dwg2dxf.exe' } | Remove-Item -Force

# Library\lib 里除了 gdalplugins 全是 Perl 的 .pm/.pod（82 个子目录、约 21 MB）。
# gdalplugins 里是 HDF4/HDF5/netCDF 这几个格式驱动，删了 netCDF、HDF 就打不开了——
# 所以整个目录先复制，再把 gdalplugins 以外的东西清掉
$libDir = Join-Path $Dst 'Library\lib'
$plug = Join-Path $libDir 'gdalplugins'
if (Test-Path $plug) {
  $keep = Join-Path $env:TEMP ('tulan_gdalplugins_' + [guid]::NewGuid().ToString('N'))
  Move-Item $plug $keep -Force
  Remove-Item $libDir -Recurse -Force
  New-Item -ItemType Directory -Force -Path $libDir | Out-Null
  Move-Item $keep $plug -Force
}
$bytes = (Get-ChildItem $Dst -Recurse -File | Measure-Object -Property Length -Sum).Sum
Write-Host ("runtime 已生成：{0}  ({1:N0} MB)" -f $Dst, ($bytes / 1MB))
# robocopy 的退出码留在 $LASTEXITCODE 里（1 = 有文件复制，不是失败），
# 不显式清零会让 build.ps1 的退出码检查误判
exit 0
