# 듣기 대본的中文译文 -> app/data/trans.js。
#   译文手写在 scratch/trans/<回>-<I|II>.txt（格式见文件头）；这里只算每段译文插在대본页面图的哪儿：
#   一段录音讲完 = 下一题题号或下一个 ※[a~b] 说明之前。题号位置和韩文 OCR 跟 pages.py 共用（pages.script_pos / script_ko，
#   OCR 缓存 scratch/ocr/<回>-<级>-script-ko.txt，删了会重跑，要装韩文 OCR 包），※ 说明行也从那份 OCR 里找；
#   切口放在那行上面的空白正中，下一样东西在页顶（前面没内容）就改成插在上一页末尾。先跑 pages.py 再跑这个。
# 用法：python scratch\build_trans.py [回次…]   不给回次 = 把有译文文件的都做一遍
import os, re, sys, json, glob
sys.stdout.reconfigure(encoding='utf-8'); sys.stderr.reconfigure(encoding='utf-8')   # 控制台默认 GBK，打印韩文会崩
import numpy as np
import pymupdf
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pages

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
TDIR = os.path.join(HERE, 'trans')
TOP = 175           # 页眉线以下才算正文（150 dpi 页面图，页眉线在 y≈140）

def load_tests():
    s = open(os.path.join(ROOT, 'app', 'data', 'tests.js'), encoding='utf-8').read()
    s = s[s.index('{'):s.rstrip().rstrip(';').rindex('}') + 1]
    return json.loads(s)

def parse(path):
    """译文文件 -> [{a, b, lines, qs:{题号: [题干, ①, ②, ③, ④]}}]"""
    out, cur, q = [], None, None
    for ln in open(path, encoding='utf-8'):
        ln = ln.rstrip()
        if not ln or ln.startswith('#'): continue
        m = re.match(r'^@(\d+)(?:-(\d+))?$', ln)
        if m:
            a = int(m[1]); b = int(m[2] or a)
            cur = {'a': a, 'b': b, 'lines': [], 'qs': {}}; out.append(cur); q = a
            continue
        m = re.match(r'^(\d+)\. (.*)$', ln)
        if m:
            q = int(m[1]); cur['qs'][str(q)] = [m[2]]; continue
        if ln[0] in '①②③④':                           # 选项可以一行四个，也可以一行一个
            cur['qs'].setdefault(str(q), ['']).extend(o.strip() for o in re.split(r'[①②③④]', ln)[1:]); continue
        assert not cur['qs'], ('对话要写在题干和选项前面', path, ln)
        cur['lines'].append(ln)
    for s in out:
        for k, v in s['qs'].items(): assert len(v) == 5, (path, k, '选项不是 4 个')
    return out

def ink_rows(path):
    pix = pymupdf.Pixmap(path)
    if pix.n != 1: pix = pymupdf.Pixmap(pymupdf.csGRAY, pix)
    a = np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.stride)[:, :pix.width]
    return (a[:, 150:1100] < 160).sum(1) > 0            # 每行有没有墨

def cut_before(ink, y):
    """y 那行字上面的空白正中；上面到页眉都是空白 -> None（插到上一页末尾）"""
    yy = y - 2
    while yy > TOP and ink[yy]: yy -= 1                  # OCR 的框顶可能比字低一点，先爬出这行字
    lo = yy
    while yy > TOP and not ink[yy]: yy -= 1
    if yy <= TOP: return None
    c = (yy + lo) // 2
    return c if c > 260 else None                        # 上面只有页眉（老卷页眉低）

def build(n, lv, tests):
    tid = f'{n}-{lv}'
    src = os.path.join(TDIR, f'{tid}.txt')
    t = tests[tid]
    S = t['q']['S']
    npg, H = t['docs']['script']['pages'], t['docs']['script']['h']
    files = [os.path.join(ROOT, 'papers', str(n), lv, 'img', f'script-{i + 1:02d}.jpg') for i in range(npg)]
    # 「下一样东西」：每题题号 + 每个 [a~b] 说明行，按（页, y）排好
    ko = pages.script_ko(n, lv, npg)
    pos = pages.script_pos(S, ko)                        # 每题 (页, y)；None = 认不到且 S 是估的，不当切口参照
    qpos = [v or (S[i][1], S[i][2]) for i, v in enumerate(pos)]
    marks = [v for v in pos if v]
    for p in sorted(ko):
        for x, y, w, h, txt in ko[p]:
            if x < 270 and re.match(r'^(※\s*)?\[', txt): marks.append((p, y))   # 64 回的说明行在 x≈251
    marks.sort()
    inks = {}
    segs = parse(src)
    covered = sorted(q for s in segs for q in range(s['a'], s['b'] + 1))
    assert covered == list(range(1, len(S) + 1)), (tid, '译文没覆盖全部题，或有重复')
    for s in segs:
        c = [pos[q - 1] for q in range(s['a'], s['b'] + 1) if pos[q - 1]]
        last = max(c) if c else qpos[s['b'] - 1]
        nxt = next((m for m in marks if m > last), None)
        if nxt is None:
            s['at'] = [npg - 1, H]; continue
        p, y = nxt
        if p not in inks: inks[p] = ink_rows(files[p])
        c = cut_before(inks[p], y)
        s['at'] = [p, c] if c is not None else [p - 1, H]
    return {'segs': [{'q': [s['a'], s['b']], 'at': s['at'], 'lines': s['lines'], 'qs': s['qs']} for s in segs]}

def main():
    tests = load_tests()
    out_path = os.path.join(ROOT, 'app', 'data', 'trans.js')
    data = {}
    if os.path.exists(out_path):
        s = open(out_path, encoding='utf-8').read()
        data = json.loads(s[s.index('{'):s.rstrip().rstrip(';').rindex('}') + 1])
    want = set(sys.argv[1:])
    for src in sorted(glob.glob(os.path.join(TDIR, '*-*.txt'))):
        m = re.match(r'^(\d+)-(I|II)\.txt$', os.path.basename(src))
        if not m or (want and m[1] not in want): continue
        tid = f'{m[1]}-{m[2]}'
        data[tid] = build(int(m[1]), m[2], tests)
        print(tid, len(data[tid]['segs']), '段', ' '.join(f"{s['q'][0]}:{s['at'][0]}/{s['at'][1]}" for s in data[tid]['segs']))
    with open(out_path, 'w', encoding='utf-8', newline='\n') as f:
        f.write('// 由 scratch/build_trans.py 生成，别手改；译文原稿在 scratch/trans/<回>-<级>.txt。\n'
                '// segs 每段一段录音：q [起, 止] 题号；at [대본页(0 起), y 像素] 译文插在那儿（y = 页高 = 插在这页后面）；\n'
                '// lines 对话译文；qs 题号 -> [题干, ①, ②, ③, ④]（没有题干的是 ""；图片选项的题没有 qs）。\n'
                'window.TOPIK_TRANS = ' + json.dumps(data, ensure_ascii=False, separators=(',', ':')) + ';\n')

if __name__ == '__main__':
    main()
