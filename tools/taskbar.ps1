# 列一下任务栏上现在有哪些按钮（走 UI 自动化，绕开 Win32 那套枚举不到的坑）。
# 用 -Has 图览 判定某个窗口在不在任务栏上，收进托盘这类改动就有的可验。
param([string]$Has = '')
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
$bar = $null
foreach ($k in $root.FindAll([System.Windows.Automation.TreeScope]::Children,
  [System.Windows.Automation.Condition]::TrueCondition)) {
  if ($k.Current.ClassName -eq 'Shell_TrayWnd') { $bar = $k; break }
}
if (-not $bar) { Write-Output '没找到 Shell_TrayWnd'; exit 1 }
$btns = $bar.FindAll([System.Windows.Automation.TreeScope]::Descendants,
  (New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Button)))
$names = @()
foreach ($b in $btns) { if ($b.Current.Name) { $names += $b.Current.Name } }
if ($Has) {
  $hit = @($names | Where-Object { $_ -like "*$Has*" })
  Write-Output ('任务栏里有「' + $Has + '」：' + [bool]$hit.Count + (' ' + ($hit -join ' | ')))
} else {
  Write-Output ('任务栏按钮 ' + $names.Count + ' 个')
  $names | ForEach-Object { Write-Output ('- ' + $_) }
}
