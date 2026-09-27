'use strict';
/* TOPIK 做题 —— 考试适配（界面和做法全在 core.js，两个 app 共用）。这里只有 TOPIK 自己的：
   卷子是官方 PDF 渲染成的页面图（papers/<回>/<级>/img/），每题的位置在 data/tests.js（scratch/pages.py 用 OCR 找的，
   找不准的标了 approx）；答案和配分在 data/keys.js；考试结构/时限/等级线/大题/쓰기在 data/levels.js；
   듣기 대본的中文译文在 data/trans.js。录音按题拆好（00 开场 + 每题一段）；37 回只有整段录音，每题从第几秒开始在 tests.js 的 cue。
   算分：选择题按官方配分，쓰기自评；TOPIK 按总分定级，没有单科及格线。 */

const LV = window.TOPIK_LEVELS;

function loadTests() {
  for (const [id, t] of Object.entries(window.TOPIK_TESTS)) {
    const k = window.TOPIK_KEYS[id];
    if (!k) continue;
    const lv = LV[t.level];
    const base = `/papers/${t.n}/${t.level}`;
    const tr = window.TOPIK_TRANS?.[id];
    const full = t.audio === 'full';
    const audio = full ? [{ url: `${base}/audio/full.mp3`, name: '整段录音' }]
      : Array.from({ length: t.audio || 0 }, (_, i) => ({ url: `${base}/audio/${pad2(i)}.mp3`, name: i ? `${i}번` : '开场说明' }));
    const script = t.q.S || [];                          // 대본里每题的位置
    const items = [], groups = [];
    for (const p of lv.order) {
      const part = lv.parts[p];
      for (const [a, b, name] of lv.groups[p]) {
        const h = (t.groups[p] || []).find(g => g[0] === a);
        groups.push({ key: `${p}:${a}`, part: p, a, b, label: a === b ? `${a}번` : `${a}–${b}번`, name,
          pos: h ? [part.doc, h[2], h[3], 1] : null, spos: p === 'L' ? script[a - 1] || null : null });
      }
      for (let no = part.from; no <= part.to; no++) {
        const i = no - part.from;
        const grp = groups.find(g => g.part === p && no >= g.a && no <= g.b);
        const q = t.q[p]?.[i] || null;
        const it = {
          key: `${p}:${no}`, part: p, grp, label: String(no), long: `${no}번`, qid: `${p}:${no}`, say: `${no}번`,
          pos: no === grp.a && grp.pos ? grp.pos : q,        // 大题第一题滚到大题说明（[a~b] 那行）
          tip: q && !q[3] ? '这题在卷子上的位置是估的' : '',
        };
        if (p === 'W') { const w = lv.writing[no]; it.pts = w.max; it.open = { ...w, rows: w.len?.[1] > 400 ? 16 : 9 }; }
        else { it.ans = k[p].ans[i]; it.pts = k[p].pts[i]; it.nOpt = 4; }
        if (p === 'L') { it.spos = script[no - 1] || null; it.track = full ? 0 : no; it.cue = full ? t.cue?.[no - 1] ?? null : 0; }   // 第 no 段录音就是第 no 题
        items.push(it);
      }
    }
    addTest({
      id, level: t.level, order: t.n, n: t.n, year: t.year,
      title: `제${t.n}회`, sub: `${t.year} 年`, tag: String(t.year), short: `제${t.n}회`,
      parts: lv.order, partName: Object.fromEntries(lv.order.map(p => [p, lv.parts[p].name])),
      partDoc: Object.fromEntries(lv.order.map(p => [p, lv.parts[p].doc])),
      docs: t.docs, img: `${base}/img/`, audio, intro: full ? undefined : 0,
      answerPos: t.level === 'II' ? { W: ['answer', t.wpage ?? 1, 0, 1] } : null,     // 正答表里쓰기模范答案那页
      // 译文一段录音一张；q [起, 止] 题号
      trans: tr?.segs.map(s => ({ at: s.at, key: `L:${s.q[0]}`, head: `${s.q[0] === s.q[1] ? s.q[0] : `${s.q[0]}–${s.q[1]}`} 번`, lines: s.lines, qs: s.qs })) || null,
      groups, items,
    });
  }
}

// 选择题按官方配分；쓰기是主观题，只能交卷后自己对照模范答案打分（wself）
function score(test, set, answers, wself) {
  const lv = LV[test.level];
  const areas = lv.order.map(p => {
    const all = test.items.filter(i => i.part === p);
    const done = all.filter(i => set.has(i.key));
    if (!done.length) return null;
    const a = { name: lv.parts[p].name, zh: lv.parts[p].zh, n: done.length, full: done.length === all.length, max: done.reduce((s, i) => s + i.pts, 0) };
    if (p === 'W') {
      const scored = done.every(i => wself[i.key] != null);
      return { ...a, open: true, pending: !scored, score: scored ? done.reduce((s, i) => s + (+wself[i.key] || 0), 0) : null };
    }
    let ok = 0, got = 0;
    for (const it of done) if (answers[it.key] === it.ans) { ok++; got += it.pts; }
    return { ...a, ok, score: got };
  }).filter(Boolean);
  const full = areas.length === lv.order.length && areas.every(a => a.full);
  const pending = areas.some(a => a.pending);
  const total = full && !pending ? areas.reduce((s, a) => s + a.score, 0) : null;
  const label = total == null ? null : (lv.grades.find(([min]) => total >= min)?.[1] || '불합격');
  const pass = total == null ? null : label !== '불합격';
  const low = lv.grades.at(-1);
  return {
    areas, full, pending, total, max: lv.max, pass, label, totalName: '总分',
    verdict: pass ? `✓ ${tl(label)}` : `✗ ${tl('불합격')}（${tl(low[1])} 要 ${low[0]}）`,
    note: full ? `等级线：${lv.grades.map(([m, x]) => `${tl(x)} ≥ ${m}`).join('，')}（满分 ${lv.max}，没有单科及格线）。选择题按官方配分，分数是准的。`
      : '分项练习只算这一科；做整套模考才出总分和等级。',
  };
}

Object.assign(EXAM, {
  name: 'TOPIK 做题', lang: 'ko', levels: LV, defaultLevel: 'I',
  docNames: window.TOPIK_DOC_NAMES,
  typesInTl: false,           // 题型名是自己写的中文
  brand: '<span class="tl" lang="ko">한국어능력시험</span><span>· 官网公开的最近 10 回真题</span>',
  srcNote: `试卷、听力、正答表均来自国立国际教育院 TOPIK 官网
    <a href="https://www.topik.go.kr/TWSTDY/TWSTDY0100.do" target="_blank">학습 자료실</a> 公开的기출문제（第 37–102 回，每回 TOPIK I / II 各一套），仅供个人学习。
    选择题按官方配分算分，TOPIK 本来就按原始分定级，所以分数和等级是准的；쓰기要自己对照模范答案打分。`,
  levelInfo: lv => `满分 ${lv.max} · ${lv.grades.map(([m, g]) => `${tl(g)} ≥${m}`).join(' · ')}`,
  load: loadTests,
  score,
});
