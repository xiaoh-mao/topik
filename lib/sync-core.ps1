# 同步内核：jlpt\ 和 topik\ 的内核文件（下面 $Files）两边必须一模一样。改了哪边都行，改完运行（在哪边运行都一样）：
#   pwsh -File lib\sync-core.ps1              把改过的那边复制到另一边
#   pwsh -File lib\sync-core.ps1 -Check       只检查，不改（两边一致退出码 0）
#   pwsh -File lib\sync-core.ps1 -From jlpt   两边都改过时，拿 jlpt 那份盖掉另一边（先手动把另一边的改动合进去）
# lib\core.lock 记着上次同步时每个文件的 SHA256：只有一边跟它不同 = 那边改过，复制过去；两边都不同 = 冲突，停下。
# 本文件自己也是内核文件。两个项目是 GitHub 上的两个仓库：要克隆到同一个文件夹下，文件夹名就叫 jlpt 和 topik。
param([switch]$Check, [string]$From = '')
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }   # 输出被别的程序接走时（比如 Claude Code 的 Bash）中文不乱码

$Projects = 'jlpt', 'topik'                      # 本项目的同级文件夹
$Files = 'lib/server.ps1', 'lib/launch.vbs', 'lib/sync-core.ps1', 'app/core.js', 'app/core.css', 'app/index.html',
  'scratch/ocr.ps1', 'scratch/make-ico.ps1'      # 后两个是生成数据用的工具，两边一样用
$Parent = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$dirs = [ordered]@{}
foreach ($p in $Projects) { $dirs[$p] = Join-Path $Parent $p }
foreach ($p in $Projects) {
  if (-not (Test-Path -LiteralPath (Join-Path $dirs[$p] 'lib\server.ps1'))) {
    throw "找不到 $($dirs[$p])：$($Projects -join ' 和 ') 两个仓库要克隆到同一个文件夹下，文件夹名就叫这两个（git clone <地址> $p）"
  }
}
if ($From -and -not $dirs.Contains($From)) { throw "-From 只能是：$($Projects -join ' / ')" }

function Get-Hash([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return '' }
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}
function Read-Lock([string]$Dir) {
  $f = Join-Path $Dir 'lib\core.lock'
  $h = @{}
  if (Test-Path -LiteralPath $f) {
    foreach ($ln in [IO.File]::ReadAllLines($f)) { if ($ln -match '^([0-9A-F]{64})  (.+)$') { $h[$Matches[2]] = $Matches[1] } }
  }
  return $h
}

$locks = @{}
foreach ($p in $Projects) { $locks[$p] = Read-Lock $dirs[$p] }
$bad = 0; $copied = 0
$newLock = [ordered]@{}
foreach ($f in $Files) {
  $h = [ordered]@{}
  foreach ($p in $Projects) { $h[$p] = Get-Hash (Join-Path $dirs[$p] $f) }
  $vals = @($h.Values | Select-Object -Unique)
  if ($vals.Count -eq 1 -and $vals[0]) { $newLock[$f] = $vals[0]; continue }
  # 上次同步时的样子：各项目的 lock 说法一致才算数
  $bases = @($Projects | ForEach-Object { $locks[$_][$f] } | Select-Object -Unique)
  $base = if ($bases.Count -eq 1) { $bases[0] } else { $null }
  $present = @($Projects | Where-Object { $h[$_] })
  $changed = @($present | Where-Object { $h[$_] -ne $base })
  $src = $null
  if ($From) { $src = $From }
  elseif ($base -and $changed.Count -eq 0 -and $present.Count) { $src = $present[0] }     # 只是有一边缺了这个文件
  elseif ($base -and $changed.Count -ge 1 -and @($changed | ForEach-Object { $h[$_] } | Select-Object -Unique).Count -eq 1) { $src = $changed[0] }
  if (-not $src -or -not $h[$src]) {
    $bad++
    Write-Host "冲突  $f：$(($Projects | ForEach-Object { "$_ " + $(if ($h[$_]) { $h[$_].Substring(0, 8) } else { '(没有)' }) }) -join '，')" -ForegroundColor Red
    Write-Host "      两边都改过（或还没同步过）。先手动合并成一样，或者用 -From <项目> 指定拿哪边的。" -ForegroundColor Red
    continue
  }
  $newLock[$f] = $h[$src]
  foreach ($p in $Projects) {
    if ($p -eq $src -or $h[$p] -eq $h[$src]) { continue }
    if ($Check) { Write-Host "要同步  $f：$src -> $p"; $bad++; continue }
    Copy-Item -LiteralPath (Join-Path $dirs[$src] $f) -Destination (Join-Path $dirs[$p] $f) -Force
    Write-Host "已同步  $f：$src -> $p" -ForegroundColor Green
    $copied++
  }
}
if ($bad) { exit 1 }
if (-not $Check) {
  $text = ($newLock.Keys | ForEach-Object { "$($newLock[$_])  $_" }) -join "`n"
  foreach ($p in $Projects) { [IO.File]::WriteAllText((Join-Path $dirs[$p] 'lib\core.lock'), $text + "`n") }
}
Write-Host $(if ($copied) { "同步了 $copied 个文件，两边内核一致。" } else { '两边内核一致。' })
