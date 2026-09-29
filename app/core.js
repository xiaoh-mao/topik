'use strict';
/* 做题内核 —— jlpt\ 和 topik\ 共用，两边这个文件必须一模一样：改完运行 lib\sync-core.ps1 同步到另一边。
   两个 app 的界面和做法完全一样，都在这里；exam.js 只管各考试自己的东西：数据怎么读成下面的格式、分数怎么算、几句说明文字
   （JLPT 另有「导入自备试卷」）。加载顺序：data/*.js → core.js → exam.js → DOMContentLoaded 启动。
   做完的记录存 data/records.json，没交卷的那一场存 data/active.json，关窗再开能接着做。

   exam.js 用 addTest 放进 TESTS 的试卷：
   test { id, level, order(大的排前面), title, sub('2012 年 · 官方'), tag(短标签 '2012'), short(最近记录里的名字),
          parts:[按顺序的科目，听力固定叫 L], partName:{科目:名}, partDoc:{科目:在哪份卷子},
          docs:{卷子:{pages,w,h}} 有页面图才有，img:页面图路径前缀（+ '<卷子>-01.jpg'），files:{卷子:PDF 地址} 没页面图时用（自备卷），
          audio:[{url, name}] 录音段，intro:开场说明那段的下标（没有就不写），answerPos:{科目:正答表里模范答案的位置}，
          trans:[{at:[页,y], key, head, lines, qs}] 插在听力原文里的译文，groups:[grp], items:[it] }
   grp  { key, part, label('問題 3' / '1–4번'), name(题型), pos, spos(听力原文里的位置), cls }
   it   { key, part, grp, label(答题卡上的题号), long(错题本里的写法), pts(配分，有才显示), tip,
          ans + nOpt（选择题）或 open:{ blanks:几个空 } / open:{ len:[下限,上限], rows }（主观题，交卷后自评，记在 a.wself），
          pos:[卷子,页,y,准不准], nopick(点卷子时不认这题), spos, track(录音段下标), cue(这题在那段里第几秒开始),
          qid(同一道听力题的几个小问共用), say('3番'，播放条上「正在放」) }
   位置 [卷子, 页(0 起), y(页面图像素), 1=准 / 0=估的]。 */

// exam.js 用 Object.assign(EXAM, {...}) 填
const EXAM = {
  name: '',                 // 窗口标题（启动时写进 document.title），也是首页大标题；lib\exam.ps1 的 Title 要跟它一致
  lang: 'ja',               // 外语的 lang；.tl（外语字体）在 exam.css 里定义
  levels: {},               // 级别 -> { name, booklets:[{ name, parts, min, rest(真考试这之前休息几分钟) }] }
  defaultLevel: '',
  docNames: {},             // 卷子标签名：卷子 -> 名（script = 听力原文，answer = 正答表）
  typesInTl: true,          // 题型名是外语（用外语字体）还是中文
  brand: '', homeTools: '', srcNote: '',          // 首页上的 HTML
  load: () => {},           // 往 TESTS 里放试卷，可以 async
  levelInfo: () => '',      // 首页卷子列表上面：满分、合格线
  // 算分：test、做了哪些题（Set）、答案、主观题自评 ->
  // { full(整套都做了), total(总分，算不出是 null), max, pass, label('合格' / '2급'), verdict(成绩页结论 HTML), totalName, note,
  //   areas:[{ name, zh, score(null = 不全算不了), max, ok, n, min(基准点), open(主观题), pending(还没自评) }] }
  score: () => ({ areas: [], full: false, total: null, max: 0, pass: null }),
};

const TESTS = {};
let REC = null;         // 做题记录 + 偏好，启动时按 EXAM 的默认值建
let ACTIVE = null;      // 进行中的一场（exam / practice / redo），和 SV.S 是同一个对象
let SV = null;          // 做题界面的运行时状态（卷子、音频、计时器……）
let view = 'home';

// ---------------------------------------------------------------- 小工具
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const tl = s => `<span class="tl" lang="${EXAM.lang}">${esc(s)}</span>`;       // 外语
const tn = s => (EXAM.typesInTl ? tl(s) : esc(s));                              // 题型名
const pad2 = n => String(n).padStart(2, '0');
function fmtTime(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60;
  return h ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
}
function fmtDur(sec) {
  const m = Math.round(sec / 60);
  return m < 60 ? `${m} 分钟` : `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}
function fmtDate(ts) {
  const d = new Date(ts), now = new Date();
  const day = d.toDateString() === now.toDateString() ? '今天' : `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${day} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
const pct = (a, b) => b ? Math.round(a / b * 100) : 0;
const charLen = s => [...(s || '')].filter(c => c !== '\n' && c !== '\r').length;   // 原稿纸：空格也占一格，换行不算

function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.hidden = true; }, ms);
}

// 通用弹窗：resolve(按钮的 value)，点遮罩 / Esc = null；modal.close(v) 从外面关
function modal(html, { wide = false } = {}) {
  const box = $('#modal');
  box.innerHTML = `<div class="card dlg${wide ? ' wide' : ''}">${html}</div>`;
  box.hidden = false;
  return new Promise(resolve => {
    const done = v => { box.hidden = true; box.innerHTML = ''; box.onclick = null; document.removeEventListener('keydown', onKey, true); resolve(v); };
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); done(null); } };
    document.addEventListener('keydown', onKey, true);
    box.onclick = e => {
      if (e.target === box) return done(null);
      const b = e.target.closest('[data-v]');
      if (b) done(b.dataset.v);
    };
    modal.close = done;
  });
}
async function confirmBox(title, body, ok = '确定', cancel = '取消') {
  const v = await modal(`<h3>${title}</h3>${body ? `<p>${body}</p>` : ''}
    <div class="acts"><button class="btn" data-v="0">${cancel}</button><button class="btn primary" data-v="1">${ok}</button></div>`);
  return v === '1';
}

// ---------------------------------------------------------------- 存取
async function api(path, body) {
  const opt = body === undefined ? {} : { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) };
  const r = await fetch(path, opt);
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return r.json();
}
let recTimer = 0;
function saveRec() {
  clearTimeout(recTimer);
  recTimer = setTimeout(() => { recTimer = 0; api('/api/records', REC).catch(e => toast('保存记录失败：' + e.message)); }, 200);
}
let actTimer = 0;
function saveActive(now = false) {
  clearTimeout(actTimer);
  const go = () => api('/api/active', ACTIVE ? JSON.stringify(ACTIVE) : 'null').catch(() => {});
  if (now) return go();
  actTimer = setTimeout(go, 700);
}
// 关窗：把没交卷的那一场最后存一次，顺便告诉服务端可以退了（8 秒内没新请求才真退，刷新不受影响）。
// 这里每个请求都要带 ?closing=1：不带的会被服务端当成「页面还在」，清掉退出标记，服务就得空等 30 分钟才退
window.addEventListener('pagehide', () => {
  if (SV && !SV.review) { syncAudioState(); syncViewState(); }
  if (recTimer) navigator.sendBeacon('/api/records?closing=1', JSON.stringify(REC));   // 还没来得及写的（beacon 上限 64 KB，平时早就存过了）
  navigator.sendBeacon('/api/active?closing=1', ACTIVE ? JSON.stringify(ACTIVE) : 'null');
});
setInterval(() => fetch('/api/ping').catch(() => {}), 60000);

// ---------------------------------------------------------------- 试卷
function addTest(t) {
  t.byKey = Object.fromEntries(t.items.map(i => [i.key, i]));
  t.grpByKey = Object.fromEntries(t.groups.map(g => [g.key, g]));
  TESTS[t.id] = t;
}
const lvOf = level => EXAM.levels[level];
const testsOf = level => Object.values(TESTS).filter(t => t.level === level).sort((a, b) => b.order - a.order);
const isMC = it => it.ans != null;
const hasDoc = (t, d) => !!(t.docs?.[d] || t.files?.[d]);
const hasOpen = () => Object.values(TESTS).some(t => t.items.some(i => !isMC(i)));
const qWord = () => (hasOpen() ? '选择题' : '题');        // 错题本只收选择题

// ---------------------------------------------------------------- 判分
// 选择题的对错和各大题正确率在这里算；分数、合不合格按各考试的规则由 EXAM.score 算
function grade(test, keys, answers, wself = {}) {
  const set = new Set(keys);
  const groups = [];
  for (const g of test.groups) {
    const its = test.items.filter(i => i.grp === g && set.has(i.key) && isMC(i));
    if (its.length) groups.push({ g, ok: its.filter(i => answers[i.key] === i.ans).length, n: its.length });
  }
  const its = keys.map(k => test.byKey[k]).filter(Boolean);
  const mc = its.filter(isMC);
  const ok = mc.filter(i => answers[i.key] === i.ans).length;
  return { ...EXAM.score(test, set, answers, wself || {}), groups, ok, n: mc.length, open: mc.length < its.length };
}

// 错题本：每道选择题看「最后一次」做的结果；错了/没答就在本里，手动移出后再错会重新回来
function mistakeMap(level) {
  const res = {};
  const atts = [...REC.attempts].sort((a, b) => a.finishedAt - b.finishedAt);
  for (const a of atts) {
    const t = TESTS[a.testId];
    if (!t || (level && t.level !== level)) continue;
    const m = res[a.testId] ||= {};
    for (const k of a.keys) {
      const it = t.byKey[k];
      if (!it || !isMC(it)) continue;
      const e = m[k] ||= { wrong: 0 };
      e.ok = a.answers[k] === it.ans;
      if (!e.ok) e.wrong++;
      e.lastAns = a.answers[k] || 0;
      e.ts = a.finishedAt;
    }
  }
  const out = [];
  for (const [tid, m] of Object.entries(res)) {
    const t = TESTS[tid];
    const keys = t.items.map(i => i.key).filter(k => m[k] && !m[k].ok && !((REC.mastered[tid + '|' + k] || 0) > m[k].ts));
    if (keys.length) out.push({ test: t, keys, info: m });
  }
  return out.sort((a, b) => b.test.order - a.test.order);
}

// ---------------------------------------------------------------- 路由
function go(v, ...args) {
  if (SV) unmountSession();
  view = v;
  window.scrollTo(0, 0);
  ({ home: renderHome, result: renderResult, mistakes: renderMistakes, history: renderHistory, brk: renderBreak })[v]?.(...args);
}

// ---------------------------------------------------------------- 首页
function renderHome() {
  const level = REC.prefs.level;
  const lv = lvOf(level);
  const tests = testsOf(level);
  const mk = mistakeMap(level);
  const mkN = mk.reduce((s, x) => s + x.keys.length, 0);
  const recent = REC.attempts.filter(a => TESTS[a.testId]?.level === level).sort((a, b) => b.finishedAt - a.finishedAt).slice(0, 8);
  const mins = lv.booklets.reduce((s, b) => s + b.min, 0);

  let resume = '';
  if (ACTIVE && TESTS[ACTIVE.testId]) {
    const t = TESTS[ACTIVE.testId];
    const bk = ACTIVE.booklets[ACTIVE.bi];
    const left = limitOf(ACTIVE, bk) ? ` · 剩 ${fmtTime(ACTIVE.remain)}` : '';
    resume = `<div class="resume"><span>⏸</span><div class="grow"><b>${esc(modeName(ACTIVE))}没做完</b>：${esc(lvOf(t.level).name)} ${tl(t.title)}（${esc(t.tag)}）· ${tl(bk.name)}${left}</div>
      <button class="btn" data-act="drop-active">放弃</button><button class="btn primary" data-act="resume">继续</button></div>`;
  }

  $('#app').innerHTML = `
  <div class="home">
    <div class="home-top">
      <div class="brand"><h1>${esc(EXAM.name)}</h1>${EXAM.brand}</div>
      <div class="levels">${Object.keys(EXAM.levels).map(l => `<button class="${l === level ? 'on' : ''}" data-act="level" data-l="${l}">${esc(lvOf(l).name)}</button>`).join('')}</div>
      ${EXAM.homeTools}
    </div>
    ${resume}
    <div class="home-grid">
      <div>
        <div class="list-head"><b>${esc(lv.name)}</b>
          <span class="muted">${EXAM.levelInfo(lv)} · 整套 ${lv.booklets.map(b => tl(b.name) + ' ' + b.min + '分').join(' → ')}，约 ${fmtDur(mins * 60)}</span></div>
        <div class="tests">${tests.map(testCard).join('') || '<div class="card test empty">这一级还没有试卷。</div>'}</div>
      </div>
      <div class="side">
        <div class="card">
          <h3><span class="grow">错题本</span>${mkN ? '<button class="btn sm" data-act="mistakes">打开</button>' : ''}</h3>
          ${mkN ? `<div class="big-num num">${mkN}</div><div class="muted" style="font-size:13px">道${qWord()}待重做 · 来自 ${mk.length} 套卷子</div>`
            : `<div class="empty">还没有错题。做完一套，错的${qWord()}会自动收进来。</div>`}
        </div>
        <div class="card">
          <h3><span class="grow">最近记录</span>${recent.length ? '<button class="btn sm ghost" data-act="history">全部</button>' : ''}</h3>
          ${recent.length ? `<ul class="hist">${recent.map(histRow).join('')}</ul>` : '<div class="empty">还没做过。</div>'}
        </div>
        <div class="src-note">${EXAM.srcNote}</div>
      </div>
    </div>
  </div>`;
}

function modeName(a) { return { exam: '模考', practice: '分项练习', redo: '错题重做' }[a.mode] || ''; }

// 一套卷子一行：名字 · 各科分项练习（带最近一次整科做完的成绩）· 最好的模考成绩 · 整套模考
function testCard(t) {
  const atts = REC.attempts.filter(a => a.testId === t.id);
  const exams = atts.filter(a => a.mode === 'exam').map(a => grade(t, a.keys, a.answers, a.wself)).filter(g => g.full);
  const best = exams.filter(g => g.total != null).sort((x, y) => y.total - x.total)[0];
  const partLast = {};              // 选择题是正确率，主观题是自评分
  for (const a of [...atts].sort((x, y) => x.finishedAt - y.finishedAt)) {
    if (a.mode === 'redo') continue;
    for (const p of t.parts) {
      const all = t.items.filter(i => i.part === p);
      if (!all.every(i => a.keys.includes(i.key))) continue;
      const mc = all.filter(isMC);
      if (mc.length) partLast[p] = pct(mc.filter(i => a.answers[i.key] === i.ans).length, mc.length) + '%';
      else if (all.every(i => a.wself?.[i.key] != null)) partLast[p] = all.reduce((s, i) => s + a.wself[i.key], 0) + ' 分';
    }
  }
  const verdict = best ? `<span class="badge ${best.pass ? 'ok' : 'ng'}" title="模考最好成绩">${tl(best.label)} · ${best.total}</span>`
    : exams.length ? '<span class="badge warn">模考待自评</span>' : '';
  return `<div class="card test">
    <div class="test-name" title="做过 ${atts.length} 次"><h3 class="test-title">${tl(t.title)}</h3><div class="test-sub">${esc(t.tag)} · ${verdict || `做过 ${atts.length} 次`}</div></div>
    <div class="parts-line">
      ${t.parts.map(p => {
        const n = t.items.filter(i => i.part === p).length;
        return `<button class="part-btn" data-act="practice" data-t="${esc(t.id)}" data-p="${p}" title="分项练习：只做这一科，不限时，可以逐大题对答案${partLast[p] ? `\n上次整科做完：${partLast[p]}` : ''}">${tl(t.partName[p])}<small>${n} 题${partLast[p] ? ` · <b>${partLast[p]}</b>` : ''}</small></button>`;
      }).join('')}
    </div>
    <button class="btn primary" data-act="exam" data-t="${esc(t.id)}" title="按真实考试的科目顺序和时限做整套">整套模考</button>
  </div>`;
}

function scoreBadge(g) {
  return g.total != null ? `<span class="badge ${g.pass ? 'ok' : 'ng'} num">${g.total}</span>`
    : g.n ? `<span class="badge num">${pct(g.ok, g.n)}%</span>` : '<span class="badge warn">待自评</span>';
}

function histRow(a) {
  const t = TESTS[a.testId];
  if (!t) return '';
  const g = grade(t, a.keys, a.answers, a.wself);
  const what = a.mode === 'exam' ? '模考' : a.mode === 'redo' ? '错题重做' : t.partName[a.part] || '练习';
  return `<li data-act="open-attempt" data-id="${esc(a.id)}"><span class="grow">${tl(t.short)} ${tl(what)}<span class="when"> · ${fmtDate(a.finishedAt)}</span></span>${scoreBadge(g)}</li>`;
}

// ---------------------------------------------------------------- 开始一场
// 模考的听力那一节不限时：录音可以暂停、拖动、回放（跟分项练习一样），做完自己交卷
const isListenBk = bk => bk.parts.length === 1 && bk.parts[0] === 'L';
const limitOf = (S, bk) => (S.mode === 'exam' && isListenBk(bk) ? 0 : bk.limit);

function newSession(testId, mode, opt = {}) {
  const t = TESTS[testId], lv = lvOf(t.level);
  let booklets;
  if (mode === 'exam') {
    booklets = lv.booklets.map(b => ({ name: b.name, parts: b.parts, limit: b.min * 60, keys: t.items.filter(i => b.parts.includes(i.part)).map(i => i.key) }))
      .filter(b => b.keys.length);
  } else if (mode === 'practice') {
    booklets = [{ name: t.partName[opt.part], parts: [opt.part], limit: 0, keys: t.items.filter(i => i.part === opt.part).map(i => i.key) }];
  } else {
    const keys = opt.keys;
    booklets = [{ name: '错题重做', parts: t.parts.filter(p => keys.some(k => t.byKey[k].part === p)), limit: 0, keys }];
  }
  return {
    id: 'a' + Date.now().toString(36), testId, mode, part: opt.part || null,
    booklets, bi: 0, phase: 'doing',
    answers: {}, flags: {}, revealed: {}, used: [],
    remain: booklets[0].limit, bElapsed: 0,
    audio: { idx: 0, t: 0 },
    startedAt: Date.now(),
  };
}

async function startSession(testId, mode, opt) {
  if (ACTIVE) {
    const ok = await confirmBox('放弃没做完的那一场？', `「${esc(modeName(ACTIVE))}」还没交卷，开始新的会把它丢掉（不计成绩）。`, '放弃并开始', '取消');
    if (!ok) return;
  }
  ACTIVE = newSession(testId, mode, opt);
  saveActive(true);
  openSession(ACTIVE);
}

// ---------------------------------------------------------------- 做题界面
// SV：{ S, test, bk, keys, parts, review, attempt, cur, tab, tabs, frames, itemEls, tick, audio, tracks, chips… }
function openSession(S, review = null) {
  if (SV) unmountSession();
  view = 'session';
  const test = TESTS[S.testId];
  const bk = S.booklets[S.bi];
  SV = {
    S, test, bk, review: !!review, attempt: review,
    keys: review ? review.keys : bk.keys,
    cur: null, tab: null, frames: {}, itemEls: {}, paused: false,
    last: Date.now(), lastSave: Date.now(),
    audio: null, playKey: null,
  };
  const parts = test.parts.filter(p => SV.keys.some(k => test.byKey[k]?.part === p));
  SV.parts = parts;
  const hasL = parts.includes('L');
  const au = hasL && test.audio.length > 0;
  const open = SV.keys.some(k => test.byKey[k] && !isMC(test.byKey[k]));
  const docs = [...new Set(parts.map(p => test.partDoc[p]))];
  const tabs = docs.map(d => ({ id: d, label: EXAM.docNames[d] || d }));
  // 听力原文（带译文）：订正随时能看；做题时对过这一大题的答案才给看（模考不能对答案，所以整场都看不到）
  if (hasL && hasDoc(test, 'script')) {
    tabs.push({ id: 'script', label: EXAM.docNames.script, hidden: !SV.review && !Object.keys(S.revealed).some(gk => test.grpByKey[gk]?.part === 'L') });
  }
  if (SV.review && hasDoc(test, 'answer')) tabs.push({ id: 'answer', label: EXAM.docNames.answer });
  SV.tabs = tabs;

  const lvName = lvOf(test.level).name;
  let title, sub;
  if (SV.review) {
    const g = grade(test, review.keys, review.answers, review.wself);
    title = `订正 · ${lvName} ${test.title}`;
    sub = `${modeName(review)}${review.part ? ' · ' + test.partName[review.part] : ''} · ${fmtDate(review.finishedAt)}${g.n ? ` · ${g.open ? '选择题对' : '正确'} ${g.ok}/${g.n}` : ''}`;
  } else {
    title = `${modeName(S)} · ${lvName} ${test.title}（${test.tag}）`;
    sub = S.mode === 'exam' ? `第 ${S.bi + 1}/${S.booklets.length} 部分：${bk.name}` : bk.name;
  }
  const jump = `卷子${au && test.audio.length > 1 ? '和录音' : ''}跳到那一题`;     // 只有一整段录音的不知道每题从哪开始

  $('#app').innerHTML = `
  <div class="sess">
    <header class="sess-top">
      <button class="btn ghost" data-act="exit">‹ ${SV.review ? '返回' : '退出'}</button>
      <div class="sess-title"><b>${esc(title)}</b>${tl(sub)}</div>
      ${SV.review ? '<label class="sess-prog"><input type="checkbox" data-act="only-wrong"> 只看错题</label>'
        : `<div class="sess-prog">已答 <b class="num" id="answered">0</b> / ${SV.keys.length}</div>
           <div class="timer" id="timer"></div>
           <button class="btn" data-act="pause">暂停</button>
           <button class="btn primary" data-act="submit">交卷</button>`}
    </header>
    <div class="sess-body${open ? ' has-open' : ''}">
      <section class="paper">
        <nav class="paper-tabs">${tabs.map(tb => `<button data-act="tab" data-tab="${tb.id}" ${tb.hidden ? 'hidden' : ''}>${tl(tb.label)}</button>`).join('')}
          <span class="spacer"></span>
          ${test.docs ? `${hasL && test.trans ? `<label class="follow" id="trans-tg" hidden title="听力原文里插中文译文"><input type="checkbox" data-act="trans" ${REC.prefs.trans !== false ? 'checked' : ''}> 译文</label>` : ''}
            <label class="follow" title="答题卡换题${au ? '、录音放到下一题' : ''}时，卷子自动滚到那一题"><input type="checkbox" data-act="follow" ${REC.prefs.follow ? 'checked' : ''}> 卷子跟着走</label>
            <span class="zoom"><button data-act="zoom" data-z="-1" title="缩小">−</button><span id="zoomv">${Math.round(REC.prefs.zoom * 100)}%</span><button data-act="zoom" data-z="1" title="放大">＋</button></span>`
            : '<span class="hint">在卷子上点过之后，点一下右边答题卡才能用键盘作答</span>'}</nav>
        <div class="frames" id="frames" style="--zoom:${REC.prefs.zoom}"></div>
      </section>
      <aside class="sheet${SV.review ? ' locked' : ''}" id="sheet">
        <div id="audio-box" ${hasL ? '' : 'hidden'} class="audio-box"></div>
        <div class="sheet-scroll" id="sheet-scroll">${sheetHTML()}</div>
        <div class="sheet-help">${SV.review ? `绿色是正确答案，红色是你选错的。点题号：${jump}${test.docs ? '；点卷子上的题，右边也跟着选中' : ''}。`
          : `<kbd>1</kbd>–<kbd>4</kbd> 作答并跳下一题 · <kbd>↑</kbd><kbd>↓</kbd> 换题 · <kbd>F</kbd> 标记 · <kbd>0</kbd> 清除${au ? ' · <kbd>空格</kbd> 播放/暂停 · <kbd>←</kbd><kbd>→</kbd> 5 秒' : ''}<br>点题号：${jump}${test.docs ? ' · 点卷子上的题也能选中' : ''}`}</div>
      </aside>
      <div class="pause-cover" id="pause-cover" hidden><div><h2>已暂停</h2><p>计时停止${au ? '，录音也停了' : ''}。</p><button class="btn primary" data-act="pause">继续做题</button></div></div>
    </div>
  </div>`;

  for (const el of $$('.it, .wit', $('#sheet-scroll'))) SV.itemEls[el.dataset.key] = el;   // 别用 [data-key]：自评框也带着它
  SV.keys.forEach(paintItem);
  paintGroups();
  paintCount();
  if (hasL) mountAudio();
  // 接着上次退出时的样子（S.view，换到下一部分就不算了）：选中哪题、看哪份卷子、答题卡滚到哪；卷子滚到哪在 showTab 建阅读器时摆回去
  const v = !SV.review && S.view?.bi === S.bi && SV.keys.includes(S.view.cur) ? S.view : null;
  if (v) {
    SV.at = v.at || {};
    setCur(v.cur, false, false);                 // 先选中（会翻到那题的卷子），再翻回当时看的那份
    showTab(SV.tabs.some(tb => tb.id === v.tab && !tb.hidden) ? v.tab : SV.tab || docs[0]);
    $('#sheet-scroll').scrollTop = v.sheet || 0;
  } else {
    showTab(docs[0]);
    setCur(SV.keys.find(k => !answered(k)) || SV.keys[0], false);
  }
  if (!SV.review) {
    paintTimer();
    SV.tick = setInterval(tick, 250);
  }
}

function unmountSession() {
  if (!SV) return;
  clearInterval(SV.tick);
  syncViewState();
  if (SV.audio) { syncAudioState(); SV.audio.pause(); SV.audio.removeAttribute('src'); SV.audio.load(); }
  if (!SV.review && ACTIVE === SV.S) saveActive(true);
  SV = null;
}

const answersNow = () => (SV.review ? SV.attempt.answers : SV.S.answers);
// 答了没有：选择题是数字，主观题是字符串或 { a: 第一个空, b: … }
function filled(a) {
  if (a == null) return false;
  if (typeof a === 'number') return true;
  if (typeof a === 'string') return a.trim() !== '';
  return Object.values(a).some(v => String(v ?? '').trim() !== '');
}
const answered = k => filled(answersNow()[k]);

function sheetHTML() {
  const t = SV.test, ans = answersNow();
  let h = '', lastPart = null, lastGrp = null;
  const close = () => { if (lastGrp) h += '</div></div>'; lastGrp = null; };
  for (const k of SV.keys) {
    const it = t.byKey[k];
    if (!it) continue;
    if (it.part !== lastPart) {
      close();
      h += `<div class="part-h" data-act="tab" data-tab="${t.partDoc[it.part]}" data-part="${it.part}">${tl(t.partName[it.part])}</div>`;
      lastPart = it.part;
    }
    const g = it.grp;
    if (g.key !== lastGrp) {
      close();
      const canReveal = !SV.review && SV.S.mode !== 'exam' && isMC(it);
      h += `<div class="grp${isMC(it) ? '' : ' open'}" data-grp="${g.key}">
        <div class="grp-h"><span class="grp-no" data-act="grp-go" data-grp="${g.key}" title="卷子${it.track != null && (t.audio.length > 1 || it.cue != null) ? '和录音' : ''}跳到这一大题">${tl(g.label)}</span><span class="grp-type">${tn(g.name)}</span>
        <span class="grp-score num"></span>${canReveal ? `<button class="btn sm" data-act="reveal" data-grp="${g.key}">对答案</button>` : ''}</div>
        <div class="grp-items">`;
      lastGrp = g.key;
    }
    if (!isMC(it)) { h += openHTML(it, ans[k]); continue; }
    let bubs = '';
    for (let i = 1; i <= it.nOpt; i++) bubs += `<span class="bub" data-act="ans" data-n="${i}">${i}</span>`;
    h += `<div class="it" data-key="${k}"><span class="it-no" data-act="cur" title="${esc(it.tip || '')}">${esc(it.label)}</span>${bubs}`
      + `${it.pts != null ? `<span class="pts">${it.pts}</span>` : ''}<span class="flag" data-act="flag" title="标记一下，交卷前再看（F）">⚑</span></div>`;
  }
  close();
  return h;
}

// 主观题：几个空（㉠㉡…，一个空一句）或者一段（数字数）；订正时在这里自评
const BLANKS = '㉠㉡㉢㉣㉤';
function openHTML(it, a) {
  const ro = SV.review ? 'readonly' : '';
  const self = SV.review ? SV.attempt.wself?.[it.key] : null;
  const selfBox = SV.review ? `<label class="wself">自评 <input type="number" min="0" max="${it.pts}" step="1" data-act="wself" data-key="${it.key}" value="${self ?? ''}" placeholder="—"> / ${it.pts}</label>` : '';
  const head = `<span class="it-no" data-act="cur">${esc(it.label)}</span><span class="muted">${it.pts} 分`;
  if (it.open.blanks) {
    const v = a || {};
    return `<div class="wit" data-key="${it.key}"><div class="wit-h">${head} · ${it.open.blanks} 个空各写一句</span>${selfBox}</div>
      ${Array.from({ length: it.open.blanks }, (_, i) => { const w = String.fromCharCode(97 + i); return `<label class="blank">${tl(BLANKS[i])}<input type="text" lang="${EXAM.lang}" data-w="${w}" value="${esc(v[w] || '')}" ${ro}></label>`; }).join('')}</div>`;
  }
  const [lo, hi] = it.open.len;
  const n = charLen(a);
  return `<div class="wit" data-key="${it.key}"><div class="wit-h">${head} · ${lo}–${hi} 字</span>
      <span class="wcount ${n && (n < lo || n > hi) ? 'bad' : ''}" data-cnt>${n} 字</span>${selfBox}</div>
    <textarea lang="${EXAM.lang}" rows="${it.open.rows || 9}" data-w="t" ${ro} placeholder="${SV.review ? '（没写）' : '空格也算一个字（按原稿纸一格一字）'}">${esc(a || '')}</textarea></div>`;
}

let wTimer = 0;
function onOpenInput(el) {
  const box = el.closest('.wit');
  const k = box.dataset.key;
  const S = SV.S;
  if (el.dataset.w === 't') {
    S.answers[k] = el.value;
    const it = SV.test.byKey[k], n = charLen(el.value);
    const c = box.querySelector('[data-cnt]');
    c.textContent = `${n} 字`;
    c.classList.toggle('bad', n > 0 && (n < it.open.len[0] || n > it.open.len[1]));
  } else {
    const v = S.answers[k] = { ...(S.answers[k] || {}) };
    v[el.dataset.w] = el.value;
  }
  paintItem(k);
  clearTimeout(wTimer);
  wTimer = setTimeout(() => { paintCount(); saveActive(); }, 400);
}

function setWself(a, key, v) {
  const it = TESTS[a.testId].byKey[key];
  a.wself ||= {};
  if (v === '' || v == null || isNaN(+v)) delete a.wself[key];
  else a.wself[key] = Math.max(0, Math.min(it.pts, Math.round(+v)));
  saveRec();
}

const shown = it => SV.review || !!SV.S.revealed[it.grp.key];

function paintItem(k) {
  const el = SV.itemEls[k];
  if (!el) return;
  const it = SV.test.byKey[k];
  const flags = SV.review ? SV.attempt.flags || {} : SV.S.flags;
  el.classList.toggle('cur', SV.cur === k);
  el.classList.toggle('flagged', !!flags[k]);
  if (!isMC(it)) { el.classList.toggle('done', answered(k)); return; }
  const a = answersNow()[k];
  const show = shown(it);
  el.classList.toggle('ok', show && a === it.ans);
  el.classList.toggle('ng', show && a !== it.ans);
  for (const b of el.querySelectorAll('.bub')) {
    const n = +b.dataset.n;
    b.classList.toggle('sel', a === n);
    b.classList.toggle('right', show && n === it.ans);
    b.classList.toggle('wrong', show && a === n && n !== it.ans);
  }
}

function paintGroups() {
  const t = SV.test, ans = answersNow();
  const mcOf = pred => SV.keys.map(k => t.byKey[k]).filter(it => it && isMC(it) && pred(it));
  for (const g of $$('.grp', $('#sheet-scroll'))) {
    const its = mcOf(it => it.grp.key === g.dataset.grp);
    if (!its.length) continue;
    const show = shown(its[0]);
    const ok = its.filter(it => ans[it.key] === it.ans).length;
    const sc = g.querySelector('.grp-score');
    sc.textContent = show ? `${ok}/${its.length}` : '';
    sc.style.color = show ? (ok === its.length ? 'var(--ok)' : 'var(--ng)') : '';
    g.classList.toggle('allok', show && ok === its.length);
    g.classList.toggle('locked', show);
    const btn = g.querySelector('[data-act=reveal]');
    if (btn) btn.hidden = show;
  }
  for (const ph of $$('.part-h', $('#sheet-scroll'))) {
    const its = mcOf(it => it.part === ph.dataset.part);
    ph.classList.toggle('allok', its.length > 0 && its.every(it => shown(it) && ans[it.key] === it.ans));
  }
}

function paintCount() {
  const el = $('#answered');
  if (el) el.textContent = SV.keys.filter(answered).length;
}

function paintTimer() {
  const el = $('#timer');
  if (!el) return;
  const S = SV.S, bk = SV.bk;
  let txt, sub, cls = '';
  if (limitOf(S, bk)) {
    txt = fmtTime(S.remain); sub = '剩余时间';
    if (S.remain <= 60) cls = 'danger'; else if (S.remain <= 600) cls = 'warn';
  } else {
    txt = fmtTime(S.bElapsed); sub = '已用时间';
  }
  el.className = 'timer ' + cls;
  el.innerHTML = `${txt}<small>${sub}</small>`;
}

function tick() {
  const now = Date.now();
  const dt = (now - SV.last) / 1000;
  SV.last = now;
  const S = SV.S, bk = SV.bk;
  if (SV.paused) return;
  S.bElapsed += dt;
  if (limitOf(S, bk)) {
    S.remain -= dt;
    if (S.remain <= 0) { S.remain = 0; paintTimer(); submitBooklet(true); return; }
  }
  paintTimer();
  if (now - SV.lastSave > 10000) { SV.lastSave = now; syncAudioState(); syncViewState(); saveActive(); }
}

// 界面现在的样子记进这一场（S.view），关了程序再打开也照原样摆回去。bi 按界面上这份记：交卷进下一部分时 S.bi 已经加过了
function syncViewState() {
  const box = $('#sheet-scroll');
  if (!SV || SV.review || !box) return;
  const at = { ...SV.at };                       // 这次没打开过的卷子，沿用上次记的
  for (const [id, el] of Object.entries(SV.frames)) if (el.classList.contains('viewer')) at[id] = viewerAt(el);
  SV.S.view = { bi: SV.S.booklets.indexOf(SV.bk), tab: SV.tab, cur: SV.cur, sheet: Math.round(box.scrollTop), at };
}

// ---- 卷子 ----
// 有页面图的：自己的阅读器，能滚到某一题；只有 PDF 的（自备卷）：Edge 自带阅读器，跳不了题
function showTab(id) {
  const tb = SV.tabs.find(x => x.id === id);
  if (!tb) return;
  SV.tab = id;
  for (const b of $$('.paper-tabs button[data-tab]')) b.classList.toggle('on', b.dataset.tab === id);
  if (!SV.frames[id]) {
    let el;
    if (SV.test.docs?.[id]) {
      el = viewerEl(id);
    } else if (SV.test.files?.[id]) {
      el = document.createElement('iframe');
      el.src = SV.test.files[id];               // Edge 阅读器在 iframe 里不认 #pagemode=none / #view=FitH，别加
      el.title = tb.label;
    } else {
      el = document.createElement('div');
      el.className = 'no-pdf';
      el.textContent = '这部分没有 PDF';
    }
    $('#frames').appendChild(el);
    SV.frames[id] = el;
    const at = SV.at?.[id];                      // 上次退出时滚到的地方
    if (at && el.classList.contains('viewer')) viewerTo(el, at);
    // 只做主观题时，正答表一打开就翻到模范答案
    const p = id === 'answer' && SV.test.answerPos?.[SV.parts[0]];
    if (p) scrollToPos(p, { force: true, mark: false });
  }
  const tg = $('#trans-tg');
  if (tg) tg.hidden = id !== 'script';
  for (const [k, el] of Object.entries(SV.frames)) el.classList.toggle('off', k !== id);
}
function unhideTab(tb) {
  if (tb?.hidden) { tb.hidden = false; $(`.paper-tabs [data-tab="${tb.id}"]`).hidden = false; }
}

// 听力原文有译文时，页面图在每段原文讲完的地方切开（一页切成几片 .pg，data-y0/y1 是这片在原图里的像素范围），译文插在切口
function viewerEl(id) {
  const d = SV.test.docs[id];
  const el = document.createElement('div');
  el.className = 'viewer' + (REC.prefs.trans === false ? ' no-tr' : '');
  el.dataset.doc = id;
  const tr = id === 'script' && SV.test.trans || [];
  let h = '<div class="pages">';
  for (let i = 0; i < d.pages; i++) {
    const src = `${SV.test.img}${id}-${pad2(i + 1)}.jpg`;
    const segs = tr.filter(t => t.at[0] === i).sort((a, b) => a.at[1] - b.at[1]);
    let y0 = 0;
    for (const t of segs) {
      const y1 = Math.min(t.at[1], d.h);
      if (y1 > y0) { h += slice(i, y0, y1, d, src, y1 < d.h); y0 = y1; }
      h += transHTML(t);
    }
    if (y0 < d.h) h += slice(i, y0, d.h, d, src, false);
  }
  el.innerHTML = h + '</div>';
  return el;
}

// 页面图的一片：原图第 page 页 y0–y1 像素；cut = 下面紧接着译文（这片不留页间距）
function slice(page, y0, y1, d, src, cut) {
  const hh = y1 - y0;
  const img = y0 || y1 < d.h ? ` style="position:absolute;left:0;top:${-y0 / hh * 100}%;height:${d.h / hh * 100}%"` : '';
  return `<div class="pg${y0 ? ' cont' : ''}${cut ? ' cut' : ''}" data-p="${page}" data-y0="${y0}" data-y1="${y1}" style="aspect-ratio:${d.w}/${hh}"><img loading="lazy" decoding="async" src="${src}"${img} alt="第 ${page + 1} 页"></div>`;
}

// 一段译文卡：对话一行一句（「男：…」悬挂缩进，念的选项「2. …」跟着对齐，别的是旁白），后面是题干和选项；
// 点它 = 选中这题、录音跳到这题
function transHTML(t) {
  const qs = Object.entries(t.qs || {}).map(([no, [stem, ...opts]]) =>
    `<div class="tr-q">${stem ? `<div class="tr-stem">${no}. ${esc(stem)}</div>` : ''}<ol class="c${optCols(opts)}">${opts.map(o => `<li>${esc(o)}</li>`).join('')}</ol></div>`).join('');
  return `<div class="tr"${t.key ? ` data-key="${t.key}"` : ''}><div class="tr-h">译文 · ${esc(t.head)}</div>`
    + t.lines.map(l => `<p${/^[^：]{1,4}：/.test(l) ? '' : /^\d\. /.test(l) ? ' class="opt"' : ' class="nar"'}>${esc(l)}</p>`).join('') + qs + '</div>';
}
// 选项排几列：照卷面，短的一行四个，中等两个，长句一行一个
const optCols = opts => { const m = Math.max(...opts.map(o => o.length)); return m <= 6 ? 4 : m <= 14 ? 2 : 1; };

// 阅读器滚到哪：[顶上那片（页面图 / 译文卡）是第几片, 滚进去几成]。按片记，换了窗口大小、缩放、译文开关也对得上
function viewerAt(v) {
  const kids = v.querySelector('.pages').children, top = v.scrollTop;
  for (let i = 0; i < kids.length; i++) {
    const el = kids[i], h = el.offsetHeight;      // 收起的译文卡高 0，跳过
    if (h && el.offsetTop + h > top) return [i, Math.round((top - el.offsetTop) / h * 1e4) / 1e4];
  }
  return [0, 0];
}
function viewerTo(v, [i, f]) {
  let el = v.querySelector('.pages').children[i];
  while (el && !el.offsetHeight) { el = el.nextElementSibling; f = 0; }   // 记的是译文卡、现在译文关了：落到它下面那片
  if (el) v.scrollTop = el.offsetTop + f * el.offsetHeight;
}

// 原图第 page 页 y 像素落在哪一片 .pg 上
function pgAt(v, page, y) {
  let hit = null;
  for (const pg of v.querySelectorAll(`.pg[data-p="${page}"]`)) { hit = pg; if (y < +pg.dataset.y1) break; }
  return hit;
}

// 卷子滚到某个位置：pos = [卷子, 页, y 像素, 准不准]。force=false 时已经在视野里就不动
function scrollToPos(pos, { force = false, mark = true } = {}) {
  if (!pos || !SV.test.docs) return;
  const [doc, page, y, exact] = pos;
  if (SV.tab !== doc) showTab(doc);
  const v = SV.frames[doc];
  const pg = v?.classList.contains('viewer') && pgAt(v, page, y);
  if (!pg) return;
  const y0 = +pg.dataset.y0, hh = pg.dataset.y1 - y0;
  const top = pg.offsetTop + ((y - y0) / hh) * pg.clientHeight;
  if (mark) {
    $$('.qmark', v).forEach(m => m.remove());
    const m = document.createElement('i');
    m.className = 'qmark' + (exact ? '' : ' approx');
    m.style.top = ((y - y0) / hh * 100) + '%';
    pg.appendChild(m);
  }
  if (force || top < v.scrollTop + 20 || top > v.scrollTop + v.clientHeight - 140) {
    // 不用平滑滚动：途中懒加载的页面图一解码就会把平滑滚动打断，停在半路
    v.scrollTop = Math.max(0, top - 80);
  }
}

// 一道题该滚到哪：在「听力原文」标签页就滚到原文里那题，否则滚到卷子上那题
function posOf(it) {
  if (!it) return null;
  if (SV.tab === 'script' && it.part === 'L') return it.spos;
  return it.pos;
}

// 点卷子上的某个位置 -> 选中那里的题（它上面最近的一个题号）
function pickFromPaper(pg, e) {
  const doc = pg.closest('.viewer').dataset.doc;
  const page = +pg.dataset.p;
  const y0 = +pg.dataset.y0;
  const y = y0 + (e.clientY - pg.getBoundingClientRect().top) / pg.clientHeight * (pg.dataset.y1 - y0);
  let best = null;
  for (const k of SV.keys) {
    const it = SV.test.byKey[k];
    const p = doc === 'script' ? it.spos : it.nopick ? null : it.pos;
    if (!p || p[0] !== doc) continue;
    if (p[1] < page || (p[1] === page && p[2] <= y + 25)) best = k;
  }
  if (best) setCur(best, true, false);
}

function setZoom(d) {
  const z = Math.min(2, Math.max(0.6, Math.round((REC.prefs.zoom + d * 0.1) * 10) / 10));
  const v = SV.frames[SV.tab];
  const ratio = v ? v.scrollTop / (v.scrollHeight || 1) : 0;
  REC.prefs.zoom = z;
  saveRec();
  $('#frames').style.setProperty('--zoom', z);
  $('#zoomv').textContent = Math.round(z * 100) + '%';
  if (v) v.scrollTop = ratio * v.scrollHeight;
}

// ---- 答题卡 ----
// paper：要不要让卷子跟过去（开了「卷子跟着走」才跟；点选项不跟）
function setCur(k, scroll = true, paper = true) {
  if (!k) return;
  const prev = SV.cur;
  SV.cur = k;
  if (prev) paintItem(prev);
  paintItem(k);
  const it = SV.test.byKey[k];
  if (!it) return;
  const doc = SV.test.partDoc[it.part];
  const away = SV.tab !== doc && SV.tab !== 'script' && SV.tab !== 'answer';    // 正看着别的科目的卷子：翻过去
  if (away) showTab(doc);
  if (scroll) scrollSheetTo(SV.itemEls[k]);
  if (paper && (away || (REC.prefs.follow && SV.tab !== 'answer'))) scrollToPos(posOf(it));
}

// 答题卡滚到某一题（不用 scrollIntoView：它会连整页一起滚）
function scrollSheetTo(el, top = false) {
  const box = $('#sheet-scroll');
  if (!el || !box) return;
  const r = el.getBoundingClientRect(), b = box.getBoundingClientRect();
  if (top) box.scrollTop += r.top - b.top - 8;
  else if (r.top < b.top + 4) box.scrollTop += r.top - b.top - 30;
  else if (r.bottom > b.bottom - 4) box.scrollTop += r.bottom - b.bottom + 30;
}

// 点题号：卷子滚到这题（强制），听力题录音也跳到这题开头
function jumpTo(k) {
  const it = SV.test.byKey[k];
  setCur(k, false, false);
  if (SV.tab === 'answer') showTab(SV.test.partDoc[it.part]);
  scrollToPos(posOf(it), { force: true });
  if (it.part === 'L') seekItem(it);
}

// 点大题号：卷子滚到大题说明，录音从这一大题开头放
function jumpToGrp(gk) {
  const k = SV.keys.find(x => SV.test.byKey[x].grp.key === gk);
  if (!k) return;
  const it = SV.test.byKey[k], g = it.grp, doc = SV.test.partDoc[it.part];
  setCur(k, false, false);
  if (SV.tab === 'answer' || (SV.tab !== 'script' && SV.tab !== doc)) showTab(doc);
  scrollToPos((SV.tab === 'script' ? g.spos : g.pos) || posOf(it), { force: true, mark: false });
  if (SV.audio) playChip(SV.chips.find(x => x.g === gk));
}

// toggle：鼠标点已选的那个 = 取消；键盘按数字只管选上
function answer(k, n, toggle = true) {
  if (SV.review) return;
  const it = SV.test.byKey[k];
  if (!isMC(it) || shown(it) || n > it.nOpt) return;               // 对过答案的题锁住
  const S = SV.S;
  if (!n || (toggle && S.answers[k] === n)) delete S.answers[k];
  else S.answers[k] = n;
  paintItem(k);
  paintCount();
  saveActive();
}

function toggleFlag(k) {
  if (SV.review) return;
  const F = SV.S.flags;
  F[k] ? delete F[k] : (F[k] = 1);
  paintItem(k);
  saveActive();
}

function move(d) {
  const i = SV.keys.indexOf(SV.cur);
  const j = Math.min(SV.keys.length - 1, Math.max(0, i + d));
  setCur(SV.keys[j]);
}

async function reveal(gk) {
  const S = SV.S;
  const its = SV.keys.map(k => SV.test.byKey[k]).filter(it => it.grp.key === gk);
  const blank = its.filter(it => !S.answers[it.key]).length;
  if (blank && !(await confirmBox('还有空着的题', `这一大题还有 ${blank} 道没答，对完答案就不能再改了。`, '对答案', '再想想'))) return;
  S.revealed[gk] = true;
  its.forEach(it => paintItem(it.key));
  paintGroups();
  if (SV.test.grpByKey[gk]?.part === 'L') unhideTab(SV.tabs.find(x => x.id === 'script'));   // 对过听力答案就能看原文了
  saveActive();
}

function togglePause() {
  if (SV.review) return;
  SV.paused = !SV.paused;
  $('#pause-cover').hidden = !SV.paused;
  $('[data-act=pause]').textContent = SV.paused ? '继续' : '暂停';
  if (SV.audio) {
    if (SV.paused) { SV.wasPlaying = !SV.audio.paused; SV.audio.pause(); }
    else if (SV.wasPlaying) SV.audio.play().catch(() => {});
  }
  SV.last = Date.now();
}

// ---- 交卷 ----
async function submitBooklet(auto = false) {
  const S = SV.S, bk = SV.bk;
  if (!auto) {
    const blank = bk.keys.filter(k => !answered(k)).length;
    const fl = bk.keys.filter(k => S.flags[k]).length;
    const bits = [];
    if (blank) bits.push(`还有 <b>${blank}</b> 道没答`);
    if (fl) bits.push(`<b>${fl}</b> 道标记了待检查`);
    if (SV.audio && isListenBk(bk) && !SV.audioEnded) bits.push('录音还没放完');
    const more = S.mode === 'exam' && S.bi < S.booklets.length - 1;
    const ok = await confirmBox(more ? '交这一部分？' : '交卷？',
      (bits.length ? bits.join('，') + '。' : '全部答完了。') + (more ? '交了就进下一部分，不能回来改。' : ''), '交卷', '继续做');
    if (!ok || !SV) return;
  }
  if (auto) toast('时间到，已自动交卷', 4000);
  S.used[S.bi] = Math.round(S.bElapsed);
  if (S.mode === 'exam' && S.bi < S.booklets.length - 1) {
    S.bi++;
    S.remain = S.booklets[S.bi].limit;
    S.bElapsed = 0;
    S.phase = 'break';
    saveActive(true);
    go('brk');
    return;
  }
  finish(S);
}

function finish(S) {
  const a = {
    id: S.id, testId: S.testId, mode: S.mode, part: S.part,
    keys: S.booklets.flatMap(b => b.keys), answers: S.answers, flags: S.flags,
    startedAt: S.startedAt, finishedAt: Date.now(),
    seconds: S.used.reduce((s, x) => s + (x || 0), 0), used: S.used, booklets: S.booklets.map(b => b.name),
  };
  REC.attempts.push(a);
  ACTIVE = null;
  saveRec();
  saveActive(true);
  go('result', a);
}

// ---- 听力 ----
// 模考、练习、订正都一样：这一场的录音一段放完自动接下一段；能暂停、拖动、±5 秒、变速。
// 知道每题在哪段录音、从第几秒开始（it.track / it.cue）：点题号就跳过去，答题卡上 ♪ 标着正在放哪题。
// SV.tracks：这一场要放的段（开场说明 + 题目用到的段，按题的顺序；一场之内不变，S.audio.idx 是它的下标）；
// SV.chips：播放条上的按钮，一个大题一个 { from, to(SV.tracks 下标), g, label, title, t(整段录音里从第几秒开始) }
function mountAudio() {
  const test = SV.test, box = $('#audio-box');
  const tracks = [], chips = [], seen = {};
  const Ls = SV.keys.map(k => test.byKey[k]).filter(it => it?.part === 'L' && test.audio[it.track]);
  const firstL = test.items.find(it => it.part === 'L');
  if (test.intro != null && Ls[0] && Ls[0] === firstL) tracks.push({ ...test.audio[test.intro], i: test.intro, g: null });
  for (const it of Ls) {
    const s = seen[it.track];
    if (s) { if (s.g !== it.grp.key) s.shared = true; continue; }     // 一段录音跨好几个大题（只有整段录音的卷子）
    tracks.push(seen[it.track] = { ...test.audio[it.track], i: it.track, g: it.grp.key });
  }
  tracks.forEach((tr, j) => {
    // 整段录音（整套的大题都在这一段里），每题从第几秒开始也都知道：照样一个大题一个按钮，按钮记着秒数
    const its = Ls.filter(it => it.track === tr.i);
    if (new Set(test.items.filter(it => it.track === tr.i).map(it => it.grp.key)).size > 1 && its.every(it => it.cue != null)) {
      if (its[0] === firstL && its[0].cue > 0) chips.push({ from: j, to: j, g: null, label: '开场说明', title: '', t: 0 });
      for (const it of its) if (chips.at(-1)?.g !== it.grp.key) chips.push({ from: j, to: j, g: it.grp.key, label: it.grp.label, title: it.grp.name, t: it.cue });
      return;
    }
    const g = tr.shared ? null : tr.g, last = chips[chips.length - 1];
    if (g && last?.g === g) { last.to = j; return; }
    const grp = test.grpByKey[g];
    chips.push({ from: j, to: j, g, label: grp ? grp.label : tr.name, title: grp ? grp.name : '' });
  });
  SV.tracks = tracks;
  SV.chips = chips;
  if (!tracks.length) { box.innerHTML = '<div class="audio-note">这套卷子没有听力音频。</div>'; return; }
  const au = new Audio();
  au.preload = 'auto';
  SV.audio = au;
  au.ontimeupdate = () => { paintAudio(true); trackPlaying(); };
  au.onplay = au.onpause = () => paintAudio();
  au.onended = () => {
    if (!SV) return;
    if (SV.trackIdx < tracks.length - 1) loadTrack(SV.trackIdx + 1, 0, true);
    else { SV.audioEnded = true; paintAudio(); }
    saveActive();
  };
  // 接着上次放到的地方（没交卷关了程序也记着）
  const a = SV.review ? { idx: 0, t: 0 } : SV.S.audio;
  loadTrack(Math.min(a.idx || 0, tracks.length - 1), a.t || 0, false);
}

function syncAudioState() {
  if (!SV?.audio || SV.review) return;
  SV.S.audio.idx = SV.trackIdx;
  SV.S.audio.t = SV.audio.currentTime || 0;
}
function togglePlay() { SV.audio.paused ? SV.audio.play().catch(() => {}) : SV.audio.pause(); }
function skip(d) { SV.audio.currentTime = Math.max(0, SV.audio.currentTime + d); }
const trackPos = i => SV.tracks.findIndex(x => x.i === i);
const playLabel = k => (k ? `正在放 ${SV.test.byKey[k].say}` : '');

// 换到第 i 段录音（SV.tracks 的下标），从 t 秒开始
function loadTrack(i, t = 0, play = true) {
  const tr = SV.tracks[i], au = SV.audio;
  if (!tr) return;
  const same = SV.trackIdx === i && au.src;
  SV.trackIdx = i;
  SV.audioEnded = false;
  const run = () => {
    if (t) au.currentTime = t;
    if (play) au.play().catch(e => toast('放不出声音：' + e.message));
    paintAudio();
    trackPlaying();
  };
  if (same && au.readyState >= 1) { run(); return; }
  au.src = tr.url;
  au.addEventListener('loadedmetadata', run, { once: true });
  paintAudio();
}

// 点播放条上的按钮 / 大题号：换到那段录音；整段录音的按钮从那个大题的秒数（c.t）开始，同一段里也要跳
function playChip(c) {
  if (!c) return;
  if (c.t != null && SV.trackIdx === c.from && SV.audio.readyState >= 1) SV.audio.currentTime = c.t;
  loadTrack(c.from, c.t || 0, true);
}
// 播放条上现在亮哪个按钮（SV.chips 下标，-1 = 没有）：整段录音按播到的秒数算
function curChip() {
  const i = SV.trackIdx, now = SV.audio.currentTime + .3;
  let hit = -1;
  SV.chips.forEach((c, k) => { if (i >= c.from && i <= c.to && (c.t == null || c.t <= now)) hit = k; });
  return hit;
}

// 录音跳到某道题的开头（没有 cue 的从那段录音开头放；好几个大题共用的一整段不知道从哪开始，不动）；正在放的就是这题也不动
function seekItem(it) {
  if (!SV.audio) return;
  const i = trackPos(it.track);
  if (i < 0 || (it.cue == null && SV.tracks[i].shared)) return;
  const pk = SV.test.byKey[SV.playKey];
  if (pk && pk.qid === it.qid && !SV.audio.paused) return;
  SV.playKey = null;
  loadTrack(i, it.cue || 0, true);
}

// 现在放到哪题：这段录音里 cue ≤ 当前时间的最后一题（还在说明 / 例题就是 null）
function playingKey() {
  const tr = SV.tracks[SV.trackIdx];
  if (!tr) return null;
  const t = SV.audio.currentTime + .3;
  let hit = null, best = -1;
  for (const k of SV.keys) {
    const it = SV.test.byKey[k];
    if (it.part === 'L' && it.track === tr.i && it.cue != null && it.cue <= t && it.cue > best) { hit = k; best = it.cue; }
  }
  return hit;
}
function trackPlaying() {
  if (!SV?.audio) return;
  const k = playingKey();
  if (k !== SV.playKey) {
    SV.playKey = k;
    const q = k && SV.test.byKey[k].qid;           // 同一题的几个小问一起标
    for (const el of $$('.it.playing', $('#sheet-scroll'))) el.classList.remove('playing');
    if (q) for (const kk of SV.keys) if (SV.test.byKey[kk].qid === q) SV.itemEls[kk]?.classList.add('playing');
    const lab = $('#audio-q');
    if (lab) lab.textContent = playLabel(k);
  }
  // 录音放到了新的一题：卷子跟过去（点题号跳过来的那题已经在视野里，不会再动）。
  // 跟 playKey 分开记：一段录音从这题开头放（cue 0）时，换段那一下还没开始放，得等真放起来再跟
  if (k && k !== SV.followed && !SV.audio.paused) {
    SV.followed = k;
    if (REC.prefs.follow && (SV.tab === SV.test.partDoc.L || SV.tab === 'script')) scrollToPos(posOf(SV.test.byKey[k]), { mark: false });
  }
}

function paintAudio(timeOnly = false) {
  const box = $('#audio-box');
  if (!box || !SV?.audio) return;
  const au = SV.audio;
  const cur = isFinite(au.currentTime) ? au.currentTime : 0;
  const dur = isFinite(au.duration) ? au.duration : 0;
  const sk = box.querySelector('.seek');
  if (timeOnly && sk && curChip() === SV.chipOn) {   // 只刷时间和进度条，不重画整块（整段录音放进下一个大题了就整块重画）
    box.querySelector('.audio-time').textContent = `${fmtTime(cur)} / ${fmtTime(dur)}`;
    if (!SV.seeking) { sk.max = dur || 0; sk.value = cur; }
    return;
  }
  const rate = au.playbackRate;
  const on = SV.chipOn = curChip();
  // 大题不多就一排按钮；多了（TOPIK II 二十来个）换成下拉框，不然占好几行
  const pick = SV.chips.length > 8
    ? `<select class="track-sel" data-act="track-sel">${SV.chips.map((c, k) => `<option value="${k}" ${k === on ? 'selected' : ''}>${esc(c.label)}${c.title ? ' · ' + esc(c.title) : ''}</option>`).join('')}</select>`
    : `<div class="tracks">${SV.chips.map((c, k) => `<button class="${k === on ? 'on' : ''}" data-act="track" data-i="${k}" title="${esc(c.title)}">${tl(c.label)}</button>`).join('')}</div>`;
  box.innerHTML = `<div class="row">${pick}</div>
    <div class="row"><button class="play" data-act="play" title="播放/暂停（空格）">${au.paused ? '▶' : '❚❚'}</button>
      <input class="seek" type="range" min="0" step="0.1" max="${dur}" value="${cur}" data-act="seek">
      <span class="audio-time num"></span></div>
    <div class="row"><button class="btn sm" data-act="skip" data-d="-5" title="←">−5 秒</button><button class="btn sm" data-act="skip" data-d="5" title="→">+5 秒</button>
      <span class="audio-now" id="audio-q">${playLabel(SV.playKey)}</span>
      <span class="speed">${[0.75, 0.9, 1, 1.25].map(r => `<button class="${r === rate ? 'on' : ''}" data-act="rate" data-r="${r}">${r}×</button>`).join('')}</span></div>
    ${SV.audioEnded ? `<div class="audio-note">录音全部放完了。${SV.review ? '' : '检查一下，做完点右上角「交卷」。'}</div>` : ''}`;
  paintAudio(true);
}

// ---------------------------------------------------------------- 中场休息
function renderBreak() {
  const S = ACTIVE, t = TESTS[S.testId];
  const prev = S.booklets[S.bi - 1], next = S.booklets[S.bi];
  const ans = prev.keys.filter(k => filled(S.answers[k])).length;
  const rest = lvOf(t.level).booklets.find(b => b.name === next.name)?.rest;
  $('#app').innerHTML = `
  <div class="card break">
    <div class="check">✓</div>
    <h2>${tl(prev.name)} 交卷了</h2>
    <p>用时 ${fmtTime(S.used[S.bi - 1] || 0)} · 答了 ${ans}/${prev.keys.length} 题</p>
    <div class="next"><span class="muted">下一部分（第 ${S.bi + 1}/${S.booklets.length} 部分）</span><b>${tl(next.name)}</b>
      ${isListenBk(next) ? `录音约 ${next.limit / 60} 分钟，可以暂停、拖动、回放，做完自己交卷` : `${next.limit / 60} 分钟`}
      ${rest ? `<br><span class="muted">真考试这之前休息 ${rest} 分钟</span>` : ''}</div>
    <div class="acts"><button class="btn" data-act="home">先休息，回首页</button><button class="btn primary" data-act="next-booklet">开始下一部分</button></div>
    <p class="muted" style="margin-top:14px;font-size:12px">${esc(lvOf(t.level).name)} ${tl(t.title)} · 进度已保存，关掉程序下次也能接着做</p>
  </div>`;
}

// ---------------------------------------------------------------- 成绩
// 左边总分（或正确率）+ 右边各科；自评分一改就重画这一块
function heroHTML(t, a) {
  const g = grade(t, a.keys, a.answers, a.wself);
  let hero;
  if (g.total != null) {
    hero = `<div class="score-total${g.pass ? '' : ' fail'}"><small>${g.totalName || '总分'}</small><div class="v">${g.total}<span> / ${g.max}</span></div>
      <div class="verdict">${g.verdict}</div></div>`;
  } else if (g.n) {
    hero = `<div class="score-total raw"><small>正确率</small><div class="v">${pct(g.ok, g.n)}<span>%</span></div>
      <div class="verdict">${g.open ? '选择题' : ''}答对 ${g.ok} / ${g.n}${g.full ? '，主观题自评后出总分' : ''}</div></div>`;
  } else {
    const w = g.areas[0];
    hero = `<div class="score-total raw"><small>${tl(w.name)}</small><div class="v">${w.score ?? '—'}<span> / ${w.max}</span></div>
      <div class="verdict">${w.pending ? '对照模范答案给自己打分' : '自评分'}</div></div>`;
  }
  const areas = g.areas.map(ar => {
    const w = ar.score != null ? pct(ar.score, ar.max) : pct(ar.ok, ar.n);
    const low = ar.score != null && ar.min != null && ar.score < ar.min;
    const val = ar.score != null ? `${ar.score}<span class="muted" style="font-size:12px;font-weight:400"> / ${ar.max}</span>` : ar.open ? '—' : w + '%';
    return `<div><div class="area-h"><span class="n">${tl(ar.name)}${ar.zh ? ` <span class="muted">${esc(ar.zh)}</span>` : ''}</span>
        <span class="muted">${ar.open ? (ar.pending ? '待自评' : '自评') : `答对 ${ar.ok}/${ar.n}`}</span><b>${val}</b></div>
      <div class="meter"><i class="${low ? 'low' : ''}" style="width:${w}%"></i>${ar.score != null && ar.min != null ? `<u style="left:${ar.min / ar.max * 100}%" title="基准点 ${ar.min}"></u>` : ''}</div></div>`;
  }).join('');
  return `${hero}<div class="areas">${areas}</div>`;
}

function renderResult(a) {
  const t = TESTS[a.testId];
  if (!t) return go('home');
  const g = grade(t, a.keys, a.answers, a.wself);
  const wrong = a.keys.filter(k => t.byKey[k] && isMC(t.byKey[k]) && a.answers[k] !== t.byKey[k].ans).length;
  const opens = t.items.filter(i => !isMC(i) && a.keys.includes(i.key));
  const wcard = opens.length ? `<div class="card wcard"><h3>主观题自评 <span class="muted" style="font-weight:400;font-size:13px">对照正答表里的模范答案给自己打分，填完就算进总分</span>
      <button class="btn sm" data-act="review-open" data-id="${esc(a.id)}">看我的答案和模范答案</button></h3>
    <div class="wself-row">${opens.map(i => `<label>${tl(i.long)} <input type="number" min="0" max="${i.pts}" step="1" data-act="wself" data-id="${esc(a.id)}" data-key="${i.key}" value="${a.wself?.[i.key] ?? ''}" placeholder="—"> / ${i.pts}</label>`).join('')}</div></div>` : '';
  let rows = '', lastPart = null;
  for (const gr of g.groups) {
    if (gr.g.part !== lastPart) { rows += `<tr class="part"><td colspan="4">${tl(t.partName[gr.g.part])}</td></tr>`; lastPart = gr.g.part; }
    const w = pct(gr.ok, gr.n);
    rows += `<tr class="g" data-act="review-grp" data-id="${esc(a.id)}" data-grp="${gr.g.key}"><td>${tl(gr.g.label)}</td><td>${tn(gr.g.name)}</td>
      <td class="r">${gr.ok}/${gr.n}</td><td class="pct"><div class="meter"><i class="${w < 60 ? 'low' : ''}" style="width:${w}%"></i></div></td></tr>`;
  }
  const again = a.mode === 'redo' ? '' : `<button class="btn" data-act="again" data-id="${esc(a.id)}">再做一遍</button>`;
  $('#app').innerHTML = `
  <div class="page">
    <div class="page-top"><button class="btn ghost" data-act="home">‹ 首页</button>
      <h2>${esc(lvOf(t.level).name)} ${tl(t.title)} · ${esc(modeName(a))}${a.part ? ' · ' + tl(t.partName[a.part]) : ''}</h2>
      <span class="muted">${fmtDate(a.finishedAt)} · 用时 ${fmtTime(a.seconds)}</span></div>
    <div class="card score-hero" id="hero">${heroHTML(t, a)}</div>
    <div class="note">${g.note || ''}</div>
    ${wcard}
    <div class="result-acts">
      <button class="btn primary" data-act="review" data-id="${esc(a.id)}">对照卷子订正${wrong ? `（错 ${wrong} 题）` : ''}</button>
      ${again}
      ${wrong ? '<button class="btn" data-act="mistakes">去错题本</button>' : ''}
    </div>
    ${rows ? `<div class="card sec-card"><table class="groups"><thead><tr><th>大题</th><th>题型</th><th class="r" style="text-align:right">答对</th><th>正确率</th></tr></thead><tbody>${rows}</tbody></table></div>` : ''}
  </div>`;
}

// 订正：gk = 直接翻到这一大题；tab = 卷子那边先显示哪份（正答表会翻到这一科的模范答案）
function openReview(a, gk, tab) {
  const S = { testId: a.testId, mode: a.mode, booklets: [{ name: '订正', parts: [], keys: a.keys, limit: 0 }], bi: 0, answers: a.answers, flags: a.flags || {}, revealed: {} };
  openSession(S, a);
  SV.backTo = a;
  if (gk) {
    const first = a.keys.find(k => TESTS[a.testId].byKey[k]?.grp.key === gk);
    if (first) { setCur(first, false); scrollSheetTo(SV.itemEls[first]?.closest('.grp'), true); }
  }
  if (tab) {
    showTab(tab);
    const p = tab === 'answer' && SV.test.answerPos?.[SV.test.grpByKey[gk]?.part];
    if (p) scrollToPos(p, { force: true, mark: false });
  }
}

// ---------------------------------------------------------------- 错题本
function renderMistakes() {
  const level = REC.prefs.level;
  const mk = mistakeMap(level);
  const body = mk.map(x => {
    const t = x.test;
    const byPart = {};
    for (const k of x.keys) { const p = t.byKey[k].part; byPart[p] = (byPart[p] || 0) + 1; }
    const rows = x.keys.map(k => {
      const it = t.byKey[k], e = x.info[k];
      return `<div class="mk-row"><span class="badge">${tl(t.partName[it.part])}</span>
        <span class="grow">${tl(it.long)} <span class="t">${tn(it.grp.name)}</span></span>
        <span class="mk-ans">你选 <span class="your">${e.lastAns || '没答'}</span> · 正确 <span class="right spoil" data-act="spoil" data-a="${it.ans}" title="点一下看答案">看答案</span></span>
        <span class="muted" style="font-size:12px">错 ${e.wrong} 次</span>
        <button class="btn sm ghost" data-act="master" data-t="${esc(t.id)}" data-k="${k}" title="已经懂了，移出错题本">移出</button></div>`;
    }).join('');
    return `<div class="card mk-test">
      <div class="mk-head"><h3>${tl(t.title)} <span class="muted" style="font-weight:400;font-size:13px">${esc(t.sub)}</span></h3>
        <button class="btn primary" data-act="redo" data-t="${esc(t.id)}">重做这 ${x.keys.length} 题</button></div>
      <div class="mk-parts">${t.parts.filter(p => byPart[p]).map(p => `<span class="badge warn">${tl(t.partName[p])} ${byPart[p]}</span>`).join('')}</div>
      <div class="mk-list">${rows}</div></div>`;
  }).join('');
  $('#app').innerHTML = `
  <div class="page">
    <div class="page-top"><button class="btn ghost" data-act="home">‹ 首页</button><h2>错题本 · ${esc(lvOf(level).name)}</h2></div>
    <div class="note">每道${qWord()}看最近一次的结果：错了或没答就留在这里，下次做对了自动移出。重做时右边只出这些题，点题号左边卷子会滚过去。正确答案先遮着，重做前别看。</div>
    ${body || '<div class="card mk-test empty">这一级没有错题。</div>'}
  </div>`;
}

// ---------------------------------------------------------------- 全部记录
function renderHistory() {
  const level = REC.prefs.level;
  const list = REC.attempts.filter(a => TESTS[a.testId]?.level === level).sort((a, b) => b.finishedAt - a.finishedAt);
  const rows = list.map(a => {
    const t = TESTS[a.testId], g = grade(t, a.keys, a.answers, a.wself);
    const what = a.mode === 'exam' ? '整套模考' : a.mode === 'redo' ? '错题重做' : '练习 · ' + t.partName[a.part];
    const sc = g.total != null ? `<span class="badge ${g.pass ? 'ok' : 'ng'}">${g.total} / ${g.max} · ${tl(g.label)}</span>`
      : g.n ? `${g.ok}/${g.n}（${pct(g.ok, g.n)}%）` : '<span class="badge warn">待自评</span>';
    return `<tr class="g" data-act="open-attempt" data-id="${esc(a.id)}"><td>${fmtDate(a.finishedAt)}</td><td>${tl(t.title)} <span class="muted">${esc(t.sub)}</span></td>
      <td>${tl(what)}</td><td class="r">${fmtTime(a.seconds)}</td><td class="r">${sc}</td>
      <td class="r"><button class="btn sm ghost danger" data-act="del-attempt" data-id="${esc(a.id)}">删除</button></td></tr>`;
  }).join('');
  $('#app').innerHTML = `
  <div class="page">
    <div class="page-top"><button class="btn ghost" data-act="home">‹ 首页</button><h2>做题记录 · ${esc(lvOf(level).name)}</h2></div>
    <div class="card sec-card">${rows ? `<table class="groups"><thead><tr><th>时间</th><th>试卷</th><th>内容</th><th class="r" style="text-align:right">用时</th><th style="text-align:right">成绩</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="empty" style="padding:14px 0">还没有记录。</div>'}</div>
  </div>`;
}

// ---------------------------------------------------------------- 事件（exam.js 自己的按钮由它自己监听）
document.addEventListener('click', async e => {
  if (SV && view === 'session') {
    const tr = e.target.closest('.viewer .tr');           // 译文卡：选中那题，录音跳过去
    if (tr) { const k = tr.dataset.key; if (k && SV.keys.includes(k)) { setCur(k, true, false); seekItem(SV.test.byKey[k]); } return; }
    const pg = e.target.closest('.viewer .pg');           // 点卷子：选中那里的题（不动录音，免得往后看题时把录音带跑）
    if (pg) { pickFromPaper(pg, e); return; }
  }
  const el = e.target.closest('[data-act]');
  if (!el || el.closest('#modal')) return;
  const d = el.dataset;
  const att = () => REC.attempts.find(x => x.id === d.id);
  switch (d.act) {
    case 'level': REC.prefs.level = d.l; saveRec(); renderHome(); break;
    case 'exam': startSession(d.t, 'exam'); break;
    case 'practice': startSession(d.t, 'practice', { part: d.p }); break;
    case 'resume':
      if (ACTIVE.phase === 'break') go('brk'); else openSession(ACTIVE);
      break;
    case 'drop-active':
      if (await confirmBox('放弃这一场？', '已经答的不会记成绩，也不会进错题本。', '放弃', '留着')) { ACTIVE = null; saveActive(true); renderHome(); }
      break;
    case 'next-booklet': ACTIVE.phase = 'doing'; saveActive(); openSession(ACTIVE); break;
    case 'home': go('home'); break;
    case 'mistakes': go('mistakes'); break;
    case 'history': go('history'); break;
    case 'open-attempt': { const a = att(); if (a) go('result', a); break; }
    case 'del-attempt': {
      e.stopPropagation();
      if (await confirmBox('删除这条记录？', '删了就没了，错题本也会跟着变。', '删除', '取消')) {
        REC.attempts = REC.attempts.filter(x => x.id !== d.id); saveRec(); renderHistory();
      }
      break;
    }
    case 'review': case 'review-grp': { const a = att(); if (a) openReview(a, d.grp); break; }
    case 'review-open': {
      const a = att(), t = a && TESTS[a.testId];
      const it = t?.items.find(i => !isMC(i) && a.keys.includes(i.key));
      if (it) openReview(a, it.grp.key, 'answer');
      break;
    }
    case 'again': { const a = att(); if (a) startSession(a.testId, a.mode, { part: a.part }); break; }
    case 'redo': { const x = mistakeMap(REC.prefs.level).find(m => m.test.id === d.t); if (x) startSession(d.t, 'redo', { keys: x.keys }); break; }
    case 'spoil': el.textContent = d.a; el.classList.remove('spoil'); break;
    case 'master': REC.mastered[d.t + '|' + d.k] = Date.now(); saveRec(); renderMistakes(); break;

    // ---- 做题界面 ----
    case 'exit':
      if (SV.review) { go('result', SV.backTo); break; }
      if (await confirmBox('先退出？', '进度和剩余时间都会保存，回首页点「继续」接着做。', '退出', '接着做')) go('home');
      break;
    case 'tab': showTab(d.tab); if (SV.cur) scrollToPos(posOf(SV.test.byKey[SV.cur])); break;
    case 'zoom': setZoom(+d.z); break;
    case 'cur': jumpTo(el.closest('[data-key]').dataset.key); break;
    case 'grp-go': jumpToGrp(d.grp); break;
    case 'ans': { const k = el.closest('.it').dataset.key; setCur(k, false, false); answer(k, +d.n); break; }   // 点选项不动卷子和录音，只有点题号才跳
    case 'flag': toggleFlag(el.closest('[data-key]').dataset.key); break;
    case 'reveal': reveal(d.grp); break;
    case 'pause': togglePause(); break;
    case 'submit': submitBooklet(); break;
    case 'track': playChip(SV.chips[+d.i]); break;
    case 'play': togglePlay(); break;
    case 'skip': skip(+d.d); break;
    case 'rate': SV.audio.defaultPlaybackRate = SV.audio.playbackRate = +d.r; paintAudio(); break;   // default 那个换段后还生效
  }
});

document.addEventListener('input', e => {
  const t = e.target;
  const act = t.dataset?.act;
  if (act === 'wself') {                        // 自评分：订正页的答题卡上、成绩页的自评卡上都能填
    const a = SV?.review ? SV.attempt : REC.attempts.find(x => x.id === t.dataset.id);
    if (a) setWself(a, t.dataset.key, t.value);
    if (a && view === 'result') $('#hero').innerHTML = heroHTML(TESTS[a.testId], a);   // 只换分数那块，别整页重画（焦点会丢）
    return;
  }
  if (!SV) return;
  if (t.dataset?.w && !SV.review) { onOpenInput(t); return; }
  if (act === 'seek') { SV.seeking = true; SV.audio.currentTime = +t.value; }
  if (act === 'only-wrong') $('#sheet-scroll').classList.toggle('only-wrong', t.checked);
  if (act === 'follow') { REC.prefs.follow = t.checked; saveRec(); }
  if (act === 'trans') {
    REC.prefs.trans = t.checked; saveRec();
    const v = SV.frames.script;
    if (v) {                                    // 译文收起/展开会让下面的内容上下挪，保住当前题在视野里的位置
      v.classList.toggle('no-tr', !t.checked);
      const it = SV.test.byKey[SV.cur];
      if (it?.part === 'L') scrollToPos(posOf(it), { force: true });
    }
  }
});
document.addEventListener('change', e => {
  const act = e.target.dataset?.act;
  if (!SV) return;
  if (act === 'seek') SV.seeking = false;
  if (act === 'track-sel') { playChip(SV.chips[+e.target.value]); e.target.blur(); }   // 失焦：不然空格 / 方向键会去动下拉框
});
document.addEventListener('focusin', e => {       // 点进主观题的输入框 = 选中这题
  const box = e.target.closest?.('.wit');
  if (box && SV && SV.cur !== box.dataset.key) setCur(box.dataset.key, false);
});

document.addEventListener('keydown', e => {
  if (view !== 'session' || !SV || !$('#modal').hidden) return;
  const tg = e.target instanceof Element ? e.target : null;
  if (tg?.closest('input, textarea, select') && tg.type !== 'checkbox' && tg.type !== 'range') return;
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  const k = e.key;
  if (!SV.review && !SV.paused && /^[1-4]$/.test(k)) {
    const it = SV.test.byKey[SV.cur];
    if (!it || !isMC(it) || +k > it.nOpt || shown(it)) return;
    answer(SV.cur, +k, false);
    move(1);
    e.preventDefault();
  } else if ((k === '0' || k === 'Backspace' || k === 'Delete') && !SV.review) { answer(SV.cur, 0); e.preventDefault(); }
  else if (k === 'ArrowDown' || k === 'j') { move(1); e.preventDefault(); }
  else if (k === 'ArrowUp' || k === 'k') { move(-1); e.preventDefault(); }
  else if (k === 'f' || k === 'F') toggleFlag(SV.cur);
  else if (k === ' ' && SV.audio && !SV.paused) { togglePlay(); e.preventDefault(); }
  else if ((k === 'ArrowLeft' || k === 'ArrowRight') && SV.audio && !SV.paused) { skip(k === 'ArrowLeft' ? -5 : 5); e.preventDefault(); }
});

// ---------------------------------------------------------------- 启动（exam.js 跑完之后）
document.addEventListener('DOMContentLoaded', async () => {
  document.title = EXAM.name;                     // index.html 两边共用，标题在这儿设（lib\exam.ps1 靠它找窗口）
  REC = { attempts: [], prefs: { level: EXAM.defaultLevel, zoom: 1, follow: true, trans: true }, mastered: {} };
  const loading = EXAM.load();
  try {
    const [rec, act] = await Promise.all([api('/api/records'), api('/api/active')]);
    if (rec) REC = { ...REC, ...rec, prefs: { ...REC.prefs, ...(rec.prefs || {}) }, mastered: rec.mastered || {} };
    ACTIVE = act || null;
  } catch (e) {
    toast('读不了做题记录：' + e.message, 6000);
  }
  await loading;
  if (!EXAM.levels[REC.prefs.level]) REC.prefs.level = EXAM.defaultLevel;
  if (ACTIVE && !TESTS[ACTIVE.testId]) ACTIVE = null;
  go('home');
});
