# 从 topik.go.kr「학습하기 > 학습 자료실」(BBSMSTR00078) 抓出各回次帖子的附件链接，写 scratch/links.tsv。
# 用法：python scratch\links.py            （默认最近 10 回；加回次号只抓那几回，如 python scratch\links.py 35 36）
# 列表页是 POST TWSTDY0100.do（pageIndex 翻页），帖子页 GET TWSTDY0101.do?bbsId=..&nttId=..，
# 附件是 /topik/cm/comm/download.do?...&orgFileName=原文件名。要带 Cookie timezone=Asia/Seoul，否则只回跳转页。
import os, re, sys, html, urllib.request, urllib.parse
sys.stdout.reconfigure(encoding='utf-8'); sys.stderr.reconfigure(encoding='utf-8')   # 控制台默认 GBK，打印韩文会崩

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = 'https://www.topik.go.kr'
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36'
WANT = [int(x) for x in sys.argv[1:]] or [102, 96, 91, 83, 64, 60, 52, 47, 41, 37]


def get(url, data=None):
    req = urllib.request.Request(url, data=data, headers={'User-Agent': UA, 'Cookie': 'timezone=Asia/Seoul'})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode('utf-8', 'replace')


posts = {}
for page in range(1, 20):
    body = urllib.parse.urlencode({'pageIndex': page, 'bbsId': 'BBSMSTR00078', 'nttId': 0, 'nttClCode1': 'ALL', 'searchType': '', 'searchWord': ''}).encode()
    s = get(BASE + '/TWSTDY/TWSTDY0100.do', body)
    found = re.findall(r"fnContent\('BBSMSTR00078','(\d+)'\)[^>]*>\s*([^<]*)", s)
    if not found:
        break
    for nid, title in found:
        m = re.search(r'제\s*(\d+)\s*회', title)
        if m and int(m.group(1)) in WANT and '서비스' not in title:
            posts[nid] = (int(m.group(1)), title.strip())

rows = []
for nid, (n, title) in sorted(posts.items(), key=lambda x: (-x[1][0], x[0])):
    s = get(f'{BASE}/TWSTDY/TWSTDY0101.do?bbsId=BBSMSTR00078&nttId={nid}&nttClCode1=ALL&pageIndex=1&searchType=&searchWord=')
    for href, name in re.findall(r'href="(/topik/cm/comm/download\.do\?[^"]*)"[^>]*>([^<]*)', s):
        rows.append(f'{n}\t{name.strip()}\t{BASE}{html.unescape(href)}')
    print(n, title)

missing = set(WANT) - {p[0] for p in posts.values()}
if missing:
    print('官网上没找到：', sorted(missing))
open(os.path.join(ROOT, 'scratch', 'links.tsv'), 'w', encoding='utf-8', newline='\n').write('\n'.join(rows) + '\n')
print(len(rows), 'links')
