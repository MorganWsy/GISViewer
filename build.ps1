# 图览 构建脚本：csc.exe 直接编译，不需要装 .NET SDK。
# 用法：
#   pwsh -File build.ps1          只出 exe 和资源（开发机可跑）
#   pwsh -File build.ps1 -Pack    再整份复制 conda 环境成 dist\runtime，并跑一遍体检
#   pwsh -File build.ps1 -Zip     顺手把 dist 压成一个能直接发给别人的包存进 ..\GISViewer-build\archive\
#   pwsh -File build.ps1 -Pack -Zip   一次出完整发布包（这是发布用的那条命令）
param(
  [switch]$Pack,
  [switch]$Zip
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$dist = Join-Path $root 'dist'

# 源码树之外的两个目录（见 PLAN §11）：样例数据、发布存档。
# 换机器或换盘符时用 TULAN_DATA / TULAN_OUT 覆盖，不必改脚本。
$parent = Split-Path $root -Parent
$dataDir = if ($env:TULAN_DATA) { $env:TULAN_DATA } else { Join-Path $parent 'GISViewer-data' }
$outDir = if ($env:TULAN_OUT) { $env:TULAN_OUT } else { Join-Path $parent 'GISViewer-build' }

# 运行中的实例会锁住 dist 里的 dll 和 web 目录，必须先停
Get-Process Tulan, GISViewer -ErrorAction SilentlyContinue | Stop-Process -Force
Get-Process *msedgewebview2* -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -like "*$dist*" } | Stop-Process -Force
Start-Sleep -Seconds 1

New-Item -ItemType Directory -Force -Path $dist | Out-Null
# 改名之前的构建产物留着只会让人以为有两个可执行文件
Remove-Item (Join-Path $dist 'GISViewer.exe') -Force -ErrorAction SilentlyContinue

$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { throw "找不到 csc.exe：$csc" }

$refs = @(
  (Join-Path $root 'lib\Microsoft.Web.WebView2.Core.dll'),
  (Join-Path $root 'lib\Microsoft.Web.WebView2.WinForms.dll'),
  'System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Windows.Forms.dll',
  # 读资源管理器的选中项走 Shell.Application 后期绑定，dynamic 需要这个程序集
  'Microsoft.CSharp.dll',
  # 标签页/桌面上的选中项 Shell.Application 读不到，改用 UI Automation 直接读窗口。
  # 这三个在 .NET Framework 的 WPF 子目录里，按名字引用不到，必须给全路径
  (Join-Path (Split-Path $csc -Parent) 'WPF\UIAutomationClient.dll'),
  (Join-Path (Split-Path $csc -Parent) 'WPF\UIAutomationTypes.dll'),
  (Join-Path (Split-Path $csc -Parent) 'WPF\WindowsBase.dll')
) | ForEach-Object { "/reference:$_" }

$cscArgs = @(
  '/nologo', '/target:winexe', '/platform:x64', '/optimize+',
  "/win32manifest:$root\src\app.manifest",
  "/win32icon:$root\shell\tulan.ico",
  "/out:$dist\Tulan.exe"
) + $refs + @("$root\src\Shell.cs", "$root\src\Host.cs")

& $csc @cscArgs
if ($LASTEXITCODE -ne 0) {
  # 编译器的报错不能吞掉：直接打出来，否则只看到一行 "csc failed"
  & $csc @cscArgs 2>&1 | Out-Host
  throw "csc failed ($LASTEXITCODE)"
}

foreach ($dll in Get-ChildItem (Join-Path $root 'lib\*.dll')) {
  Copy-Item $dll.FullName $dist -Force
}
Copy-Item (Join-Path $root 'shell\tulan.ico') $dist -Force

# 引擎和界面都放在 exe 旁边：server.py 按 gisviewer 的上一级找 web/
foreach ($item in 'gisviewer', 'web') {
  $to = Join-Path $dist $item
  if (Test-Path $to) { Remove-Item $to -Recurse -Force }
  Copy-Item (Join-Path $root $item) $to -Recurse -Force
}
Get-ChildItem -Path $dist -Recurse -Filter '__pycache__' -Directory |
  Remove-Item -Recurse -Force
Copy-Item (Join-Path $root 'CHANGELOG.md') $dist -Force

if ($Pack) {
  # 免安装运行时：整份复制 conda 环境到 dist\runtime（tools\pack_runtime.ps1 里定的剔除清单）。
  # 不用 conda-pack：rasterio 与 pyogrio 各自可能带 GDAL，去重容易出事，原样搬走更稳。
  & (Join-Path $root 'tools\pack_runtime.ps1') -Dst (Join-Path $dist 'runtime')
  if ($LASTEXITCODE -ne 0) { throw "pack_runtime 失败 ($LASTEXITCODE)" }
  $py = Join-Path $dist 'runtime\python.exe'
  if (-not (Test-Path $py)) { throw "runtime 没生成出来：$py" }
  # 复制完就跑一遍体检，跑不起来就不能交包
  & $py (Join-Path $root 'tools\check_runtime.py') (Join-Path $dataDir 'samples')
  if ($LASTEXITCODE -ne 0) { throw "runtime 体检未通过 ($LASTEXITCODE)" }
  Write-Host "免安装包：$dist"
}

$exe = Get-Item (Join-Path $dist 'Tulan.exe')
Write-Host ("已生成 {0}（{1:N0} KB，{2}）" -f $exe.Name, ($exe.Length / 1KB), $exe.LastWriteTime)

if ($Zip) {
  # 版本号只在引擎里写一次，这里读出来用，不在第二个地方再维护一份
  $hit = Select-String -Path (Join-Path $root 'gisviewer\__init__.py') -Pattern '__version__ = "([^"]+)"'
  $ver = $hit.Matches[0].Groups[1].Value
  $arc = Join-Path $outDir 'archive'
  New-Item -ItemType Directory -Force -Path $arc | Out-Null
  # 每个版本只留一份存档，打磨/小修批次直接覆盖，不留时间戳副本
  $zipPath = Join-Path $arc ("图览-{0}-win64.zip" -f $ver)
  if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
  # 必须用系统自带的 bsdtar：Git Bash 里的 tar 是 GNU tar，压不出 zip
  & "$env:SystemRoot\System32\tar.exe" -a -c -f $zipPath -C $dist .
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $zipPath)) { throw "打包失败（$LASTEXITCODE）" }
  $z = Get-Item $zipPath
  Write-Host ("已存档 {0}（{1:N1} MiB）" -f $z.Name, ($z.Length / 1MB))
}
