# 把 scratch/raw/<回次>/ 里官网原样的附件（PDF / zip / mp3，文件名各届写法都不一样）整理成统一结构：
#   papers/<回次>/I/  paper.pdf（듣기+읽기） script.pdf（듣기 통합 = 带原文的听力卷） answer.pdf  audio/00.mp3 01.mp3 …
#   papers/<回次>/II/ paper1.pdf（1교시 듣기·쓰기） paper2.pdf（2교시 읽기） script.pdf answer.pdf audio/…
# audio/00 是开场说明，NN 是第 NN 题（官方就是按题拆好的）；只有一整段录音的届（37 回）存成 audio/full.mp3。
# 60 回的听力是 WMA（浏览器放不了）-> 用 ffmpeg 转 mp3（ffmpeg 在哪见 cues.py 的 FFMPEG）。
# 用法：python scratch\organize.py    （已存在的文件跳过；删掉 papers/<回次> 可重做那一届）
import os, re, io, sys, glob, shutil, zipfile, subprocess
sys.stdout.reconfigure(encoding='utf-8'); sys.stderr.reconfigure(encoding='utf-8')   # 控制台默认 GBK，打印韩文会崩
import pymupdf

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, 'scratch', 'raw')
PAPERS = os.path.join(ROOT, 'papers')
from cues import FFMPEG
SPLIT12 = {37: 17}          # 1교시+2교시合在一个 PDF 的届：2교시封面是第几页（从 0 数）


def zname(info):
    n = info.filename
    if not (info.flag_bits & 0x800):          # 韩国的 zip 多是 CP949 且不打 UTF-8 标记
        try:
            n = n.encode('cp437').decode('cp949')
        except Exception:
            pass
    return n


def entries(n):
    """一届的所有文件：[(文件名, 读字节的函数)]，zip 里的也展开"""
    out = []
    for f in sorted(glob.glob(os.path.join(RAW, str(n), '*'))):
        if f.endswith('.part'):
            continue
        if f.lower().endswith('.zip'):
            z = zipfile.ZipFile(f)
            zlv = level_of(os.path.basename(f))
            for info in z.infolist():
                if not info.is_dir():
                    out.append((os.path.basename(zname(info)), (lambda z=z, info=info: z.read(info)), zlv))
        else:
            out.append((os.path.basename(f), (lambda f=f: open(f, 'rb').read()), None))
    return out


def level_of(name, fallback=None):
    s = name.replace(' ', '').replace('Ⅱ', 'II').replace('Ⅰ', 'I').replace('토픽', 'TOPIK').upper()
    if 'TOPIKII' in s or 'TOPIK2' in s:
        return 'II'
    if 'TOPIKI' in s or 'TOPIK1' in s:
        return 'I'
    return fallback


def kind_of(name):
    s = name.replace(' ', '')
    ext = os.path.splitext(s)[1].lower()
    if ext in ('.mp3', '.wma', '.wav', '.m4a'):
        return 'audio'
    if ext != '.pdf':
        return None
    if '정답' in s or '채점' in s:
        return 'answer'
    if '통합' in s or '대본' in s:
        return 'script'
    if '듣기쓰기읽기' in s:
        return 'paper12'
    if '듣기,쓰기' in s or '듣기쓰기' in s:
        return 'paper1'
    if '읽기' in s and '듣기' not in s:
        return 'paper2'
    if '듣기' in s and '읽기' in s:
        return 'paper'
    return None


def track_no(name):
    """音频文件名 -> 题号（0 = 开场说明）；认不出返回 None"""
    base = os.path.splitext(name)[0]
    if '안내' in base:
        return 0
    m = re.match(r'^(\d+)\s*트랙', base)          # "01 트랙 1" = 第 1 轨 = 开场说明，第 k+1 轨 = 第 k 题
    if m:
        return int(m.group(1)) - 1
    m = re.match(r'^[12]-(\d+)$', base)            # "1-00" / "2-37"
    if m:
        return int(m.group(1))
    m = re.match(r'^(\d+)$', base)                 # 41 回："01".."30"，开场说明另有「안내」
    if m:
        return int(m.group(1))
    return None


def write(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path + '.tmp', 'wb') as f:
        f.write(data)
    os.replace(path + '.tmp', path)


def merge_pdfs(blobs):
    out = pymupdf.open()
    for b in blobs:
        out.insert_pdf(pymupdf.open(stream=b, filetype='pdf'))
    return out.tobytes(garbage=3, deflate=True)


def to_mp3(data, ext, dst):
    if ext == '.mp3':
        return write(dst, data)
    tmp = dst + ext
    write(tmp, data)
    subprocess.run([FFMPEG, '-v', 'error', '-y', '-i', tmp, '-codec:a', 'libmp3lame', '-q:a', '4', dst], check=True)
    os.remove(tmp)


def main(only=None):
    report = []
    for d in sorted(glob.glob(os.path.join(RAW, '*')), key=lambda p: -int(os.path.basename(p))):
        n = int(os.path.basename(d))
        if only and n not in only:
            continue
        groups = {}
        for name, get, zlv in entries(n):
            k = kind_of(name)
            if k:                                 # zip 里的文件名不带级别（音频、60 回的正答表）-> 用 zip 名的级别
                groups.setdefault(level_of(name, zlv), {}).setdefault(k, []).append((name, get))
        for lv in ('I', 'II'):
            g = groups.get(lv, {})
            out = os.path.join(PAPERS, str(n), lv)
            got = []
            def put(kind, fname):
                items = g.get(kind, [])
                if not items:
                    return
                dst = os.path.join(out, fname)
                if not os.path.exists(dst):
                    if kind == 'answer' and len(items) > 1:          # 60 回 TOPIK I：듣기、읽기 两个正答表 -> 合并，듣기在前
                        items = sorted(items, key=lambda x: ('읽기' in x[0], x[0]))
                        write(dst, merge_pdfs([get() for _, get in items]))
                    else:
                        # 41 回 TOPIK II 有两份内容一样的 듣기통합，取带「대본」的那份
                        items = sorted(items, key=lambda x: ('대본' not in x[0], x[0]))
                        write(dst, items[0][1]())
                got.append(fname)
            if lv == 'I':
                put('paper', 'paper.pdf')
            else:
                put('paper1', 'paper1.pdf'); put('paper2', 'paper2.pdf')
                if g.get('paper12'):                 # 37 回 TOPIK II：1교시+2교시 一个 PDF -> 在 2교시封面那页切开
                    doc = pymupdf.open(stream=g['paper12'][0][1](), filetype='pdf')
                    cut = SPLIT12[n]
                    for fname, rng in (('paper1.pdf', (0, cut - 1)), ('paper2.pdf', (cut, len(doc) - 1))):
                        dst = os.path.join(out, fname)
                        if not os.path.exists(dst):
                            part = pymupdf.open(); part.insert_pdf(doc, from_page=rng[0], to_page=rng[1])
                            write(dst, part.tobytes(garbage=3, deflate=True))
                        got.append(fname)
            put('script', 'script.pdf'); put('answer', 'answer.pdf')
            tracks = {}
            for name, get in g.get('audio', []):
                t = track_no(name)
                if t is None:
                    tracks.setdefault('full', []).append((name, get))
                else:
                    tracks[t] = (name, get)
            if 'full' in tracks:
                name, get = tracks.pop('full')[0]
                dst = os.path.join(out, 'audio', 'full.mp3')
                if not os.path.exists(dst):
                    to_mp3(get(), os.path.splitext(name)[1].lower(), dst)
            for t, (name, get) in tracks.items():
                dst = os.path.join(out, 'audio', f'{t:02d}.mp3')
                if not os.path.exists(dst):
                    to_mp3(get(), os.path.splitext(name)[1].lower(), dst)
            nums = sorted(tracks)
            audio = ('full' if os.path.exists(os.path.join(out, 'audio', 'full.mp3')) else '') + \
                    (f' {nums[0]:02d}–{nums[-1]:02d} ({len(nums)})' if nums else '')
            report.append(f'{n:>3} {lv:<2} {" ".join(got):<45} audio:{audio}')
    print('\n'.join(report))


if __name__ == '__main__':
    main([int(x) for x in sys.argv[1:]] or None)
