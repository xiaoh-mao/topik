# 用 Windows 自带 OCR 识别图片。jlpt\ 和 topik\ 共用，两边这个文件必须一模一样：改完运行 lib\sync-core.ps1。
#   默认按系统语言用 zh-Hans 识别器：外文会乱，但数字、括号、点认得准，两边找题号都靠它（JLPT 只 2012 年扫描卷用得上），别改默认；
#   -Lang ko 用韩文识别器（要装 Windows 韩文 OCR 包，TOPIK 找대본里的题号和说明行）：它会漏掉 ③ 那一列、把 ①②④ 认成怪字。
#   本机没有日文 OCR 包，JLPT 也用不着。
# 每行输出：左 上 宽 高 <TAB> 文字。必须用 Windows PowerShell 5.1 跑（pwsh 7 没有 WinRT 投影）。
# 用法：powershell -NoProfile -File scratch\ocr.ps1 [-Lang ko] a.png [b.png ...]   多张图之间用 "### 路径" 分隔
[CmdletBinding(PositionalBinding = $false)]  # -Lang 只能按名字给，否则第一个图片路径会被绑到 $Lang 上
param([string]$Lang = '',[Parameter(ValueFromRemainingArguments = $true)][string[]]$Files)
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -ge 6) { throw 'ocr.ps1 要用 Windows PowerShell 5.1（powershell.exe）跑，pwsh 7 没有 WinRT' }
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($op, [Type]$t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait(-1) | Out-Null; $task.Result }
$null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
$engine = if ($Lang) { [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new($Lang)) } else { [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
if (-not $engine) { throw "没有 '$Lang' 的 OCR 识别器：设置 → 时间和语言 → 语言 → 加对应语言并勾上「光学字符识别」" }
foreach ($f in $Files) {
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync((Resolve-Path $f).Path)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $dec = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bmp = Await ($dec.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $res = Await ($engine.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult])
  "### $f"
  foreach ($ln in $res.Lines) {
    $w = ($ln.Words | Select-Object -First 1).BoundingRect
    $x = [int]$w.X; $y = [int]$w.Y; $ww = [int]$w.Width; $hh = [int]$w.Height
    "$x $y $ww $hh`t" + $ln.Text
  }
  $stream.Dispose()
}
