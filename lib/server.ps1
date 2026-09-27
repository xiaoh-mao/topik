# 做题内核 —— 本地服务：发 app\ 和 papers\ 的静态文件 + 读写 data\records.json。
# jlpt\ 和 topik\ 共用，两边这个文件必须一模一样：改完运行 lib\sync-core.ps1 同步到另一边。
# 标题、端口、考试特有的接口写在 lib\exam.ps1。
# 由 lib\launch.vbs 以隐藏窗口拉起；关掉应用窗口 8 秒后自己退出。
# 单线程顺序处理：别在这里做慢事，大文件按段发（见 Send-File）。
param(
  [int]$Port = 0,          # 0 = 自动找空端口；显式给端口就是调试实例，不登记 .port
  [switch]$NoWindow,       # 调试用：不开窗口，/api/closing 也不理
  [string]$DataDir = ''    # 进度存哪（相对本项目）。默认 data\；调试实例（给了 -Port）默认 scratch\testdata，
                           # 免得覆盖用户进度 —— 真要拿真进度调试就显式写 -DataDir data
)
# 调试：pwsh -File lib\server.ps1 -Port <exam.ps1 里写的调试端口> -NoWindow
# 别用默认端口测：用户开着 app 时，新实例探测到它就直接退出（还会把那个窗口叫到前面），这时去杀进程会杀到用户那个。
# 任何请求都会取消「关窗后 8 秒退出」：别的标签页/浏览器面板开着本服务的页面（每分钟 ping 一次），它就一直不退。
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

$isDefaultPort   = ($Port -eq 0)
if (-not $DataDir) { $DataDir = if ($isDefaultPort) { 'data' } else { 'scratch\testdata' } }
$script:Root     = Split-Path -Parent $PSScriptRoot
$script:AppDir   = Join-Path $script:Root 'app'
$script:PaperDir = Join-Path $script:Root 'papers'
$script:DataDir  = Join-Path $script:Root $DataDir
$script:PortFile = Join-Path $script:DataDir '.port'
New-Item -ItemType Directory -Force -Path $script:DataDir | Out-Null
$utf8 = New-Object System.Text.UTF8Encoding($false)

$script:Mime = @{
  '.html' = 'text/html; charset=utf-8'; '.js' = 'application/javascript; charset=utf-8'
  '.css' = 'text/css; charset=utf-8'; '.json' = 'application/json; charset=utf-8'
  '.svg' = 'image/svg+xml'; '.ico' = 'image/x-icon'; '.png' = 'image/png'; '.jpg' = 'image/jpeg'
  '.pdf' = 'application/pdf'; '.mp3' = 'audio/mpeg'; '.m4a' = 'audio/mp4'; '.wav' = 'audio/wav'
}

function Send-Text($Ctx, [string]$Text, [string]$Type = 'application/json; charset=utf-8', [int]$Code = 200) {
  $res = $Ctx.Response
  $bytes = $utf8.GetBytes($Text)
  $res.StatusCode = $Code
  $res.ContentType = $Type
  $res.AddHeader('Cache-Control', 'no-store')
  $res.ContentLength64 = $bytes.Length
  try { $res.OutputStream.Write($bytes, 0, $bytes.Length) } catch { }
  try { $res.Close() } catch { }
}

# URL 路径 -> 磁盘路径，防 ../ 逃出根目录
function Get-SafePath([string]$Base, [string]$Rel) {
  $rel = [Uri]::UnescapeDataString($Rel).TrimStart('/').Replace('/', '\')
  $baseFull = [IO.Path]::GetFullPath($Base).TrimEnd('\')
  $full = [IO.Path]::GetFullPath((Join-Path $baseFull $rel))
  if (-not $full.StartsWith($baseFull + '\', [StringComparison]::OrdinalIgnoreCase)) { return $null }
  return $full
}

# 支持 Range。<audio> 请求 bytes=0- 这种开口区间时只回一段（ChunkMax），浏览器会接着要下一段 ——
# 否则一次写 15 MB，浏览器缓冲够了就不读，写操作卡住，单线程服务整个挂起（存进度的请求也进不来）。
$script:ChunkMax = 2MB
function Send-File($Ctx, [string]$Path, [string]$Cache) {
  $res = $Ctx.Response
  if (-not $Path -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    Send-Text $Ctx '{"error":"not found"}' -Code 404; return
  }
  $len = (Get-Item -LiteralPath $Path).Length
  $ext = [IO.Path]::GetExtension($Path).ToLowerInvariant()
  $type = 'application/octet-stream'
  if ($script:Mime.ContainsKey($ext)) { $type = $script:Mime[$ext] }
  $res.ContentType = $type
  $res.AddHeader('Cache-Control', $Cache)
  $res.AddHeader('Accept-Ranges', 'bytes')
  [long]$start = 0; [long]$end = $len - 1
  $range = $Ctx.Request.Headers['Range']
  if ($range -and $range -match '^bytes=(\d*)-(\d*)$') {
    $a = $Matches[1]; $b = $Matches[2]
    if ($a -ne '') {
      $start = [long]$a
      if ($b -ne '') { $end = [Math]::Min([long]$b, $len - 1) }
      else { $end = [Math]::Min($len - 1, $start + $script:ChunkMax - 1) }
    } elseif ($b -ne '') {
      $start = [Math]::Max(0, $len - [long]$b)
    }
    if ($start -ge $len -or $start -gt $end) {
      $res.StatusCode = 416
      $res.AddHeader('Content-Range', "bytes */$len")
      try { $res.Close() } catch { }
      return
    }
    $res.StatusCode = 206
    $res.AddHeader('Content-Range', "bytes $start-$end/$len")
  }
  $count = $end - $start + 1
  $res.ContentLength64 = $count
  if ($Ctx.Request.HttpMethod -eq 'HEAD') { try { $res.Close() } catch { }; return }
  $fs = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
  try {
    [void]$fs.Seek($start, [IO.SeekOrigin]::Begin)
    $buf = New-Object byte[] 262144
    $left = $count
    while ($left -gt 0) {
      $n = $fs.Read($buf, 0, [int][Math]::Min($buf.Length, $left))
      if ($n -le 0) { break }
      # 对面不读就别死等：10 秒写不进去直接掐掉这个连接
      if (-not $res.OutputStream.WriteAsync($buf, 0, $n).Wait(10000)) { $res.Abort(); return }
      $left -= $n
    }
  } catch {
    # 拖进度条、换 PDF 时浏览器会中途断开，正常
  } finally {
    $fs.Dispose()
    try { $res.Close() } catch { }
  }
}

function Read-Body($Ctx) {
  $sr = New-Object IO.StreamReader($Ctx.Request.InputStream, $utf8)
  try { return $sr.ReadToEnd() } finally { $sr.Dispose() }
}

# 先写临时文件再 File.Replace（原子替换，顺手留一份 .bak），写一半断电也不会把记录弄坏
function Save-Json([string]$File, [string]$Text) {
  $tmp = $File + '.tmp'
  [IO.File]::WriteAllText($tmp, $Text, $utf8)
  if (Test-Path -LiteralPath $File) {
    [IO.File]::Replace($tmp, $File, $File + '.bak')
  } else {
    [IO.File]::Move($tmp, $File)
  }
}

# 考试自己的：$Title、$Ports、Invoke-ExamRoute（上面这些函数它都能用）
. (Join-Path $PSScriptRoot 'exam.ps1')

$script:ClosingAt = $null
$script:LastReq = Get-Date

function Invoke-Route($Ctx) {
  $req = $Ctx.Request
  $path = $req.Url.AbsolutePath
  $script:LastReq = Get-Date
  # 任何不带 ?closing=1 的请求 = 页面还活着（比如刷新了），清掉退出标记；所以关窗时页面发的每个 beacon 都得带它
  if ($path -ne '/api/closing' -and $req.QueryString['closing'] -ne '1') { $script:ClosingAt = $null }

  if ($path -eq '/' -or $path -eq '/index.html') { Send-File $Ctx (Join-Path $script:AppDir 'index.html') 'no-store'; return }
  if ($path.StartsWith('/papers/')) { Send-File $Ctx (Get-SafePath $script:PaperDir $path.Substring(8)) 'max-age=86400'; return }
  if (-not $path.StartsWith('/api/')) { Send-File $Ctx (Get-SafePath $script:AppDir $path) 'no-cache'; return }

  switch -Regex ($path) {
    '^/api/ping$' { Send-Text $Ctx '{"ok":true}'; return }
    # records = 做完的记录；active = 没交卷的那一场（关窗时页面用 sendBeacon 带 ?closing=1 发过来）
    '^/api/(records|active)$' {
      $file = Join-Path $script:DataDir ($Matches[1] + '.json')
      if ($req.HttpMethod -eq 'POST') {
        $body = (Read-Body $Ctx).Trim()
        if ($body -eq 'null') {
          if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force }
        } elseif ($body.StartsWith('{')) {
          Save-Json $file $body
        } else { Send-Text $Ctx '{"ok":false,"error":"bad body"}' -Code 400; return }
        if ($req.QueryString['closing'] -eq '1' -and -not $NoWindow) { $script:ClosingAt = Get-Date }
        Send-Text $Ctx '{"ok":true}'
      } else {
        $t = 'null'
        if (Test-Path -LiteralPath $file) { $t = [IO.File]::ReadAllText($file, $utf8) }
        Send-Text $Ctx $t
      }
      return
    }
    '^/api/closing$' {
      if (-not $NoWindow) { $script:ClosingAt = Get-Date }
      Send-Text $Ctx '{"ok":true}'
      return
    }
    default {
      if (@(Invoke-ExamRoute $Ctx $path) -contains $true) { return }
      Send-Text $Ctx '{"error":"no route"}' -Code 404
    }
  }
}

function Open-AppWindow([int]$P) {
  $url = "http://127.0.0.1:$P/"
  $profileDir = Join-Path $script:Root '.window'   # 独立 profile：不跟日常 Edge 混，随时可删
  $cands = @(
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
  )
  foreach ($b in $cands) {
    if (Test-Path -LiteralPath $b) {
      Start-Process -FilePath $b -ArgumentList @(
        "--app=$url", "--user-data-dir=`"$profileDir`"", '--start-maximized',
        '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
        '--disable-component-update', '--disable-sync', '--disable-extensions', '--disable-default-apps',
        '--disable-breakpad', '--no-service-autorun', '--autoplay-policy=no-user-gesture-required'
      ) | Out-Null
      return
    }
  }
  Start-Process $url   # 实在没有 Edge/Chrome 就用默认浏览器
}

# ---- 单实例：已经在跑就把那个窗口叫到前面 ----
if ($isDefaultPort -and (Test-Path -LiteralPath $script:PortFile)) {
  $old = 0
  [void][int]::TryParse(([IO.File]::ReadAllText($script:PortFile)).Trim(), [ref]$old)
  if ($old -gt 0) {
    try {
      $probe = [Net.HttpWebRequest]::Create("http://127.0.0.1:$old/api/ping")
      $probe.Timeout = 1500
      $probe.GetResponse().Close()
      $sh = New-Object -ComObject WScript.Shell
      if (-not $sh.AppActivate($Title)) { Open-AppWindow $old }
      exit 0
    } catch { }   # 探测失败 = 残留的旧记录，正常启动
  }
}

# ---- 起服务 ----
$listener = $null
$tryPorts = if ($isDefaultPort) { $Ports } else { @($Port) }
foreach ($p in $tryPorts) {
  $l = New-Object Net.HttpListener
  $l.Prefixes.Add("http://127.0.0.1:$p/")
  try { $l.Start(); $listener = $l; $Port = $p; break } catch { $l.Close() }
}
if (-not $listener) {
  $sh = New-Object -ComObject WScript.Shell
  [void]$sh.Popup("$($Ports[0])–$($Ports[-1]) 端口都被占了，$Title 起不来。", 0, $Title, 16)
  exit 1
}
if ($isDefaultPort) { [IO.File]::WriteAllText($script:PortFile, "$Port") }
if (-not $NoWindow) { Open-AppWindow $Port }
Write-Host "$Title http://127.0.0.1:$Port/"

# 退出：窗口关闭时页面 sendBeacon /api/closing，8 秒内没新请求就退（刷新页面会马上有新请求，不会误杀）；
# 兜底：30 分钟一个请求都没有（页面每分钟 ping 一次）。
try {
  while ($listener.IsListening) {
    $task = $listener.GetContextAsync()
    $quit = $false
    while (-not $task.Wait(500)) {
      if ($script:ClosingAt -and ((Get-Date) - $script:ClosingAt).TotalSeconds -gt 8) { $quit = $true; break }
      if (((Get-Date) - $script:LastReq).TotalMinutes -gt 30) { $quit = $true; break }
    }
    if ($quit) { break }
    $ctx = $task.Result
    try { Invoke-Route $ctx }
    catch {
      try { Send-Text $ctx ('{"ok":false,"error":' + (ConvertTo-Json $_.Exception.Message) + '}') -Code 500 } catch { }
    }
  }
} finally {
  try { $listener.Stop(); $listener.Close() } catch { }
  # 只删自己登记的端口：并存的另一个实例可能已经改写成它的了
  if ($isDefaultPort -and (Test-Path -LiteralPath $script:PortFile)) {
    try { if (([IO.File]::ReadAllText($script:PortFile)).Trim() -eq "$Port") { Remove-Item -LiteralPath $script:PortFile -Force } } catch { }
  }
}
