# 图览 构建脚本：csc.exe 直接编译，不需要装 .NET SDK。
# 用法：
#   pwsh -File build.ps1          只出 exe 和资源（开发机可跑）
#   pwsh -File build.ps1 -Pack    再整份复制 conda 环境成 app\runtime，并跑一遍体检
#   pwsh -File build.ps1 -Zip     顺手把 app 压成一个能直接发给别人的包存进 build\archive\
#   pwsh -File build.ps1 -Pack -Zip   一次出完整发布包（这是发布用的那条命令）
param(
  [switch]$Pack,
  [switch]$Zip
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$app = Join-Path $root 'app'

# 仓库里的两个大目录（都已在 .gitignore 里）：样例数据、发布存档。
# 换机器或换盘符时用 TULAN_DATA / TULAN_OUT 覆盖，不必改脚本。
$dataDir = if ($env:TULAN_DATA) { $env:TULAN_DATA } else { Join-Path $root 'data' }
$outDir = if ($env:TULAN_OUT) { $env:TULAN_OUT } else { Join-Path $root 'build' }

# 运行中的实例会锁住 app 里的 dll 和 web 目录，必须先停
Get-Process Tulan, GISViewer -ErrorAction SilentlyContinue | Stop-Process -Force
Get-Process *msedgewebview2* -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -like "*$app*" } | Stop-Process -Force
Start-Sleep -Seconds 1

New-Item -ItemType Directory -Force -Path $app | Out-Null
# 改名之前的构建产物留着只会让人以为有两个可执行文件
Remove-Item (Join-Path $app 'GISViewer.exe') -Force -ErrorAction SilentlyContinue

$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { throw "找不到 csc.exe：$csc" }

$refs = @(
  (Join-Path $root 'lib\Microsoft.Web.WebView2.Core.dll'),
  (Join-Path $root 'lib\Microsoft.Web.WebView2.WinForms.dll'),
  'System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Windows.Forms.dll',
  # win.json 用 JavaScriptSerializer 读写（见 Shell.RectFromFile），框架自带这个程序集
  'System.Web.Extensions.dll',
  # 更新包是 zip，解压用 ZipFile（System.IO.Compression.FileSystem）
  'System.IO.Compression.dll', 'System.IO.Compression.FileSystem.dll',
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
  "/out:$app\Tulan.exe"
) + $refs + @("$root\src\Shell.cs", "$root\src\Host.cs")

& $csc @cscArgs
if ($LASTEXITCODE -ne 0) {
  # 编译器的报错不能吞掉：直接打出来，否则只看到一行 "csc failed"
  & $csc @cscArgs 2>&1 | Out-Host
  throw "csc failed ($LASTEXITCODE)"
}

# 更新组件：主程序换不了自己，替换文件这一步由它在本进程退出后做（见 src\Updater.cs）
$updArgs = @(
  '/nologo', '/target:winexe', '/platform:x64', '/optimize+',
  "/win32manifest:$root\src\app.manifest",
  "/win32icon:$root\shell\tulan.ico",
  "/out:$app\TulanUpdater.exe"
) + $refs + @("$root\src\Updater.cs")
& $csc @updArgs
if ($LASTEXITCODE -ne 0) {
  & $csc @updArgs 2>&1 | Out-Host
  throw "csc failed (TulanUpdater, $LASTEXITCODE)"
}

foreach ($dll in Get-ChildItem (Join-Path $root 'lib\*.dll')) {
  Copy-Item $dll.FullName $app -Force
}
Copy-Item (Join-Path $root 'shell\tulan.ico') $app -Force

# 引擎和界面都放在 exe 旁边：server.py 按 gisviewer 的上一级找 web/
foreach ($item in 'gisviewer', 'web') {
  $to = Join-Path $app $item
  if (Test-Path $to) { Remove-Item $to -Recurse -Force }
  Copy-Item (Join-Path $root $item) $to -Recurse -Force
}
Get-ChildItem -Path $app -Recurse -Filter '__pycache__' -Directory |
  Remove-Item -Recurse -Force
Copy-Item (Join-Path $root 'CHANGELOG.md') $app -Force

if ($Pack) {
  # 免安装运行时：整份复制 conda 环境到 app\runtime（tools\pack_runtime.ps1 里定的剔除清单）。
  # 不用 conda-pack：rasterio 与 pyogrio 各自可能带 GDAL，去重容易出事，原样搬走更稳。
  & (Join-Path $root 'tools\pack_runtime.ps1') -Dst (Join-Path $app 'runtime')
  if ($LASTEXITCODE -ne 0) { throw "pack_runtime 失败 ($LASTEXITCODE)" }
  $py = Join-Path $app 'runtime\python.exe'
  if (-not (Test-Path $py)) { throw "runtime 没生成出来：$py" }
  # 复制完就跑一遍体检，跑不起来就不能交包
  & $py (Join-Path $root 'tools\check_runtime.py') (Join-Path $dataDir 'samples')
  if ($LASTEXITCODE -ne 0) { throw "runtime 体检未通过 ($LASTEXITCODE)" }
  Write-Host "免安装包：$app"
}

$exe = Get-Item (Join-Path $app 'Tulan.exe')
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
  & "$env:SystemRoot\System32\tar.exe" -a -c -f $zipPath -C $app .
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $zipPath)) { throw "打包失败（$LASTEXITCODE）" }
  $z = Get-Item $zipPath
  Write-Host ("已存档 {0}（{1:N1} MiB）" -f $z.Name, ($z.Length / 1MB))
}
