# 核对题号定位：把 tests.js 里每道题的位置画回页面（红 = OCR 直接认到，橙 = 按行数/插值推的），拼成缩略图看。
# 用法：python scratch\overlay.py 64-I paper 5 14   -> scratch/view/ov_64-I_paper.png
import sys, json, numpy as np, pymupdf
tid, doc, p0, p1 = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
s = open('app/data/tests.js', encoding='utf-8').read(); T = json.loads(s[s.index('{'):s.rindex('}') + 1])
t = T[tid]
d = pymupdf.open(f'papers/{t["n"]}/{t["level"]}/{doc}.pdf')
k = 72 / 150
secs = {'paper': ['L', 'R'], 'paper1': ['L', 'W'], 'paper2': ['R'], 'script': ['S']}[doc]
lo = {'L': 1, 'R': 31 if t['level'] == 'I' else 1, 'W': 51, 'S': 1}
for sec in secs:
    for i, (dd, p, y, exact) in enumerate(t['q'][sec]):
        if p < p0 - 1 or p > p1 - 1: continue
        pg = d[p]
        col = (1, 0, 0) if exact else (1, .55, 0)
        r = pymupdf.Rect(20, y * k - 6, 60, y * k + 10)
        pg.draw_rect(r, color=col, fill=col)
        pg.insert_text((22, y * k + 7), str(lo[sec] + i), fontsize=12, color=(1, 1, 1))
tiles = []
for p in range(p0 - 1, p1):
    pix = d[p].get_pixmap(dpi=40)
    a = np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.width, pix.n)[:, :, :3]
    tiles.append(np.pad(a, ((0, 4), (0, 4), (0, 0))))
h = max(x.shape[0] for x in tiles); w = max(x.shape[1] for x in tiles)
tiles = [np.pad(x, ((0, h - x.shape[0]), (0, w - x.shape[1]), (0, 0))) for x in tiles]
while len(tiles) % 5: tiles.append(np.zeros_like(tiles[0]))
g = np.ascontiguousarray(np.vstack([np.hstack(tiles[r:r + 5]) for r in range(0, len(tiles), 5)]))
pymupdf.Pixmap(pymupdf.csRGB, g.shape[1], g.shape[0], g.tobytes(), 0).save(f'scratch/view/ov_{tid}_{doc}.png'); print(g.shape)
