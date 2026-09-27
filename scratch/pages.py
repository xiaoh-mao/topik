# 卷子 PDF -> 页面图 + 每道题在哪一页哪个高度 + 大题分组（[1~4] 这种）-> app/data/tests.js
#   papers/<回>/<级>/img/<doc>-<页>.jpg   150 dpi 灰度（新卷是矢量字形、老卷是低清扫描，都没有文字层）
#   定位靠 Windows OCR（本机只有中文识别器，韩文会乱，但题号数字和 [a~b] 认得出来）：
#     整页 OCR 找左边距上的「N.」和「[a~b]」；再把左边距那一条放大到 300 dpi 单独 OCR 一遍补漏；
#     候选按页序排好取「题号严格递增」的最长子序列（去掉注意事项页的 1.–7. 之类噪声）；
#     再找左边距那一窄列里的每一行（只有题号和 ※ 会出现在那儿），※ 靠跟 OCR 认出的组头行比字形剔掉，
#     两个锚点之间剩下的行数正好够就按顺序认成题号；还认不出的按前后锚点插值（exact=0，界面上画虚线）。
#   核对：python scratch\overlay.py <回-级> <doc> <起页> <止页> 把位置画回页面看。
#   대본（S）里的题号再用韩文 OCR 对一遍：翻错页的、插值估的换成韩文 OCR 认到的（script_pos，build_trans.py 也用）。
#   只有整段录音的回（37 回）每题在录音里从第几秒开始：scratch\cues.py。
# OCR 结果缓存在 scratch/ocr/（*.txt），删了才会重跑（要几分钟）。用法：python scratch\pages.py [回次…]
import os, re, sys, json, glob, subprocess
sys.stdout.reconfigure(encoding='utf-8'); sys.stderr.reconfigure(encoding='utf-8')   # 控制台默认 GBK，打印韩文会崩
import numpy as np
import pymupdf
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cues

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PAPERS = os.path.join(ROOT, 'papers')
OCRDIR = os.path.join(HERE, 'ocr')
OUT = os.path.join(ROOT, 'app', 'data', 'tests.js')
DPI = 150
YEAR = {102: 2025, 96: 2024, 91: 2023, 83: 2022, 64: 2019, 60: 2018, 52: 2017, 47: 2016, 41: 2015, 37: 2014}
# 各文档里有哪些题：(科目, 起, 止)
LAYOUT = {
    'I': {'paper': [('L', 1, 30), ('R', 31, 70)], 'script': [('L', 1, 30)]},
    'II': {'paper1': [('L', 1, 50), ('W', 51, 54)], 'paper2': [('R', 1, 50)], 'script': [('L', 1, 50)]},
}


def render(pdf, outdir, doc):
    """渲染成 JPEG（已存在跳过），返回 [(路径, 宽, 高)]"""
    os.makedirs(outdir, exist_ok=True)
    d = pymupdf.open(pdf)
    res = []
    for i in range(len(d)):
        p = os.path.join(outdir, f'{doc}-{i + 1:02d}.jpg')
        if not os.path.exists(p):
            pix = d[i].get_pixmap(dpi=DPI, colorspace=pymupdf.csGRAY)
            open(p, 'wb').write(pix.tobytes('jpg', jpg_quality=75))
            w, h = pix.width, pix.height
        else:
            r = d[i].rect; w, h = round(r.width * DPI / 72), round(r.height * DPI / 72)
        res.append((p, w, h))
    return res


def strips(pdf, tag):
    """左边距那一条（300 dpi，x 330–560 ≈ 150 dpi 的 165–280）存 PNG 给 OCR"""
    os.makedirs(os.path.join(OCRDIR, 'strip'), exist_ok=True)
    d = pymupdf.open(pdf)
    out = []
    for i in range(len(d)):
        p = os.path.join(OCRDIR, 'strip', f'{tag}-{i + 1:02d}.png')
        if not os.path.exists(p):
            pix = d[i].get_pixmap(dpi=300, colorspace=pymupdf.csGRAY)
            a = np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.width)
            canvas = np.full((a.shape[0], 900), 255, np.uint8)
            canvas[:, :230] = a[:, 330:560]
            canvas = np.ascontiguousarray(canvas)
            pymupdf.Pixmap(pymupdf.csGRAY, canvas.shape[1], canvas.shape[0], canvas.tobytes(), 0).save(p)
        out.append(p)
    return out


def ocr(files, cache, lang=''):
    """-> {页序号(0 起): [(x, y, w, h, text)]}，结果缓存。lang 不给 = 中文识别器（认数字准），'ko' = 韩文识别器"""
    if not os.path.exists(cache):
        r = subprocess.run(['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', os.path.join(HERE, 'ocr.ps1')]
                           + (['-Lang', lang] if lang else []) + files, capture_output=True)
        txt = r.stdout.decode('utf-8', 'replace')
        if '###' not in txt:
            raise RuntimeError('OCR 失败：' + r.stderr.decode('utf-8', 'replace')[:500])
        open(cache, 'w', encoding='utf-8').write(txt)
    pages, cur = {}, None
    names = [os.path.basename(f) for f in files]
    for ln in open(cache, encoding='utf-8').read().splitlines():
        if ln.startswith('### '):
            cur = names.index(os.path.basename(ln[4:].strip()))
            pages[cur] = []
        elif '\t' in ln and cur is not None:
            geo, text = ln.split('\t', 1)
            x, y, w, h = map(int, geo.split())
            pages[cur].append((x, y, w, h, text))
    return pages


def script_ko(n, lv, npg):
    """대본页面图的韩文 OCR（要装 Windows 韩文 OCR 包）；build_trans.py 也用它找 ※[a~b] 说明行"""
    files = [os.path.join(PAPERS, str(n), lv, 'img', f'script-{i + 1:02d}.jpg') for i in range(npg)]
    return ocr(files, os.path.join(OCRDIR, f'{n}-{lv}-script-ko.txt'), 'ko')


def script_pos(S, ko):
    """대본里每题题号在哪：[(页, y) | None]。优先用韩文 OCR 认到的「N.」（中文识别器找的 S 在老卷上有翻错页、插值估的），
    认不到就用 S；S 也是估的，拿前后两题之间落单的「…고르십시오」题干行补，还没有就是 None（不可信）。
    build() 用它修 S；build_trans.py 用它定译文插在哪（修过的 S 再算一遍结果不变）。"""
    found, stems = {}, []
    for p in sorted(ko):
        for x, y, w, h, txt in ko[p]:
            m = re.match(r'^(\d{1,2})\s*\.', txt)
            if m and x < 240 and int(m[1]) <= len(S): found.setdefault(int(m[1]), []).append((p, y))
            elif x < 240 and '고르십시' in txt and not re.match(r'^(※\s*)?\[', txt): stems.append((p, y))
    pos = []
    for q, (_, p, y, ok) in enumerate(S, 1):
        c = found.get(q, [])
        pos.append(min(c, key=lambda m: (abs(m[0] - p), abs(m[1] - y))) if c else (p, y) if ok else None)
    # 题号认花了（「%.」「77.」、整个丢了）的，拿前后两题之间落单的题干行补上
    for i, v in enumerate(pos):
        if v: continue
        lo = next((pos[j] for j in range(i - 1, -1, -1) if pos[j]), (-1, 0))
        hi = next((pos[j] for j in range(i + 1, len(pos)) if pos[j]), (99, 0))
        c = [s for s in stems if lo < s < hi and s not in pos]
        if c: pos[i] = c[0]
    return pos


NUM = re.compile(r'^([lI|]?\d{1,2})\s*[.．,，、`\'・。]')
HDR = re.compile(r'\[\s*(\d{1,2})?\s*[·～~一—\-－‐・、]+\s*(\d{1,2})?')


def num_of(s):
    s = s.replace(' ', '')
    m = NUM.match(s)
    if not m:
        return None
    return int(re.sub(r'^[lI|]', '1', m.group(1)))


def candidates(full, strip):
    """-> 题号候选 [(num, page, y, src)] 和 组头 [(a, b|None, page, y)]"""
    cands, hdrs, hrows = [], [], []
    xs = [x for p in full.values() for x, y, w, h, t in p if num_of(t) is not None]
    margin = int(np.median(xs)) if xs else 178
    for p, lines in full.items():                  # 组头那一行（不管数字认没认出来）：左边距上是 ※，不是题号
        for x, y, w, h, t in lines:
            tt = t.lstrip()
            if (tt.startswith('[') and 200 <= x <= 250) or tt.startswith('※'):
                hrows.append((p, y))
    for p, lines in strip.items():
        for x, y, w, h, t in lines:
            tt = t.lstrip()
            if tt.startswith('※') or (tt.startswith('[') and x < 200):
                hrows.append((p, y // 2))
    for p, lines in full.items():
        for x, y, w, h, t in lines:
            n = num_of(t)
            if n is not None and abs(x - margin) <= 14:
                cands.append((n, p, y, 'full'))
            m = HDR.search(t.replace(' ', ''))
            if m and t.lstrip().startswith('[') and 200 <= x <= 250 and (m.group(1) or m.group(2)):
                hdrs.append((int(m.group(1)) if m.group(1) else None, int(m.group(2)) if m.group(2) else None, p, y))
    for p, lines in strip.items():
        for x, y, w, h, t in lines:
            y2 = y // 2
            n = num_of(t)
            if n is not None and x < 120:           # 条里 x<120（300dpi）≈ 原页左边距
                cands.append((n, p, y2, 'strip'))
            m = HDR.search(t.replace(' ', ''))
            if m and t.lstrip().lstrip('※').lstrip().startswith('[') and m.group(1):
                hdrs.append((int(m.group(1)), int(m.group(2)) if m.group(2) else None, p, y2))
    return cands, hdrs, hrows, margin


def margin_rows(img, margin, H):
    """左边距那一窄条（题号所在列）里的文字行 -> [y 中心]。选项、正文都缩进在右边，不会进来。"""
    band = img[:, max(0, margin - 8):margin + 26] < 165
    on = band.any(axis=1)
    rows, s0, gap = [], None, 0
    for y, v in enumerate(on):
        if v:
            if s0 is None:
                s0 = y
            gap = 0
        elif s0 is not None:
            gap += 1
            if gap > 4:
                e = y - gap
                if 10 <= e - s0 <= 45 and 140 < s0 and e < H - 110:     # 顶上 140 px 是页眉
                    rows.append((s0 + e) // 2)
                s0, gap = None, 0
    return rows


def row_patch(img, margin, y, size=16):
    """左边距一行的字形（裁到墨迹外框、缩成 size×size），用来区分 ※ 和题号"""
    band = img[max(0, y - 16):y + 16, max(0, margin - 8):margin + 26] < 165
    ys, xs = np.nonzero(band)
    out = np.zeros((size, size), np.float32)
    if len(ys) < 3:
        return out
    g = band[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    h, w = g.shape
    s = size / max(h, w)
    yi = np.minimum((np.arange(max(1, round(h * s))) / s).astype(int), h - 1)
    xi = np.minimum((np.arange(max(1, round(w * s))) / s).astype(int), w - 1)
    small = g[yi][:, xi]
    out[:small.shape[0], :small.shape[1]] = small
    return out


def lis(items):
    """items 已按位置排好：[(num, ...)]，取 num 严格递增的最长子序列"""
    import bisect
    tails, tails_idx, prev = [], [], [-1] * len(items)
    for i, it in enumerate(items):
        k = bisect.bisect_left(tails, it[0])
        if k == len(tails):
            tails.append(it[0]); tails_idx.append(i)
        else:
            tails[k] = it[0]; tails_idx[k] = i
        prev[i] = tails_idx[k - 1] if k else -1
    out, i = [], tails_idx[-1] if tails_idx else -1
    while i >= 0:
        out.append(items[i]); i = prev[i]
    return out[::-1]


def locate(full, strip, lo, hi, H, imgs):
    """题号 lo..hi 的位置：{q: [page, y, exact]}；组 [[a, b, page, y]]"""
    cands, hdrs, hrows, margin = candidates(full, strip)
    # 组头 [a~b] 的位置也算 a 题的候选（在题号上面一点）
    pool = [(n, p, y, s) for n, p, y, s in cands if lo <= n <= hi]
    pool += [(a, p, y, 'hdr') for a, b, p, y in hdrs if a and lo <= a <= hi]
    pool.sort(key=lambda c: (c[1], c[2], c[0]))
    # 同一个题号在几乎同一位置出现多次（整页和条各认一次）只留一个
    ded = []
    for c in pool:
        if ded and ded[-1][0] == c[0] and ded[-1][1] == c[1] and abs(ded[-1][2] - c[2]) < 60:
            if ded[-1][3] == 'hdr' and c[3] != 'hdr':
                ded[-1] = c                           # 题号本身比组头准
            continue
        ded.append(c)
    chain = lis(ded)
    anchors = {}
    for n, p, y, s in chain:
        if n not in anchors or s != 'hdr':
            anchors[n] = (p, y, s)
    # 左边距的文字行 = 题号或 ※。OCR 认出组头的那几行是 ※ 的样本，其余行跟它比字形，像 ※ 的也剔掉；
    # 剩下的在两个锚点之间正好够数就按顺序认成题号
    allrows = [(p, y) for p, img in enumerate(imgs) for y in margin_rows(img, margin, H)]
    patch = {r: row_patch(imgs[r[0]], margin, r[1]) for r in allrows}
    is_hdr = {r: any(hp == r[0] and abs(hy - r[1]) < 18 for hp, hy in hrows) for r in allrows}
    stars = [patch[r] for r in allrows if is_hdr[r]]
    nums = [patch[(p, y)] for n, (p, y, s) in anchors.items() if s != 'hdr' and (p, y) in patch]
    nums += [patch[r] for r in allrows for n, (p, y, s) in anchors.items() if s != 'hdr' and r[0] == p and abs(r[1] - y) < 18]
    def looks_star(r):
        if not stars or not nums:
            return False
        ds = min(np.abs(patch[r] - t).mean() for t in stars)
        dn = min(np.abs(patch[r] - t).mean() for t in nums)
        return ds < dn
    rows = [r for r in allrows if not is_hdr[r] and not looks_star(r)]
    # 只认到组头 [a~b] 的 a 题：组头下面第一个题号行就是 a 自己
    for n, (p, y, s) in list(anchors.items()):
        if s == 'hdr':
            nxt = [r for r in rows if r[0] == p and y + 12 < r[1] < y + 400]
            later = [v for k, v in anchors.items() if k > n]
            if nxt and (not later or nxt[0] < (later[0][0], later[0][1])):
                anchors[n] = (*nxt[0], 'row')
    keys = sorted(anchors)
    for a, b in zip(keys, keys[1:]):
        if b - a < 2:
            continue
        (pa, ya, _), (pb, yb, _) = anchors[a], anchors[b]
        between = [r for r in rows if (pa, ya + 12) < r < (pb, yb - 12)]
        if len(between) == b - a - 1:
            for k, (p, y) in enumerate(between):
                anchors[a + 1 + k] = (p, y, 'row')
    # 最后一个锚点之后 / 第一个之前，行数刚好也补上
    keys = sorted(anchors)
    if keys and keys[-1] < hi:
        pa, ya, _ = anchors[keys[-1]]
        after = [r for r in rows if r > (pa, ya + 12)]
        if len(after) >= hi - keys[-1]:
            for k in range(hi - keys[-1]):
                anchors[keys[-1] + 1 + k] = (*after[k], 'row')
    anchors = {k: (v[0], v[1]) for k, v in anchors.items()}
    pos = {}
    keys = sorted(anchors)
    for q in range(lo, hi + 1):
        if q in anchors:
            pos[q] = [anchors[q][0], anchors[q][1], 1]
            continue
        before = [k for k in keys if k < q]
        after = [k for k in keys if k > q]
        if before and after:
            a, b = before[-1], after[0]
            (pa, ya), (pb, yb) = anchors[a], anchors[b]
            t = (q - a) / (b - a)
            if pa == pb:
                pos[q] = [pa, round(ya + t * (yb - ya)), 0]
            else:
                ca, cb = pa + ya / H, pb + yb / H
                c = ca + t * (cb - ca)
                pg = int(c)
                pos[q] = [pg, round((c - pg) * H * 0.9), 0]
        elif before:
            pos[q] = [anchors[before[-1]][0], anchors[before[-1]][1] + 40, 0]
        elif after:
            pos[q] = [anchors[after[0]][0], max(0, anchors[after[0]][1] - 40), 0]
        else:
            pos[q] = [0, 0, 0]
    # 组：组头按位置排，取 a 在范围内且递增的
    hs = sorted({(p, y, a, b) for a, b, p, y in hdrs if a and lo <= a <= hi}, key=lambda h: (h[0], h[1]))
    seen = set()                                   # 跨页的组，下一页顶上会把 [a~b] 说明再印一遍 -> 只认第一次出现的
    hs = [h for h in hs if not (h[2] in seen or seen.add(h[2]))]
    hs = lis([(a, p, y, b) for p, y, a, b in hs])
    starts = [a for a, p, y, b in hs]
    groups, gy = [], {a: (p, y) for a, p, y, b in hs}
    if not starts or starts[0] != lo:
        starts = [lo] + starts
    for i, a in enumerate(starts):
        b = (starts[i + 1] - 1) if i + 1 < len(starts) else hi
        p, y = gy.get(a, (pos[a][0], max(0, pos[a][1] - 40)))
        groups.append([a, b, p, y])
    return pos, groups, len(keys)


def build(n, lv):
    base = os.path.join(PAPERS, str(n), lv)
    t = {'n': n, 'year': YEAR[n], 'level': lv, 'docs': {}, 'q': {}, 'groups': {}}
    found = {}
    for doc in ('paper', 'paper1', 'paper2', 'script', 'answer'):
        pdf = os.path.join(base, doc + '.pdf')
        if not os.path.exists(pdf):
            continue
        pages = render(pdf, os.path.join(base, 'img'), doc)
        W, H = pages[0][1], pages[0][2]
        t['docs'][doc] = {'pages': len(pages), 'w': W, 'h': H}
        if doc not in LAYOUT[lv]:
            continue
        tag = f'{n}-{lv}-{doc}'
        full = ocr([p for p, _, _ in pages], os.path.join(OCRDIR, tag + '.txt'))
        scache = os.path.join(OCRDIR, tag + '-strip.txt')
        if os.path.exists(scache):             # 有缓存就不用再切图，只要文件名对得上
            sfiles = [os.path.join(OCRDIR, 'strip', f'{tag}-{i + 1:02d}.png') for i in range(len(pages))]
        else:
            sfiles = strips(pdf, tag)
        strip = ocr(sfiles, scache)
        for f in sfiles:                         # 条图只是 OCR 的输入，用完就删
            if os.path.exists(f):
                os.remove(f)
        for sec, lo, hi in LAYOUT[lv][doc]:
            imgs = [np.frombuffer((pm := pymupdf.Pixmap(p)).samples, np.uint8).reshape(pm.height, pm.width) for p, _, _ in pages]
            pos, groups, nfound = locate(full, strip, lo, hi, H, imgs)
            key = sec if doc != 'script' else 'S'
            t['q'][key] = [[doc] + pos[q] for q in range(lo, hi + 1)]
            t['groups'][key] = groups
            found[key] = f'{nfound}/{hi - lo + 1}'
    if 'S' in t['q']:                            # 대본里的题号：翻错页或是插值估的，换成韩文 OCR 认到的
        S = t['q']['S']
        for q, ((_, p, y, ok), v) in enumerate(zip(S, script_pos(S, script_ko(n, lv, t['docs']['script']['pages']))), 1):
            if v and v != (p, y) and (v[0] != p or not ok):
                S[q - 1] = ['script', v[0], v[1], 1]
                print(f'  {n}-{lv} {q}번 대본：{p}/{y} -> {v[0]}/{v[1]}')
            if not v: print(f'  {n}-{lv} {q}번 대본：位置是估的，韩文 OCR 也没认到')
    a = os.path.join(base, 'audio')
    if os.path.exists(os.path.join(a, 'full.mp3')):
        t['audio'] = 'full'
        t['cue'] = cues.cues(n, lv, LAYOUT[lv]['script'][0][2])     # 听力题数
    else:
        t['audio'] = len(glob.glob(os.path.join(a, '[0-9][0-9].mp3')))
    if lv == 'II':
        t['wpage'] = writing_page(os.path.join(base, 'answer.pdf'))
    return t, found


def writing_page(pdf):
    """正答表里写作模范答案那一页（3 列的表：번호 | 모범답안 | 배점），从 0 数"""
    sys.path.insert(0, HERE)
    import cells
    for p in range(len(pymupdf.open(pdf))):
        if any(len(t['cols']) == 4 for t in cells.tables(cells.page_gray(pdf, p, 100))):
            return p
    return 1


def main(only):
    os.makedirs(OCRDIR, exist_ok=True)
    miss = [n for n in only if n not in YEAR]
    if miss:
        sys.exit(f'YEAR 里没有 {miss}：新的一回先在 YEAR 加一行（回次: 考试年份）')
    tests = {}
    if os.path.exists(OUT) and only:
        s = open(OUT, encoding='utf-8').read()
        tests = json.loads(s[s.index('{'):s.rindex('}') + 1])
    for n in sorted(YEAR, reverse=True):
        if only and n not in only:
            continue
        for lv in ('I', 'II'):
            t, found = build(n, lv)
            tests[f'{n}-{lv}'] = t
            print(f'{n}-{lv}', ' '.join(f'{k}:{v}' for k, v in found.items()), 'groups', {k: len(v) for k, v in t['groups'].items()}, flush=True)
    tests = dict(sorted(tests.items(), key=lambda x: (-int(x[0].split('-')[0]), x[0])))
    js = ('// 由 scratch/pages.py 生成，别手改。docs：各 PDF 渲染成的页面图（papers/<回>/<级>/img/<doc>-<页>.jpg）的页数和像素尺寸；\n'
          '// q：每道题 [doc, 页(0 起), y 像素, 1=OCR 认到的 / 0=插值估的]，L 듣기 / R 읽기 / W 쓰기 / S 听力原文里的位置；\n'
          '// groups：大题 [起, 止, 页, y]（卷面上的 [a~b] 说明）；audio：按题拆好的音轨数（含 00 开场），或 "full" 只有整段录音；\n'
          '// cue：只有整段录音时，每道听力题从第几秒开始；wpage：TOPIK II 正答表里写作模范答案在第几页（0 起）。\n'
          'window.TOPIK_TESTS = ' + json.dumps(tests, ensure_ascii=False, separators=(',', ':')) + ';\n')
    open(OUT, 'w', encoding='utf-8', newline='\n').write(js)
    print('写好', OUT)


if __name__ == '__main__':
    main([int(x) for x in sys.argv[1:]])
