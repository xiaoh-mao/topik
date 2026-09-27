# 正答表（扫描图）的表格切格：找网格线 -> 按「번호 | 정답 | 배점」三列一组切出每格。
# 供 build_keys.py 调用；单独跑可以把某页的切格结果画出来检查：python scratch\cells.py <pdf> <页码从0起>
import sys
import numpy as np
import pymupdf

DPI = 300


def page_gray(pdf, pno, dpi=DPI):
    pix = pymupdf.open(pdf)[pno].get_pixmap(dpi=dpi, colorspace=pymupdf.csGRAY)
    return np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.width)


def runs(mask):
    """一维布尔数组里连续 True 段 -> [(start, end_exclusive)]"""
    out, s = [], None
    for i, v in enumerate(mask):
        if v and s is None:
            s = i
        elif not v and s is not None:
            out.append((s, i)); s = None
    if s is not None:
        out.append((s, len(mask)))
    return out


def longest_run(mask2d, axis):
    """每行（axis=1）或每列（axis=0）最长的连续 True 段长度"""
    m = mask2d if axis == 1 else mask2d.T
    best = np.zeros(m.shape[0], np.int32)
    cur = np.zeros(m.shape[0], np.int32)
    for j in range(m.shape[1]):
        cur = np.where(m[:, j], cur + 1, 0)
        best = np.maximum(best, cur)
    return best


def centers(mask1d):
    return [(a + b - 1) / 2 for a, b in runs(mask1d)]


def tables(img):
    """返回页面上每张表：{'rows': [y...], 'cols': [x...]}（网格线坐标，已排序）。
    线 = 连续不断的长暗段（字再粗也有字间空隙，不会被当成线）。"""
    dark = img < 200
    H, W = dark.shape
    hs = []
    for y in centers(longest_run(dark, 1) > W * 0.3):
        if hs and y - hs[-1] < 16:      # 表头下面的双线算一条
            hs[-1] = (hs[-1] + y) / 2
        else:
            hs.append(y)
    out, groups, cur = [], [], []
    # 相邻两条横线之间有 ≥3 条竖线贯穿才算同一张表
    for y in hs:
        if cur:
            y0, y1 = int(cur[-1]) + 6, int(y) - 4
            if y1 <= y0 or (dark[y0:y1].mean(axis=0) > 0.95).sum() < 3:
                groups.append(cur); cur = []
        cur.append(y)
    if cur:
        groups.append(cur)
    for g in groups:
        if len(g) < 3:
            continue
        y0, y1 = int(g[0]), int(g[-1])
        vs = centers(longest_run(dark[y0:y1 + 1], 0) > (y1 - y0) * 0.9)
        merged = []
        for x in vs:               # 粗线 / 双线会被识别成紧挨着的几条，合并
            if merged and x - merged[-1] < 16:
                merged[-1] = (merged[-1] + x) / 2
            else:
                merged.append(x)
        if len(merged) >= 4:
            out.append({'rows': g, 'cols': merged})
    return out


def crop(img, x0, x1, y0, y1, pad=8):
    return img[int(y0) + pad:int(y1) - pad + 1, int(x0) + pad:int(x1) - pad + 1]


def clean_ink(cell):
    """二值墨迹，去掉贴着裁切边的连通块（表格线残留）"""
    from scipy import ndimage
    ink = cell < 160
    lab, n = ndimage.label(ink)
    if n:
        edge = set(np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))) - {0}
        if edge:
            ink = ink & ~np.isin(lab, list(edge))
    return ink


def strip_circle(ink):
    """①–④：外框最大的那个连通块是圆圈，去掉，只留里面的数字（数字和圈粘在一起时原样返回）"""
    from scipy import ndimage
    lab, n = ndimage.label(ink, structure=np.ones((3, 3)))
    if n < 2:
        return ink
    objs = ndimage.find_objects(lab)
    area = [(o[0].stop - o[0].start) * (o[1].stop - o[1].start) for o in objs]
    ring = int(np.argmax(area)) + 1
    o = objs[ring - 1]
    inner = ink & (lab != ring)
    inner[:o[0].start] = False; inner[o[0].stop:] = False
    inner[:, :o[1].start] = False; inner[:, o[1].stop:] = False
    return inner if inner.sum() >= 5 else ink


def norm_glyph(cell, size=24, circled=False):
    """墨迹 -> 按外框等比缩放到 size×size（稍微模糊一下吃掉抗锯齿差异），返回 0..1 浮点图；空格返回 None"""
    from scipy import ndimage
    ink = clean_ink(cell)
    if circled:
        ink = strip_circle(ink)
    ys, xs = np.nonzero(ink)
    if len(ys) < 5:
        return None
    g = ink[ys.min():ys.max() + 1, xs.min():xs.max() + 1].astype(np.float32)
    h, w = g.shape
    s = size / max(h, w)
    nh, nw = max(1, round(h * s)), max(1, round(w * s))
    yi = np.minimum((np.arange(nh) / s).astype(int), h - 1)
    xi = np.minimum((np.arange(nw) / s).astype(int), w - 1)
    out = np.zeros((size, size), np.float32)
    oy, ox = (size - nh) // 2, (size - nw) // 2
    out[oy:oy + nh, ox:ox + nw] = g[yi][:, xi]
    return ndimage.gaussian_filter(out, 1.0)


def glyph_box(cell):
    """墨迹外框（去掉贴边的表格线残留），给样例图用：返回裁好的灰度图"""
    ink = clean_ink(cell)
    ys, xs = np.nonzero(ink)
    if not len(ys):
        return cell
    return cell[max(0, ys.min() - 3):ys.max() + 4, max(0, xs.min() - 3):xs.max() + 4]


def save_png(arr, path):
    """numpy 灰度 (H,W) 或 RGB (H,W,3) uint8 -> PNG（没装 Pillow，借 PyMuPDF 写）"""
    arr = np.ascontiguousarray(arr, dtype=np.uint8)
    cs = pymupdf.csRGB if arr.ndim == 3 else pymupdf.csGRAY
    pymupdf.Pixmap(cs, arr.shape[1], arr.shape[0], arr.tobytes(), 0).save(path)


if __name__ == '__main__':
    pdf, pno = sys.argv[1], int(sys.argv[2])
    img = page_gray(pdf, pno)
    rgb = np.stack([img] * 3, axis=2).copy()
    for t in tables(img):
        c0, c1, r0, r1 = int(t['cols'][0]), int(t['cols'][-1]), int(t['rows'][0]), int(t['rows'][-1])
        for y in t['rows']:
            rgb[int(y) - 1:int(y) + 2, c0:c1] = (255, 0, 0)
        for x in t['cols']:
            rgb[r0:r1, int(x) - 1:int(x) + 2] = (0, 0, 255)
        print(len(t['rows']) - 1, 'rows x', len(t['cols']) - 1, 'cols')
    save_png(rgb, 'view/cells_debug.png')
