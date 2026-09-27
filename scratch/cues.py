# 只有一整段录音的那几回（audio/full.mp3，目前是 37 回）：每道听力题在录音里从第几秒开始 -> tests.js 的 cue（pages.py 调）。
#   每题后面是一段长静音（作答时间，9–35 秒），第 k 题从第 k−1 段长静音结束处开始；长静音段数必须正好等于题数。
#   第 1 题从「第一段 ≥1.5 秒的停顿」结束处开始：开场说明（和紧跟着的过门音乐）底下一直垫着音乐，中间静不下来，
#   第一次真静下来就是音乐完了、要念「[1~4] 다음을 듣고…」了。有的回音乐完了只停半秒就开念（41-II、47-I/II），
#   那样第一段停顿落在第 1 题里面：所以还要看停顿前 8 秒是不是音乐（没有一帧静音），不是就停下。
#   做法照 ../jlpt/scratch/cues.py；静音检测结果缓存在 scratch/sil/。
# 核对：python scratch\cues.py --check 41-I 64-II …  把按题拆好的那几回拼成一整段再算，跟真实的拆分点比。
#   2026-09-27 核对过 18 套：14 套第 1 题差 ≤1.1 秒、之后每题只比拆分点晚 0.1–2.3 秒（拆分点前头带点静音）；
#   41-II、47-I、47-II 被第 1 题那道检查拦下；91-II 开头几题作答静音不到 8 秒，段数对不上也拦下。算错的都会停，不会悄悄写进去。
import os, re, sys, glob, shutil, subprocess
import numpy as np
sys.stdout.reconfigure(encoding='utf-8'); sys.stderr.reconfigure(encoding='utf-8')
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
FFMPEG = os.environ.get('FFMPEG') or shutil.which('ffmpeg') or r'D:\losslesscut\resources\ffmpeg.exe'   # 环境变量 FFMPEG > PATH > 作者本机
LONG = 8           # 作答静音至少这么长（一般 12–35 秒，最后一题后面紧跟收尾播报的只有 9 秒）；题目里面的停顿最长 6 秒
PAUSE = 1.5


def silences(cache, args):
    """ffmpeg silencedetect -> [(起, 止)]；结果缓存。录音以静音结尾时最后那段没有 silence_end，补上"""
    if not os.path.exists(cache):
        os.makedirs(os.path.dirname(cache), exist_ok=True)
        r = subprocess.run([FFMPEG, '-hide_banner', *args, '-af', f'silencedetect=noise=-40dB:d={PAUSE}', '-f', 'null', '-'], capture_output=True)
        open(cache, 'w', encoding='utf-8').write(r.stderr.decode('utf-8', 'replace'))
    txt = open(cache, encoding='utf-8').read()
    t = re.findall(r'time=(\d+):(\d+):([\d.]+)', txt)[-1]          # 解码到的最后时刻 = 总长（拼接输入没有 Duration）
    out = [(float(e) - float(d), float(e)) for e, d in re.findall(r'silence_end: ([\d.]+) \| silence_duration: ([\d.]+)', txt)]
    starts = re.findall(r'silence_start: ([\d.]+)', txt)
    if len(starts) > len(out): out.append((float(starts[-1]), int(t[0]) * 3600 + int(t[1]) * 60 + float(t[2])))
    return out


def quiet_frames(args, t0, t1):
    """t0–t1 秒里有几个 50 ms 帧低于 -60 dB（人声的字间空隙会有；垫着音乐就一个都没有）"""
    r = subprocess.run([FFMPEG, '-v', 'error', '-ss', str(t0), *args, '-t', str(t1 - t0), '-ac', '1', '-ar', '8000', '-f', 's16le', '-'], capture_output=True)
    a = np.frombuffer(r.stdout, np.int16).astype(float) / 32768
    fr = a[:len(a) // 400 * 400].reshape(-1, 400)
    return int((20 * np.log10(np.sqrt((fr ** 2).mean(1)) + 1e-9) < -60).sum())


def find(args, cache, n):
    """-> 每题起点（秒）；找不准就 raise ValueError"""
    sil = silences(cache, args)
    long = [s for s in sil if s[1] - s[0] >= LONG]
    if len(long) != n:
        raise ValueError(f'作答静音 {len(long)} 段，应有 {n} 题（{" ".join(f"{a:.0f}-{b:.0f}" for a, b in long)}）')
    p0, p1 = sil[0]
    if sil[0] is long[0] or quiet_frames(args, max(0, p0 - 8), p0 - .5):
        raise ValueError(f'第 1 题的起点找不准：{p0:.1f} 秒那段停顿前面不是片头音乐，得对着录音手动定')
    return [p1] + [s[1] for s in long[:-1]]


def cues(n, lv, nq):
    """37 回这种：papers/<回>/<级>/audio/full.mp3 -> [第 1..nq 题的 cue 秒]"""
    path = os.path.join(ROOT, 'papers', str(n), lv, 'audio', 'full.mp3')
    try:
        starts = find(['-i', path], os.path.join(HERE, 'sil', f'{n}-{lv}-full.txt'), nq)
    except ValueError as e:
        sys.exit(f'{n}-{lv} 整段录音：{e}')
    return [round(max(0, t - .4), 1) for t in starts]          # 往前留一点，别切掉题号的头


def check(tid):
    n, lv = tid.split('-')
    files = sorted(glob.glob(os.path.join(ROOT, 'papers', n, lv, 'audio', '[0-9][0-9].mp3')))
    lst = os.path.join(HERE, 'sil', f'{tid}-concat.lst')
    os.makedirs(os.path.dirname(lst), exist_ok=True)
    open(lst, 'w', encoding='utf-8').write(''.join("file '%s'\n" % f.replace('\\', '/') for f in files))
    durs = [float(subprocess.run([os.path.join(os.path.dirname(FFMPEG), 'ffprobe.exe'), '-v', 'error', '-show_entries', 'format=duration',
                                  '-of', 'csv=p=0', f], capture_output=True, text=True).stdout) for f in files]
    real = [sum(durs[:k]) for k in range(1, len(files))]          # 01.mp3 … 在拼接里的起点
    try:
        got = find(['-f', 'concat', '-safe', '0', '-i', lst], os.path.join(HERE, 'sil', f'{tid}-concat.txt'), len(real))
    except ValueError as e:
        print(f'{tid}：{e}'); return
    err = [g - r for g, r in zip(got, real)]
    print(f'{tid}：第 1 题差 {err[0]:+.1f} 秒，其余最多差 {max(err[1:], key=abs):+.1f} 秒（正 = 比拆分点晚）')


if __name__ == '__main__':
    if sys.argv[1:2] == ['--check']:
        for t in sys.argv[2:]: check(t)
    else:
        sys.exit('pages.py 会调它；单独跑只用来核对：--check <回-级> …')
