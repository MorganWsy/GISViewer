# 一条命令跑完全部回归：语法检查 → 原生壳编译 → 引擎全格式 → 缓存安全 → 索引生命周期 → 接口冒烟。
# 任何一步不过就以退出码 1 结束，CI 和本地用的是同一条命令。
#
# 用法：
#   pwsh -File tools\regress.ps1                全部
#   pwsh -File tools\regress.ps1 -SkipShell     不编译 C#（没装 .NET Framework 的机器）
#   pwsh -File tools\regress.ps1 -Only sweep    只跑某一节：syntax / shell / sweep / cache / vindex / auth / raster / api
#   pwsh -File tools\regress.ps1 -Offline       引擎和接口都跳过，只做静态检查
param(
  [switch]$SkipShell,
  [switch]$Offline,
  [ValidateSet('all', 'syntax', 'shell', 'sweep', 'cache', 'vindex', 'auth', 'raster', 'ramp', 'pyramid', 'compare', 'api', 'ui')]
  [string]$Only = 'all'
)
$ErrorActionPreference = 'Stop'
# 子进程（python/node/csc）都吐 UTF-8，控制台不跟着设就会整段中文乱码
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$env:PYTHONIOENCODING = 'utf-8'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

# 样例数据在仓库里（见 PLAN §11）
if (-not $env:TULAN_DATA) {
  $guess = Join-Path $root 'data'
  if (Test-Path $guess) { $env:TULAN_DATA = $guess }
}

# 解释器：先开发环境，再打包出来的 runtime，最后 PATH
$py = $env:TULAN_PY
if (-not $py) {
  foreach ($cand in @('D:\miniAnaconda\envs\gisviewer\python.exe', (Join-Path $root 'app\runtime\python.exe'))) {
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

  # .ps1/.cs 在 Windows PowerShell 5.1 下必须是 UTF-8 BOM；无 BOM 会把中文
  # 当 ANSI 读，构建/拖放脚本的中文提示会乱码。构建目录和运行目录不查。
  $bomFiles = Get-ChildItem $root -Recurse -File -Include '*.ps1', '*.cs' |
    Where-Object { $_.FullName -notmatch '\(app|build|data|archive|\.git)\' }
  $badBom = @()
  foreach ($f in $bomFiles) {
    $bytes = [IO.File]::ReadAllBytes($f.FullName)
    if ($bytes.Length -lt 3 -or $bytes[0] -ne 0xEF -or $bytes[1] -ne 0xBB -or $bytes[2] -ne 0xBF) {
      $badBom += $f.FullName.Substring($root.Length + 1)
    }
  }
  $bomNote = if ($badBom.Count) { '缺 BOM：' + ($badBom -join ', ') } else { "{0} 个文件" -f $bomFiles.Count }
  Record '脚本 BOM' ($badBom.Count -eq 0) $bomNote
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
        # win.json 走 JavaScriptSerializer 解析（ReadWinRect），要这个程序集
        'System.Web.Extensions.dll',
        # 更新包解压用 ZipFile
        'System.IO.Compression.dll', 'System.IO.Compression.FileSystem.dll',
        'Microsoft.CSharp.dll',
        (Join-Path (Split-Path $csc -Parent) 'WPF\UIAutomationClient.dll'),
        (Join-Path (Split-Path $csc -Parent) 'WPF\UIAutomationTypes.dll'),
        (Join-Path (Split-Path $csc -Parent) 'WPF\WindowsBase.dll')
      ) | ForEach-Object { "/reference:$_" }
      $cscArgs = @(
        '/nologo', '/target:winexe', '/platform:x64', '/optimize+',
        "/win32manifest:$root\src\app.manifest",
        "/win32icon:$root\shell\tulan.ico",
        "/out:$tmp\Tulan.exe"
      ) + $refs + @("$root\src\Shell.cs", "$root\src\Host.cs")
      $out = & $csc @cscArgs 2>&1
      if ($LASTEXITCODE -ne 0) { Write-Host ($out -join "`n") }
      Record 'Shell.cs 编译' ($LASTEXITCODE -eq 0) '只编译，不覆盖 app'

      # 更新组件是第二个可执行文件，同样只编译到临时目录
      $updArgs = @(
        '/nologo', '/target:winexe', '/platform:x64', '/optimize+',
        "/out:$tmp\TulanUpdater.exe"
      ) + $refs + @("$root\src\Updater.cs")
      $out2 = & $csc @updArgs 2>&1
      if ($LASTEXITCODE -ne 0) { Write-Host ($out2 -join "`n") }
      Record 'Updater.cs 编译' ($LASTEXITCODE -eq 0) '只编译，不覆盖 app'
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

# ---------- 4. 缓存目录安全 ----------
if (Want 'cache') {
  Section '缓存目录安全'
  & $py (Join-Path $root 'tests\cache_safety.py')
  Record '缓存目录安全' ($LASTEXITCODE -eq 0) '见上方逐条结果'
}

# ---------- 4b. 索引生命周期 ----------
if (Want 'vindex') {
  Section '索引生命周期'
  & $py (Join-Path $root 'tests/vindex_test.py')
  Record '索引生命周期' ($LASTEXITCODE -eq 0) '见上方逐条结果'
}

# ---------- 4bb. 栅格按视野重采样 ----------
if ((Want 'raster') -and (-not $Offline)) {
  Section '栅格按视野重采样'
  & $py (Join-Path $root 'tests/raster_view.py')
  Record '栅格视野重采样' ($LASTEXITCODE -eq 0) '见上方逐条结果'
}

# ---------- 4bb2. 色带挑选与指定 ----------
if ((Want 'ramp') -and (-not $Offline)) {
  Section '色带挑选与指定'
  & $py (Join-Path $root 'tests/ramp_test.py')
  Record '色带挑选' ($LASTEXITCODE -eq 0) '见上方逐条结果'
}

# ---------- 4bc. 金字塔副本 ----------
if ((Want 'pyramid') -and (-not $Offline)) {
  Section '金字塔副本'
  & $py (Join-Path $root 'tests/pyramid_test.py')
  Record '金字塔副本' ($LASTEXITCODE -eq 0) '见上方逐条结果'
}

# ---------- 4bc2. 两份文件对比 ----------
if (Want 'compare') {
  Section '两份文件对比'
  & $py (Join-Path $root 'tests/compare_test.py')
  Record '两份文件对比' ($LASTEXITCODE -eq 0) '见上方逐条结果'
}

# ---------- 4c. 本地接口鉴权 ----------
if (Want 'auth') {
  Section '本地接口鉴权'
  & $py (Join-Path $root 'tests/auth_test.py')
  Record '本地接口鉴权' ($LASTEXITCODE -eq 0) '见上方逐条结果'
}

# ---------- 5. 接口冒烟 ----------
if ((Want 'api') -and (-not $Offline)) {
  Section '接口冒烟'
  & $py (Join-Path $root 'tests\api_smoke.py')
  Record '接口冒烟' ($LASTEXITCODE -eq 0) '见上方逐条结果'
}

# ---------- 5b. 前端失败恢复（需要 Edge + playwright-cli，单独跑） ----------
if (Want 'ui') {
  Section '前端失败恢复'
  & $py (Join-Path $root 'tests/ui_failure.py')
  Record '前端 500 恢复' ($LASTEXITCODE -eq 0) '缺 Edge 时脚本会明确 SKIP'
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
