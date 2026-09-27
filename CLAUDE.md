# TOPIK 做题

官网「학습 자료실」公开的最近 10 回 × TOPIK I/II 共 20 套的桌面刷题工具；用法、功能见 `README.md`。
`TOPIK做题.bat` → `lib\server.ps1`（本地 HttpListener）→ Edge `--app` 窗口，前端在 `app/`。

- **运行时零依赖**（只有 PowerShell + Edge），别引入 Python/Node。
- `scratch/` 不是草稿：下载、整理、抄答案、定位、译文的 Python 流水线在这里，别清。
  `app/data/` 的 `keys.js` `tests.js` `trans.js` 由它生成，别手改；各脚本用法写在文件开头。`levels.js` 手写。
- 官网出新的一回：`links.py <回>` → `download.py` → `organize.py <回>` → `build_keys.py sheets` 抄正答表进
  `keys_manual.json` → `build_keys.py` → `pages.py <回>` → 写 `scratch/trans/<回>-<级>.txt` → `build_trans.py <回>`。
- **跟 JLPT 做题（另一个仓库）共用一套内核**：两个仓库克隆到同一个文件夹下，文件夹名就叫 `jlpt` 和 `topik`。
  共用文件（清单是 `lib/sync-core.ps1` 的 `$Files`）两边必须一模一样：改哪边都行，改完跑 `pwsh -File lib\sync-core.ps1`
  复制到另一边（两边都改过会报冲突），再两边各自提交。只属于 TOPIK 的（读数据、算分、说明文字）放
  `app/exam.*` `lib/exam.ps1`；`app/data/` 文件名两边一样、格式各管各的。两边 `README.md` 的界面说明是平行写的，改界面两边一起改。
- 仓库带着 `papers/` 的页面图和 mp3（做题只用这些），不带原版 PDF（`.gitignore`）；PDF 只有流水线读，
  要重新生成数据先按上面的 `links.py` → `download.py` → `organize.py` 再下。

## Gotchas
- `.ps1` 里中文乱码或解析报错 -> 没存成 UTF-8 with BOM -> 含中文的 `.ps1` 一律带 BOM；`.bat` 反过来必须纯 ASCII 无 BOM。
  `.gitattributes` 是 `* -text`，git 原样存，不会改 BOM 和换行。
- 生成数据要用仓库外的东西（做题不用）：`pip install -r scratch\requirements.txt`；ffmpeg/ffprobe（环境变量 `FFMPEG`
  或 PATH，作者本机是 LosslessCut 带的）；Windows OCR 中文识别器 + 韩文 OCR 包。换电脑要重装。

## State
- 完成并实测，可用。官网一共只公开 12 回，没做的是 35、36。2026-09-26 拆成内核 + `exam.*`，行为跟 JLPT 做成一样；
  37 回只有整段录音，09-27 起也能点题跳录音（每题起点 `scratch/cues.py` 按静音算）。
- 决定：不做「导入自备卷」（JLPT 有）；题型名只写卷面说明能对上的；听力译文是 Claude 翻的，无官方版；
  听力模考和练习都随便放（用户定的：不要「只放一遍、放完收卷」）。
- 2026-09-27 准备公开到 GitHub（用户定的：公开、带卷子）。
