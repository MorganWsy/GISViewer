# 发布打包：从 dist\ 产出更新包、清单与清单签名到 publish\。
# 三样东西的分工：
#   tulan-patch-v<版本>.zip  给已经装过的人：程序、前端、引擎源码，不含 381 MB 的 runtime
#   latest.json              客户端先看它（版本、日期、说明、包名、大小、sha256）
#   latest.json.sig          清单字节的 SHA-256 的 ECDSA P-256 签名，客户端拿内置公钥验
#
# 上传是手动的：对象存储只由项目所有者操作，工具链不碰云端。把这几个文件传到
#   https://wsy-release.oss-cn-hangzhou.aliyuncs.com/tulan/  下，同名覆盖即可。
# 顺序很重要：先传 zip，再传 latest.json，最后传 latest.json.sig。
# 反过来会让"清单已经有了、包还没到"的窗口期有人点到更新然后报 404。
#
# 用法（-Notes 多条必须走 -Command；pwsh -File 传 'a','b' 会被并成一条带逗号的字符串）：
#   pwsh -NoProfile -Command "& 'D:\GISViewer\tools\publish.ps1' -Ver 0.14 -Notes '第一条','第二条'"
#
# -Notes 只写用户能感知的变化：新增了什么、哪里不再出错、哪个说法改了。
# 样式微调、内部重构、日志与注释的改动一律不进摘要——弹层里三五条看得完，
# 混进鸡毛蒜皮之后，真正要人注意的那条就被淹了。
#
# 更新包不含 runtime（381 MB，不随版本变），所以只够给已经装过的机器换文件。
# 首次安装要的是完整包：加 -Full 另存一份 tulan-v<版本>.zip。分发时两个都要。
#
# 关键约束：清单里的 ver 必须与 dist\gisviewer\__init__.py 里的 __version__ 一字不差。
# 客户端拿引擎报的版本号跟清单比，两边对不上就永远判成"有新版"或永远不提示。
param(
  [Parameter(Mandatory = $true)][string]$Ver,
  [string[]]$Notes = @(),
  [string]$Page = '',
  [string]$Key = 'D:\tulan-keys\update-private.txt',
  [string]$OutDir = 'publish',
  [switch]$Full
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent

if ($Ver -notmatch '^\d+\.\d+$') { throw "版本号要写成 X.Y 两段（如 0.14），现在是：$Ver" }
if (-not (Test-Path (Join-Path $root 'dist\Tulan.exe'))) { throw 'dist 里没有构建产物，先跑 build.ps1' }
if ($Notes.Count -eq 0) { throw '没有更新说明：至少给一条 -Notes，否则弹层里是一片空白' }

# 版本号对账：清单说 0.14、引擎却是 0.13 的话，客户端要么永远提示、要么永远不提示
$initPy = Join-Path $root 'dist\gisviewer\__init__.py'
$m = [regex]::Match([IO.File]::ReadAllText($initPy), '__version__\s*=\s*"([^"]+)"')
if (-not $m.Success) { throw "读不到 dist 里的版本号：$initPy" }
if ($m.Groups[1].Value -ne $Ver) {
  throw "清单版本 $Ver 与 dist 引擎版本 $($m.Groups[1].Value) 不一致；先改 gisviewer\__init__.py 再 build"
}

$out = Join-Path $root $OutDir
New-Item -ItemType Directory -Path $out -Force | Out-Null

# 更新包：dist 下除了 runtime 全都带上。runtime 有 381 MB 且不随版本变，
# 每次重发一遍只是白等；它靠完整包（-Full）或者重装一次解决。
$items = Get-ChildItem (Join-Path $root 'dist') -Force |
  Where-Object { $_.Name -ne 'runtime' -and $_.Name -ne 'win.json' -and $_.Extension -ne '.log' } |
  ForEach-Object { $_.FullName }
$patchZip = Join-Path $out "tulan-patch-v$Ver.zip"
Compress-Archive -Path $items -DestinationPath $patchZip -CompressionLevel Optimal -Force

# 压完当场验收：前端必须在 web\ 那一层下面，根目录只准躺可执行文件和 dll。
# 这一条是被坑出来的——早先按"只有一个目录"拆壳，前端被摆到了安装目录根上。
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zk = [IO.Compression.ZipFile]::OpenRead((Resolve-Path $patchZip))
try {
  $names = @($zk.Entries | ForEach-Object { $_.FullName })
  $top = @($names | Where-Object { $_ -notmatch '[\\/]' })
  $allow = '^(Tulan\.exe|TulanUpdater\.exe|Microsoft\.Web\.WebView2\.(Core|WinForms)\.dll|WebView2Loader\.dll|tulan\.ico|CHANGELOG\.md)$'
  $bad = @($top | Where-Object { $_ -notmatch $allow })
  if ($bad.Count -gt 0) { throw "更新包根目录多了不该有的东西：$($bad -join ', ')（前端应排在 web/ 下）" }
  if (-not ($names -contains 'web/app.js')) { throw '更新包里没有 web/app.js，压平了' }
  if (-not ($names -contains 'gisviewer/__init__.py')) { throw '更新包里没有 gisviewer/__init__.py' }
  if (@($names | Where-Object { $_ -like 'runtime/*' }).Count -gt 0) { throw '更新包里混进了 runtime，那是完整包的事' }
  "更新包：$($names.Count) 个条目，web/ $(@($names | Where-Object { $_ -like 'web/*' }).Count) 个，根目录 $($top -join ' ')"
} finally { $zk.Dispose() }

if ($Full) {
  $fullZip = Join-Path $out "tulan-v$Ver.zip"
  Compress-Archive -Path (Join-Path $root 'dist\*') -DestinationPath $fullZip -CompressionLevel Optimal -Force
  '完整包  {0,-26} {1,10:N0} B' -f (Split-Path $fullZip -Leaf), (Get-Item $fullZip).Length
}

$bytes = [IO.File]::ReadAllBytes($patchZip)
$shaHex = (([Security.Cryptography.SHA256]::Create()).ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') }) -join ''

# 清单先落盘，签名只认磁盘上这份字节——写完别再动它。
# notes 写成数组（客户端两种都收，数组在 JSON 里更好读）
$man = [ordered]@{
  fmt    = 1
  ver    = $Ver
  date   = (Get-Date).ToString('yyyy-MM-dd')
  notes  = $Notes
  page   = $Page
  pkg    = (Split-Path $patchZip -Leaf)
  size   = $bytes.Length
  sha256 = $shaHex
}
$json = ($man | ConvertTo-Json -Depth 3) -replace "`r`n", "`n"
$manPath = Join-Path $out 'latest.json'
[IO.File]::WriteAllText($manPath, $json, (New-Object Text.UTF8Encoding($false)))

# 签名：私钥文件是四行 k=v（algo / Qx / Qy / D），algo 那行不参与导入
if (-not (Test-Path $Key)) { throw "找不到私钥文件：$Key（换机器要一起带走，丢了所有已安装副本就再也收不到更新）" }
$k = @{}
foreach ($line in Get-Content $Key) {
  $i = $line.IndexOf('=')
  if ($i -gt 0 -and $line.Substring(0, $i) -ne 'algo') {
    $k[$line.Substring(0, $i)] = [Convert]::FromBase64String($line.Substring($i + 1))
  }
}
if (-not $k.Qx -or -not $k.Qy -or -not $k.D) { throw "私钥文件不完整：$Key" }
$ec = [Security.Cryptography.ECDsa]::Create()
$ep = New-Object Security.Cryptography.ECParameters
$ep.Curve = [Security.Cryptography.ECCurve]::CreateFromValue('1.2.840.10045.3.1.7')
$q = New-Object Security.Cryptography.ECPoint
$q.X = $k.Qx; $q.Y = $k.Qy
$ep.Q = $q
$ep.D = $k.D
$ec.ImportParameters($ep)
$manBytes = [IO.File]::ReadAllBytes($manPath)
$digest = [Security.Cryptography.SHA256]::Create().ComputeHash($manBytes)
$sigPath = Join-Path $out 'latest.json.sig'
[IO.File]::WriteAllText($sigPath, [Convert]::ToBase64String($ec.SignHash($digest)), (New-Object Text.ASCIIEncoding))

# 公钥指纹：壳里嵌的是 Qx/Qy 那两行，对不上就是这批二进制认不了这份签名
$pubX = [Convert]::ToBase64String($q.X)
$privPubX = ([regex]::Match([IO.File]::ReadAllText((Join-Path $root 'src\Host.cs')), 'PubX = "([^"]+)"')).Groups[1].Value
if ($privPubX -ne $pubX) { throw "私钥与 Host.cs 里的公钥不是一对（$pubX ≠ $privPubX），签出来的东西没人认" }

'更新包  {0,-26} {1,10:N0} B' -f (Split-Path $patchZip -Leaf), $bytes.Length
'清单    {0,-26} {1,10:N0} B' -f 'latest.json', $manBytes.Length
'签名    {0,-26} {1,10:N0} B' -f 'latest.json.sig', (Get-Item $sigPath).Length
'SHA256  ' + $shaHex
''
'接下来手动上传（先包，再清单，最后签名）：'
'  ' + (Split-Path $patchZip -Leaf)
'  latest.json'
'  latest.json.sig'
'  → https://wsy-release.oss-cn-hangzhou.aliyuncs.com/tulan/'
if (-not $Full) {
  $fullZip = Join-Path $out "tulan-v$Ver.zip"
  if (-not (Test-Path $fullZip)) {
    ''
    '提示：这次只出了更新包，没有完整包。首次安装的机器要的是 tulan-v' + $Ver + '.zip（含 runtime），'
    '      加 -Full 重跑一次即可（约三分钟，381 MB）。更新包不能当完整包分发。'
  }
}
