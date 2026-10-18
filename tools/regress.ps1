# 一条命令跑完全部回归：语法检查 → 原生壳编译 → 引擎全格式 → 接口冒烟。
# 任何一步不过就以退出码 1 结束，CI 和本地用的是同一条命令。
#
# 用法：
#   pwsh -File tools\regress.ps1                全部
#   pwsh -File tools\regress.ps1 -SkipShell     不编译 C#（没装 .NET Framework 的机器）
#   pwsh -File tools\regress.ps1 -Only sweep    只跑某一节：syntax / shell / sweep / api
#   pwsh -File tools\regress.ps1 -Offline       引擎和接口都跳过，只做静态检查
param(
  [switch]$SkipShell,
  [switch]$Offline,
  [ValidateSet('all', 'syntax', 'shell', 'sweep', 'api')]
  [string]$Only = 'all'
)
$ErrorActionPreference = 'Stop'
# 子进程（python/node/csc）都吐 UTF-8，控制台不跟着设就会整段中文乱码
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$env:PYTHONIOENCODING = 'utf-8'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

# 样例数据在源码树之外（见 PLAN §11）
if (-not $env:TULAN_DATA) {
  $guess = Join-Path (Split-Path $root -Parent) 'GISViewer-data'
  if (Test-Path $guess) { $env:TULAN_DATA = $guess }
}

# 解释器：先开发环境，再打包出来的 runtime，最后 PATH
$py = $env:TULAN_PY
if (-not $py) {
  foreach ($cand in @('D:\miniAnaconda\envs\gisviewer\python.exe', (Join-Path $root 'dist\runtime\python.exe'))) {
    if (Test-Path $cand) { $py = $cand; break }
  }
}
if (-not $py) { $py = 'python' }

$results = New-Object System.Collections.ArrayList
$clock = [Diagnostics.Stopwatch]::StartNew()

function Want([string]$stage) {
  if ($Offline -and $stage -ne 'syntax') { return $false }
  if ($Only -eq 'all') { return $true }
  return $Only -eq $stage
}

function Record([string]$name, [bool]$ok, [string]$note) {
  [void]$results.Add([pscustomobject]@{ Name = $name; Ok = $ok; Note = $note })
  $tag = if ($ok) { 'PASS' } else { 'FAIL' }
  $color = if ($ok) { 'Green' } else { 'Red' }
  Write-Host ("{0}  {1}  {2}" -f $tag, $name, $note) -ForegroundColor $color
}

# 跳过不等于通过：单独记一笔，汇总里明说，不冒充跑过了
function Skip([string]$why) {
  [void]$results.Add([pscustomobject]@{ Name = $why; Ok = $true; Note = '已跳过'; Skipped = $true })
  Write-Host ("SKIP  {0}" -f $why) -ForegroundColor DarkYellow
}

function Section([string]$title) {
  Write-Host ""
  Write-Host ("== {0} ==" -f $title) -ForegroundColor Cyan
}

# ---------- 1. 语法 ----------
if (Want 'syntax') {
  Section '语法检查'

  $pyFiles = @()
  foreach ($dir in 'gisviewer', 'tools', 'tests') {
    $pyFiles += Get-ChildItem (Join-Path $root $dir) -Filter '*.py' -File | ForEach-Object { $_.FullName }
  }
  $pyCode = @'
import sys
bad = 0
for path in sys.argv[1:]:
    try:
        with open(path, encoding="utf-8") as fh:
            compile(fh.read(), path, "exec")
    except SyntaxError as exc:
        bad += 1
        print("  语法错误 %s:%s: %s" % (path, exc.lineno, exc.msg))
    except UnicodeDecodeError as exc:
        bad += 1
        print("  编码不对 %s: %s" % (path, exc))
print("  Python %d 个文件%s" % (len(sys.argv) - 1, "，全部通过" if not bad else "，%d 个有错" % bad))
raise SystemExit(1 if bad else 0)
'@
  & $py -c $pyCode @pyFiles
  Record 'Python 语法' ($LASTEXITCODE -eq 0) ("{0} 个文件" -f $pyFiles.Count)

  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) {
    Skip 'JS 语法（本机没有 node）'
  } else {
    $jsFiles = Get-ChildItem (Join-Path $root 'web\*.js') -File
    $badJs = @()
    foreach ($f in $jsFiles) {
      $out = & node --check $f.FullName 2>&1
      if ($LASTEXITCODE -ne 0) { $badJs += $f.Name; Write-Host ($out -join "`n") }
    }
    $note = if ($badJs.Count) { "出错：" + ($badJs -join ', ') } else { "{0} 个文件" -f $jsFiles.Count }
    Record 'JS 语法' ($badJs.Count -eq 0) $note
  }
}

# ---------- 2. 原生壳编译 ----------
if ((Want 'shell') -and (-not $SkipShell)) {
  Section '原生壳编译'
  $csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
  if (-not (Test-Path $csc)) {
    Skip 'Shell.cs 编译（找不到 csc.exe）'
  } else {
    $tmp = Join-Path $env:TEMP ('tulan-regress-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    try {
      $refs = @(
        (Join-Path $root 'lib\Microsoft.Web.WebView2.Core.dll'),
        (Join-Path $root 'lib\Microsoft.Web.WebView2.WinForms.dll'),
        'System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Windows.Forms.dll',
        'Microsoft.CSharp.dll'
      ) | ForEach-Object { "/reference:$_" }
      $cscArgs = @(
        '/nologo', '/target:winexe', '/platform:x64', '/optimize+',
        "/win32manifest:$root\src\app.manifest",
        "/win32icon:$root\shell\tulan.ico",
        "/out:$tmp\Tulan.exe"
      ) + $refs + @("$root\src\Shell.cs", "$root\src\Host.cs")
      $out = & $csc @cscArgs 2>&1
      if ($LASTEXITCODE -ne 0) { Write-Host ($out -join "`n") }
      Record 'Shell.cs 编译' ($LASTEXITCODE -eq 0) '只编译，不覆盖 dist'
    } finally {
      Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}

# ---------- 3. 引擎全格式 sweep ----------
if ((Want 'sweep') -and (-not $Offline)) {
  Section '引擎全格式 sweep'
  & $py (Join-Path $root 'tests\sweep.py')
  Record '引擎 sweep' ($LASTEXITCODE -eq 0) '见上方逐条结果'
}

# ---------- 4. 接口冒烟 ----------
if ((Want 'api') -and (-not $Offline)) {
  Section '接口冒烟'
  & $py (Join-Path $root 'tests\api_smoke.py')
  Record '接口冒烟' ($LASTEXITCODE -eq 0) '见上方逐条结果'
}

# ---------- 汇总 ----------
$clock.Stop()
$failed = @($results | Where-Object { -not $_.Ok })
$skipped = @($results | Where-Object { $_.Skipped })
Write-Host ""
Write-Host ("共 {0} 项：{1} 通过，{2} 失败，{3} 跳过，用时 {4:N1} s" -f `
    $results.Count, ($results.Count - $failed.Count - $skipped.Count), $failed.Count,
    $skipped.Count, $clock.Elapsed.TotalSeconds)
if ($failed.Count) {
  Write-Host "失败项：" -ForegroundColor Red
  foreach ($f in $failed) { Write-Host ("  - {0}：{1}" -f $f.Name, $f.Note) -ForegroundColor Red }
  exit 1
}
exit 0
