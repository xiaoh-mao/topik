# 把 app/favicon.svg 烤成 app/app.ico（多尺寸、PNG 载荷），给桌面快捷方式当图标。jlpt\ 和 topik\ 共用，两边必须一模一样。
# 没有第三方工具，所以：先用无头 Edge 把 SVG 渲成 256 的透明 PNG，
# 再用 System.Drawing 缩出各档，最后自己拼 ICO 容器。
# 用法：pwsh -File scratch\make-ico.ps1 [-Shortcut]   -Shortcut 顺便在桌面建（或更新）快捷方式「<入口 .bat 名>.lnk」
param([switch]$Shortcut)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$root = Split-Path -Parent $PSScriptRoot
$svg = Join-Path $root 'app\favicon.svg'
$tmp = Join-Path $root 'scratch\ico-tmp'
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

# 一张只放这个 svg 的空页，背景透明
$page = Join-Path $tmp 'r.html'
@"
<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;background:transparent}img{display:block;width:256px;height:256px}</style>
<img src="file:///$($svg -replace '\\','/')">
"@ | Set-Content -Path $page -Encoding UTF8

$edge = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
if (-not (Test-Path $edge)) { $edge = "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe" }
$big = Join-Path $tmp 'big.png'
if (Test-Path $big) { Remove-Item $big -Force }
# 用 Start-Process -Wait：直接 & 调用 msedge 会提前返回，截图还没写出来
Start-Process $edge -Wait -ArgumentList '--headless=new', '--disable-gpu', '--allow-file-access-from-files',
  '--default-background-color=00000000', '--hide-scrollbars', "--user-data-dir=$tmp\prof",
  "--screenshot=$big", '--window-size=256,256', '--virtual-time-budget=4000',
  ("file:///" + ($page -replace '\\', '/'))
if (-not (Test-Path $big)) { '渲染失败'; exit 1 }

$src = [System.Drawing.Image]::FromFile($big)
$sizes = 16, 24, 32, 48, 64, 128, 256
$blobs = @()
foreach ($s in $sizes) {
  $bmp = New-Object System.Drawing.Bitmap $s, $s
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.DrawImage($src, 0, 0, $s, $s)
  $g.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $blobs += , $ms.ToArray()
  $ms.Dispose(); $bmp.Dispose()
}
$src.Dispose()

# ICO 容器：6 字节头 + 每档 16 字节目录项 + 各档 PNG 数据
$out = New-Object System.IO.MemoryStream
$w = New-Object System.IO.BinaryWriter $out
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $s = $sizes[$i]
  $w.Write([byte]$(if ($s -ge 256) { 0 } else { $s }))    # 256 要写成 0
  $w.Write([byte]$(if ($s -ge 256) { 0 } else { $s }))
  $w.Write([byte]0); $w.Write([byte]0)
  $w.Write([uint16]1); $w.Write([uint16]32)
  $w.Write([uint32]$blobs[$i].Length)
  $w.Write([uint32]$offset)
  $offset += $blobs[$i].Length
}
foreach ($b in $blobs) { $w.Write($b) }
$w.Flush()
$ico = Join-Path $root 'app\app.ico'
[System.IO.File]::WriteAllBytes($ico, $out.ToArray())
$w.Dispose(); $out.Dispose()
Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
"OK $ico  $((Get-Item $ico).Length) 字节，$($sizes.Count) 档：$($sizes -join '/')"

if ($Shortcut) {
  # 直接用 wscript 跑 lib\launch.vbs（跟 .bat 做的一样），不经过 .bat 就不会闪一下黑框
  $bat = Get-ChildItem -LiteralPath $root -Filter '*.bat' | Select-Object -First 1
  $lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) ($bat.BaseName + '.lnk')
  $sh = New-Object -ComObject WScript.Shell
  $l = $sh.CreateShortcut($lnk)
  $l.TargetPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
  $l.Arguments = '"' + (Join-Path $root 'lib\launch.vbs') + '"'
  $l.WorkingDirectory = $root
  $l.IconLocation = "$ico,0"
  $l.Description = $bat.BaseName
  $l.Save()
  "快捷方式 $lnk"
}
