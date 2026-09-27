# 从正答表（扫描图 PDF，没有文字层）生成 app/data/keys.js。
# 韩文 OCR 会漏掉 ③ 那一列、把 ①②④ 认成怪字，老卷子扫描又糊，自动认字不可靠，所以分工是：
#   人：看 view/sheet_<回次>-<级别>_<k>.png（只截表格），把答案和配分抄进 keys_manual.json；
#   脚本：校验 ——
#     1. 每个科目配分合计必须正好 100；
#     2. 每一格的字形（①–④ 去掉圈只比数字）要最像「标成同一个数字的那些格」的平均样子（留一法最近中心），
#        不像的列出来并画 view/flags_<id>.png，回去对着原表再看一眼；确认没抄错就把题号（配分加 p 前缀）
#        写进该卷的 "checked"。
# 用法：python scratch\build_keys.py sheets      生成抄写用的表格图
#       python scratch\build_keys.py             校验 + 写 keys.js（有问题就不写）
import os, sys, json, glob
sys.stdout.reconfigure(encoding='utf-8'); sys.stderr.reconfigure(encoding='utf-8')   # 控制台默认 GBK，打印韩文会崩
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cells

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PAPERS = os.path.join(ROOT, 'papers')
OUT = os.path.join(ROOT, 'app', 'data', 'keys.js')
MANUAL = os.path.join(HERE, 'keys_manual.json')
EXPECT = {'I': [('L', 30), ('R', 40)], 'II': [('L', 50), ('R', 50)]}


def tests():
    out = {}
    for f in glob.glob(os.path.join(PAPERS, '*', '*', 'answer.pdf')):
        lv = os.path.basename(os.path.dirname(f))
        n = os.path.basename(os.path.dirname(os.path.dirname(f)))
        out[f'{n}-{lv}'] = f
    return dict(sorted(out.items(), key=lambda x: (-int(x[0].split('-')[0]), x[0])))


def read_tables(pdf):
    """选择题的 6 列表（번호|정답|배점 ×2），按页序；返回 [(img, table)]"""
    import pymupdf
    res = []
    for p in range(len(pymupdf.open(pdf))):
        img = cells.page_gray(pdf, p)
        res += [(img, t) for t in cells.tables(img) if len(t['cols']) == 7]
    return res


def table_cells(img, t):
    """表里每道题按题号顺序：(答案格, 配分格)。左半张表在前，右半张在后。"""
    R, C = t['rows'], t['cols']
    out = []
    for blk in range(2):
        for r in range(1, len(R) - 1):             # 第 0 行是表头
            y0, y1 = R[r], R[r + 1]
            out.append((cells.crop(img, C[3 * blk + 1], C[3 * blk + 2], y0, y1),
                        cells.crop(img, C[3 * blk + 2], C[3 * blk + 3], y0, y1)))
    return out


def make_sheets():
    """每张选择题表一张图（150 dpi，只截表格）：view/sheet_<id>_<k>.png"""
    os.makedirs(os.path.join(HERE, 'view'), exist_ok=True)
    for tid, pdf in tests().items():
        for k, (img, t) in enumerate(read_tables(pdf)):
            y0, y1 = int(t['rows'][0]) - 4, int(t['rows'][-1]) + 5
            x0, x1 = int(t['cols'][0]) - 4, int(t['cols'][-1]) + 5
            cells.save_png(np.ascontiguousarray(img[y0:y1:2, x0:x1:2]), os.path.join(HERE, 'view', f'sheet_{tid}_{k}.png'))
        print(tid)


def loo_check(glyphs, labels):
    """留一法最近中心：返回 [(下标, 标的, 更像的)]"""
    X = np.array([g.ravel() for g in glyphs])
    L = np.array(labels)
    bad = []
    for i in range(len(X)):
        best, bd = None, 9e9
        for v in sorted(set(labels)):
            m = (L == v); m[i] = False
            if not m.any():
                continue
            d = np.sqrt(((X[m].mean(0) - X[i]) ** 2).mean())
            if d < bd:
                best, bd = v, d
        if best is not None and best != L[i]:
            bad.append((i, int(L[i]), int(best)))
    return bad


def main():
    manual = json.load(open(MANUAL, encoding='utf-8')) if os.path.exists(MANUAL) else {}
    out, errors = {}, []
    for tid, pdf in tests().items():
        lv = tid.split('-')[1]
        m = manual.get(tid)
        if not m:
            errors.append(f'{tid}: keys_manual.json 里还没有'); continue
        allc = [c for img, t in read_tables(pdf) for c in table_cells(img, t)]
        exp_n = sum(n for _, n in EXPECT[lv])
        if len(allc) != exp_n:
            errors.append(f'{tid}: 表里切出 {len(allc)} 题，应为 {exp_n}'); continue
        ans, pts, res = [], [], {}
        for sec, n in EXPECT[lv]:
            a = [int(c) for c in m[sec]['ans'] if c.isdigit()]
            p = [int(c) for c in m[sec]['pts'] if c.isdigit()] if 'pts' in m[sec] else [m[sec]['each']] * n
            if len(a) != n or len(p) != n:
                errors.append(f'{tid} {sec}: 抄了 {len(a)} 个答案 / {len(p)} 个配分，应为 {n}'); continue
            if sum(p) != 100:
                errors.append(f'{tid} {sec}: 配分合计 {sum(p)} ≠ 100')
            if not all(1 <= x <= 4 for x in a):
                errors.append(f'{tid} {sec}: 答案只能是 1–4')
            res[sec] = {'ans': a, 'pts': p}
            ans += a; pts += p
        if len(ans) != exp_n or len(pts) != exp_n:
            continue
        ag = [cells.norm_glyph(c[0], 32, circled=True) for c in allc]
        pg = [cells.norm_glyph(c[1], 32) for c in allc]
        def qno(i):
            acc = 0
            for sec, n in EXPECT[lv]:
                if i < acc + n:
                    return f'{sec}{i - acc + 1 + (30 if lv == "I" and sec == "R" else 0)}'
                acc += n
        # checked：看过 flags 图确认抄得没错的格子（老卷子扫描糊，字形校验会误报）
        ok = set(m.get('checked', []))
        flags, acc = [], 0
        for sec, n in EXPECT[lv]:                   # 按科目（= 一张表）分开比：同一份 PDF 两张表的字体可能不一样（47 回）
            sl = slice(acc, acc + n)
            flags += [('答案', acc + i, a, b) for i, a, b in loo_check(ag[sl], ans[sl]) if qno(acc + i) not in ok]
            if len(set(pts[sl])) > 1:
                flags += [('配分', acc + i, a, b) for i, a, b in loo_check(pg[sl], pts[sl]) if 'p' + qno(acc + i) not in ok]
            acc += n
        if flags:
            errors.append(f'{tid}: 字形和抄写对不上 -> ' + ', '.join(f'{k} {qno(i)} 抄 {a} 像 {b}' for k, i, a, b in flags))
            tiles = []
            for k, i, a, b in flags:                  # 整格、8 个一行，每格左上角是第几个（对照报错顺序）
                c = allc[i][0 if k == '答案' else 1]
                h, w = c.shape; cy, cx = h // 2, w // 2
                c = c[max(0, cy - 40):cy + 40, max(0, cx - 70):cx + 70]
                t = np.full((90, 150), 255, np.uint8); t[5:5 + c.shape[0], 5:5 + c.shape[1]] = c
                t[:, -3:] = 120; t[-3:, :] = 120
                tiles.append(t)
            while len(tiles) % 8:
                tiles.append(np.full((90, 150), 255, np.uint8))
            grid = np.vstack([np.hstack(tiles[r:r + 8]) for r in range(0, len(tiles), 8)])
            cells.save_png(grid, os.path.join(HERE, 'view', f'flags_{tid}.png'))
        out[tid] = res
    if errors:
        print('有问题：\n  ' + '\n  '.join(errors))
        sys.exit(1)
    js = '// 由 scratch/build_keys.py 从官方正答表生成（人工抄写 + 字形交叉校验 + 配分合计 100），别手改。\n' \
         '// ans = 正确选项 1–4，pts = 配分；L = 듣기，R = 읽기（TOPIK I 的读题号从 31 起）。쓰기 是主观题，不在这里。\n' \
         'window.TOPIK_KEYS = {\n' + ''.join(
             f'  "{tid}": {{ ' + ', '.join(f'{sec}: {{ ans: {json.dumps(v["ans"])}, pts: {json.dumps(v["pts"])} }}' for sec, v in r.items()) + ' },\n'
             for tid, r in out.items()) + '};\n'
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    open(OUT, 'w', encoding='utf-8', newline='\n').write(js)
    print(f'写好 {OUT}：{len(out)} 套，全部通过校验')


if __name__ == '__main__':
    make_sheets() if sys.argv[1:] == ['sheets'] else main()
