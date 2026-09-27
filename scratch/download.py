# 按 links.tsv（回次<TAB>原文件名<TAB>URL）把官网「학습 자료실」的附件下到 scratch/raw/<回次>/。
# 已下好且校验过的跳过；4 路并发。用法：python scratch\download.py
# links.tsv 由 scratch\links.py 从官网帖子页抓出来。
import os, sys, time, zipfile, urllib.request
sys.stdout.reconfigure(encoding='utf-8'); sys.stderr.reconfigure(encoding='utf-8')   # 控制台默认 GBK，打印韩文会崩
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, 'scratch', 'raw')
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36'


def ok(path):
    if not os.path.isfile(path) or os.path.getsize(path) < 1024:
        return False
    ext = os.path.splitext(path)[1].lower()
    with open(path, 'rb') as f:
        head = f.read(4)
        f.seek(max(0, os.path.getsize(path) - 2048))
        tail = f.read()
    if ext == '.pdf':
        return head == b'%PDF' and b'%%EOF' in tail
    if ext == '.zip':
        try:
            with zipfile.ZipFile(path) as z:
                return z.testzip() is None
        except Exception:
            return False
    if ext == '.mp3':
        return os.path.getsize(path) > 200 * 1024
    return True


def fetch(row):
    n, name, url = row
    d = os.path.join(RAW, n)
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, name)
    if ok(path):
        return f'skip {n}/{name}'
    for attempt in range(5):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA, 'Cookie': 'timezone=Asia/Seoul'})
            with urllib.request.urlopen(req, timeout=120) as r, open(path + '.part', 'wb') as f:
                while True:
                    b = r.read(1 << 16)
                    if not b:
                        break
                    f.write(b)
            os.replace(path + '.part', path)
            if ok(path):
                return f'ok   {n}/{name} {os.path.getsize(path):,}'
        except Exception as e:
            err = e
        time.sleep(3 * (attempt + 1))
    return f'FAIL {n}/{name}'


rows = [ln.rstrip('\n').split('\t') for ln in open(os.path.join(ROOT, 'scratch', 'links.tsv'), encoding='utf-8') if ln.strip()]
fail = 0
with ThreadPoolExecutor(4) as ex:
    for msg in ex.map(fetch, rows):
        print(msg, flush=True)
        fail += msg.startswith('FAIL')
sys.exit(1 if fail else 0)
