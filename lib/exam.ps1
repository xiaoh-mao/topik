# TOPIK 做题 —— 本地服务里 TOPIK 自己的部分，由 lib\server.ps1（内核）dot-source 进来。
$Title = 'TOPIK 做题'    # 必须和 app\exam.js 的 EXAM.name 一致（那是窗口标题），AppActivate 靠它找窗口
$Ports = 8860..8879      # 默认端口段（JLPT 做题用 8830–8849，错开）；调试实例用 8880

# 内核没有的 /api/ 路由：处理了就返回 $true。TOPIK 没有。
function Invoke-ExamRoute($Ctx, [string]$Path) { return $false }
