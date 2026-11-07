'use strict';

/* 分类默认 7 个；登录/预览拿到服务端下发的分类后会被 setCats 替换，
   之后新增的分类自动出现在筛选 chip、下拉框、卡片角标和首页分组里 */
let CATS = {
  fav:     { label: '收藏', icon: '★', cls: 't-fav' },
  checkin: { label: '每日签到', icon: '📅', cls: 't-checkin' },
  relay:   { label: '中转站/API', icon: '🔀', cls: 't-relay' },
  vps:     { label: 'VPS/服务器', icon: '🖥️', cls: 't-vps' },
  game:    { label: '游戏', icon: '🎮', cls: 't-game' },
  domain:  { label: '域名/订阅', icon: '🌐', cls: 't-domain' },
  idle:    { label: '已闲置', icon: '🧟', cls: 't-idle' }
};
function setCats(list) {
  if (!Array.isArray(list) || !list.length) return;
  const next = {};
  for (const c of list) next[c.id] = { label: c.label, icon: c.icon || '🏷️', cls: c.cls || 't-custom' };
  CATS = next;
}

const YI = ['签到领奖励', '整理一遍台账', '检查 VPS 状态', '白嫖积分', '续费该续的', '注册个新的试试', '早点睡', '给账号改个强密码'];
const JI = ['忘签到', '熬夜', '乱点链接', '乱花钱', '拖延症', '忘记续费'];
const QUOTES = [
  '坚持签到的人，运气都不会太差。',
  '你签的不是到，是白嫖的尊严。',
  '资产不怕多，就怕忘了它。',
  '今天的签到，是明天的底气。',
  '每一台 VPS 都值得被记住。',
  '稳定的续费，源于记录的坚持。',
  '台账记得越全，钱包越稳。',
  '签到一时爽，一直签一直爽。',
  '白嫖的最高境界：一个都不漏。',
  '机器在替你打工，你要替机器记账。',
  '别让任何一个账号，变成失联的旧爱。',
  '每天一分钟，资产不失控。'
];

let mode = 'preview', me = null, services = [], meta = null, filter = 'all', q = '', editingId = null, tagFilter = null;
/* 星标和分类是两回事，互不干涉：收藏栏只看星标，分类只决定它分在哪个组里。
   选“收藏”分类保存时，服务器会在“新进收藏分类”那一刻顺带点上星，所以它会进收藏栏；
   之后取消星标，只会让它离开收藏栏，分类保持不动。 */
const isFav = (s) => !!(s && s.favorite);
let gridFirstRender = true;
/* 重型特效只在桌面细指针设备上开：触屏/小屏上粒子+光球是最大卡顿源 */
/* 注意：reduceMotion 在文件后面才声明，这里不能提前引用它，否则整段脚本会在加载时直接报错、登录按钮和渲染全失效（2026-10-29 实测教训） */
const heavyFx = matchMedia('(pointer: fine)').matches && innerWidth > 780;
const live = () => mode === 'live';

const $ = (sel) => document.querySelector(sel);
const RING_C = 2 * Math.PI * 52;

/* ---------- 工具 ---------- */
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
/* v51：到期日自动填 = 开始时间 + 续期周期；365 天按加一年（2 月 29 日 → 2 月 28 日），与服务端续期口径一致 */
function addDaysStr(ymd, days) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || '');
  if (!m || !Number.isFinite(days) || days < 1) return '';
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  if (days === 365) {
    const t = new Date(d.getFullYear() + 1, d.getMonth(), d.getDate());
    if (t.getMonth() !== d.getMonth()) t.setDate(0); // 2 月 29 日 → 2 月 28 日
    return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
  }
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
let expiryDirty = false; // 本次弹窗里手动改过到期日，就不再自动填
function autoFillExpires() {
  if (expiryDirty) return;
  const v = addDaysStr($('#f-registered').value, parseInt($('#f-renew-days').value, 10));
  if (v) $('#f-expires').value = v;
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
/* 网站真实图标：Google favicon 服务按域名取，加载失败自动隐藏、回落到分类 emoji */
function favIcon(s) {
  if (!s.url) return '';
  let host = '';
  try { host = new URL(s.url).hostname; } catch { return ''; }
  if (!host) return '';
  return `<img class="site-fav" src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64" alt="" loading="lazy" onerror="this.remove()">`;
}
function daysUntil(dateStr) {
  if (!dateStr) return null;
  const [y, m, d] = dateStr.split('-').map(Number);
  const now = new Date();
  const target = new Date(y, m - 1, d);
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target - base) / 86400e3);
}
/* 签到间隔（天）：默认 1 天；老数据没这个字段也按 1 天算 */
function everyDays(s) {
  const n = parseInt(s.checkinEveryDays, 10);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 365) : 1;
}
/* 续期周期（天）：默认 365 天；老数据没这个字段也按 365 天算 */
function renewDaysOf(s) {
  const n = parseInt(s.renewDays, 10);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 3650) : 365;
}
/* 临期按钮文案：365 天显示“续一年”，其他显示“续 N 天” */
function renewLabel(s) {
  const d = renewDaysOf(s);
  return d === 365 ? '续一年' : `续${d}天`;
}
/* 两个日期相差天数（b - a），按 UTC 日期算 */
function dayDiff(a, b) {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400e3);
}
/* 今天该不该签：没签过就是到期；上次签到距今满间隔天数才到期 */
function dueToday(s, t) {
  if (s.checkinFrequency !== 'daily' || s.category === 'idle') return false;
  const c = (s.checkins || []).filter(Boolean).sort();
  if (!c.length) return true;
  return dayDiff(c[c.length - 1], t) >= everyDays(s);
}
/* 今日签到 cohort：今天到期 + 今天已签；不到期的服务不计入今日；
   v57：今天已签 = 全部账号都签了今天（serviceDoneToday） */
function todayCohort(s, t) {
  return dueToday(s, t) || serviceDoneToday(s, t);
}
/* v57：账号级签到口径（和服务端一致） */
function serviceAccounts(s) { return Array.isArray(s?.accounts) ? s.accounts : []; }
function accCheckins(a) { return Array.isArray(a?.checkins) ? a.checkins : []; }
function serviceDoneToday(s, t) {
  const accs = serviceAccounts(s);
  if (!accs.length) return (s.checkins || []).includes(t);
  return accs.every((a) => accCheckins(a).includes(t));
}
function serviceProgress(s, t) {
  const accs = serviceAccounts(s);
  if (!accs.length) return { done: (s.checkins || []).includes(t) ? 1 : 0, total: 1 };
  return { done: accs.filter((a) => accCheckins(a).includes(t)).length, total: accs.length };
}
/* v59：网站在线率——取最近 N 天内的探活记录里“通”的占比；记录不够就不显示 */
function uptimeRate(s, days) {
  const hist = (Array.isArray(s?.linkHistory) ? s.linkHistory : []).filter((h) => h && typeof h.t === 'number' && typeof h.ok === 'boolean');
  if (!hist.length) return null;
  const cutoff = Date.now() - days * 86400e3;
  const recent = hist.filter((h) => h.t >= cutoff);
  if (!recent.length) return null;
  return Math.round((recent.filter((h) => h.ok).length / recent.length) * 100);
}
/* v60：服务健康分（0–100）——在线率 40 + 到期远近 30 + 签到 20 + 死链 10；
   哪项没数据就不算（权重重新归一），一项都没有就不显示 */
function healthScore(s) {
  const t = todayStr();
  const parts = [];
  const up = uptimeRate(s, 7);
  if (up !== null) parts.push([up, 40]);
  if (s?.expiresAt) {
    const d = daysUntil(s.expiresAt);
    if (d !== null) parts.push([d < 0 ? 0 : (d >= 30 ? 100 : Math.round((d / 30) * 100)), 30]);
  }
  if (s?.checkinFrequency === 'daily' && s?.category !== 'idle') {
    parts.push([(dueToday(s, t) && !serviceDoneToday(s, t)) ? 0 : 100, 20]);
  }
  if (s?.linkStatus) parts.push([s.linkStatus === 'dead' ? 0 : 100, 10]);
  if (!parts.length) return null;
  const total = parts.reduce((n, [, w]) => n + w, 0);
  return Math.round(parts.reduce((n, [v, w]) => n + v * w, 0) / total);
}
function healthClass(score) {
  return score === null ? '' : (score >= 80 ? 'b-ok' : (score >= 50 ? 'b-warn' : 'b-bad'));
}
/* 下次签到（只给间隔 > 1 天的服务显示）：没签过就是今天；否则上次签到 + 间隔天数；算出来已过期的也算今天 */
function nextCheckinLabel(s, t) {
  if (s.checkinFrequency !== 'daily' || s.category === 'idle' || everyDays(s) <= 1) return '';
  const c = (s.checkins || []).filter(Boolean).sort();
  if (!c.length) return '今天';
  const next = addDaysStr(c[c.length - 1], everyDays(s));
  if (!next || next <= t) return '今天';
  return next.slice(5); // MM-DD
}
function streak(dates) {
  const set = new Set(dates || []);
  if (!set.size) return 0;
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  let d = new Date();
  if (!set.has(fmt(d))) d.setDate(d.getDate() - 1);
  let n = 0;
  while (set.has(fmt(d))) { n++; d.setDate(d.getDate() - 1); }
  return n;
}
function maxRun(dates) {
  const s = [...new Set(dates || [])].sort();
  let best = 0, run = 0, prev = null;
  for (const d of s) {
    const [y, m, dd] = d.split('-').map(Number);
    if (prev) {
      const pd = new Date(prev[0], prev[1] - 1, prev[2] + 1);
      const same = pd.getFullYear() === y && pd.getMonth() === m - 1 && pd.getDate() === dd;
      run = same ? run + 1 : 1;
    } else run = 1;
    prev = [y, m, dd];
    if (run > best) best = run;
  }
  return best;
}
function hashDay(s) {
  let h = 0;
  for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}
let toastTimer;
function toast(msg, type = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'show' + (type ? ' ' + type : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, 2400);
}
/* 点星微动画：从点击处迸出几颗小星星（挂在 body 上，列表重绘也冲不掉） */
function starBurst(x, y, on) {
  if (reduceMotion) return;
  const chars = on ? ['★', '★', '✦'] : ['☆', '☆'];
  const n = on ? 7 : 4;
  for (let i = 0; i < n; i++) {
    const s = document.createElement('span');
    s.className = 'star-burst';
    s.textContent = chars[i % chars.length];
    s.style.left = `${x}px`;
    s.style.top = `${y}px`;
    s.style.color = on ? '#fbbf24' : '#94a3b8';
    const ang = (Math.PI * 2 * i) / n + Math.random() * .5;
    const dist = 26 + Math.random() * 30;
    s.style.setProperty('--dx', `${Math.cos(ang) * dist}px`);
    s.style.setProperty('--dy', `${Math.sin(ang) * dist - 14}px`);
    s.style.setProperty('--rr', `${Math.floor(Math.random() * 120 - 60)}deg`);
    document.body.appendChild(s);
    setTimeout(() => s.remove(), 750);
  }
}
function confetti(n = 70) {
  const colors = ['#5b8cff', '#22d3ee', '#34d399', '#fbbf24', '#f87171', '#c084fc', '#ffd479'];
  for (let i = 0; i < n; i++) {
    const d = document.createElement('div');
    d.className = 'confetti';
    d.style.left = Math.random() * 100 + 'vw';
    d.style.background = colors[Math.floor(Math.random() * colors.length)];
    d.style.animationDuration = (1.6 + Math.random() * 1.6) + 's';
    d.style.animationDelay = (Math.random() * 0.5) + 's';
    d.style.transform = `rotate(${Math.random() * 360}deg)`;
    document.body.appendChild(d);
    setTimeout(() => d.remove(), 3600);
  }
}
let captchaId = '';
let captchaSeq = 0;
async function loadCaptcha() {
  /* 防乱序：打开登录框时的一次请求和紧接着点的“换一张”可能同时在飞，
     只认最后一次请求的结果，旧请求晚到也不许把图换回去（否则看起来像换图没生效） */
  const seq = ++captchaSeq;
  try {
    const r = await api('/api/captcha');
    if (seq !== captchaSeq) return;
    captchaId = r.id;
    $('#l-captcha-img').innerHTML = r.svg;
  } catch { /* 验证码加载失败时登录会由服务端报错，不阻塞打开登录框 */ }
}
function openLogin() {
  $('#l-err').classList.add('hidden');
  $('#login-overlay').classList.remove('hidden');
  /* v60：开了二次验证的，登录框里直接露出动态码输入框 */
  $('#l-totp-row').style.display = meta?.totpEnabled ? '' : 'none';
  loadCaptcha();
  $('#l-user').focus();
}
function handleAuthErr(err) {
  if (err.message === '请先登录') openLogin();
  else toast(err.message, 'bad');
}
async function api(url, opts = {}) {
  const res = await fetch(url, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts));
  if (res.status === 401) throw new Error('请先登录');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败(${res.status})`);
  return data;
}

/* ---------- 数据 ---------- */
async function loadAll() {
  [services, meta] = await Promise.all([api('/api/services'), api('/api/meta')]);
  me = { username: meta.username };
  mode = 'live';
  setCats(meta.categories);
  renderAll();
  loadNotify();
  loadNotes();
  if (dupesScanned) scanDupes(); // 删/改后数据变了，重复列表跟着刷新
  renderCats(); // 分类列表每次登录后都渲染，别再用“先触发后渲染”那套
}
async function loadPreview() {
  const pub = await fetch('/api/public').then((r) => { if (!r.ok) throw new Error('fail'); return r.json(); });
  services = pub.services;
  meta = pub;
  me = { username: pub.username };
  mode = 'preview';
  setCats(pub.categories);
  renderAll();
}

/* ---------- 渲染 ---------- */
function renderAll() {
  /* 按用户拖拽顺序排列（无顺序数据时保持现状） */
  services.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  document.body.classList.toggle('mode-live', live());
  document.body.classList.toggle('mode-preview', !live());

  const d = new Date();
  const t = todayStr();
  /* v53：计数只算可计的（标记异常的不算全勤、不催），面板列表仍包含异常红显
     v57：进度按账号算——多账号的站，一个账号算一个单位；没账号的站算 1 个单位 */
  const daily = services.filter((s) => todayCohort(s, t) && !s.abnormal);
  const units = daily.map((s) => serviceProgress(s, t));
  const totalUnits = units.reduce((n, p) => n + p.total, 0);
  const done = units.reduce((n, p) => n + p.done, 0);
  const soon = services.filter((s) => s.expiresAt && daysUntil(s.expiresAt) <= 7).length;
  const best = Math.max(0, ...services.map((s) => maxRun(s.checkins)));
  const total = services.reduce((n, s) => n + (s.checkins || []).length, 0);
  const lv = meta.level;
  const h = d.getHours();
  const hello = h < 6 ? '夜深了' : h < 9 ? '早上好' : h < 12 ? '上午好' : h < 14 ? '中午好' : h < 18 ? '下午好' : h < 23 ? '晚上好' : '夜深了';

  // 全勤 pill
  const allDays = Object.keys(meta.history || {}).filter((k) => meta.history[k] && meta.history[k].all);
  const allStreak = streak(allDays);
  $('#streak-pill-text').textContent = allStreak >= 2 ? `已连续全勤 ${allStreak} 天` : `今日 ${done}/${totalUnits} 已签`;

  // 大标题下的副标题
  $('#sub-line').textContent = live()
    ? `${me.username}，${hello}！${totalUnits && done < totalUnits ? `还有 ${totalUnits - done} 个待签 · ` : ''}已收录 ${services.length} 个服务，累计签到 ${total} 次。`
    : `中转站、VPS、游戏机、订阅全记在这，签到额度一个不漏。已收录 ${services.length} 个服务 · 累计签到 ${total} 次，登录后可签到和编辑。`;

  // 运势
  const hs = hashDay(t);
  const stars = 2 + (hs % 4);
  const yi1 = YI[hs % YI.length];
  const yi2 = YI[(hs >> 3) % YI.length];
  const ji = JI[(hs >> 6) % JI.length];
  $('#fortune-pill').textContent = '🔮 今日运势 ' + '⭐'.repeat(stars);
  $('#yi-line').textContent = `宜：${yi1}、${yi2}`;
  $('#ji-line').textContent = `忌：${ji}`;
  typewrite($('#quote-line'), `「${QUOTES[hs % QUOTES.length]}」`);

  // 进度环
  $('#ring-text').textContent = `${done}/${totalUnits}`;
  const pct = totalUnits ? done / totalUnits : 0;
  const fg = $('#ring-fg');
  fg.style.strokeDashoffset = RING_C * (1 - pct);
  fg.classList.toggle('full', totalUnits > 0 && done === totalUnits);

  // 等级徽章 & 侧栏用户卡
  $('#level-pill').textContent = `⚡ Lv.${lv.lv} ${lv.title}`;
  $('#level-pill').title = `热情值 ${lv.xp}` +
    (lv.nextXp ? ` / ${lv.nextXp}，还差 ${lv.nextXp - lv.xp} 点升级到「${lv.nextTitle}」` : '（已满级，传说就是你）');
  const av = $('#avatar');
  if (av) av.textContent = (me.username || '?').trim().slice(0, 1).toUpperCase();
  const xpb = $('#xp-bar-in');
  if (xpb) {
    xpb.style.width = `${lv.progress}%`;
    xpb.parentElement.title = lv.nextXp ? `热情值 ${lv.xp} / ${lv.nextXp}（${lv.progress}%）` : '已满级';
  }

  // 统计条（数字滚动）
  countUp($('#ss-streak'), best);
  countUp($('#ss-total'), total);
  countUp($('#ss-services'), services.length);
  countUp($('#ss-xp'), lv.xp);

  // 一键全签按钮
  const b = $('#btn-check-all');
  if (!totalUnits) { b.classList.add('hidden'); }
  else {
    b.classList.remove('hidden');
    if (done === totalUnits) { b.textContent = '今日已全签 ✓'; b.disabled = true; }
    else { b.textContent = '⚡ 一键全签'; b.disabled = false; }
  }

  $('#stats').textContent = `共 ${services.length} 个服务 · 今日已签 ${done}/${totalUnits} · 7天内到期 ${soon}`;
  $('#checkin-progress').textContent = totalUnits ? `今日已签 ${done}/${totalUnits}` : '';
  $('#checkin-bar').style.width = totalUnits ? `${(done / totalUnits) * 100}%` : '0';

  renderBanner();
  if (!live()) renderLanding();
  else { renderFav(); renderExpiring(); renderPwReuse(); renderYearReview(); refreshApiTokenStatus(); refreshTotpStatus(); refreshGithubStatus(); refreshSyncStatus(); }
  const sb = $('#sec-banner');
  if (live() && meta.passwordIsDefault) {
    sb.innerHTML = '🔒 当前还是初始默认密码，部署到服务器前务必点右上角「改密码」换掉！';
    sb.classList.remove('hidden');
  } else sb.classList.add('hidden');
  renderCheckin();
  renderHeatmap();
  renderAch();
  renderHealth();
  renderChips();
  renderGrid();
  drawTrend();
}
/* v60：健康分最低的 5 个服务（分数越低越需要处理），点名字跳到卡片 */
function renderHealth() {
  const box = $('#health-list');
  if (!box) return;
  const scored = services
    .map((s) => ({ s, score: healthScore(s) }))
    .filter((x) => x.score !== null)
    .sort((a, b) => a.score - b.score)
    .slice(0, 5);
  if (!scored.length) { box.innerHTML = '<div class="empty">还没有能算健康分的数据（等死链检测跑一轮就有在线率了）。</div>'; return; }
  box.innerHTML = scored.map(({ s, score }) => {
    const reasons = [];
    const up = uptimeRate(s, 7);
    if (up !== null && up < 90) reasons.push(`在线率 ${up}%`);
    const d = daysUntil(s.expiresAt);
    if (d !== null && d < 0) reasons.push(`已过期 ${-d} 天`);
    else if (d !== null && d <= 7) reasons.push(d === 0 ? '今天到期' : `${d} 天后到期`);
    if (s.checkinFrequency === 'daily' && s.category !== 'idle' && dueToday(s, todayStr()) && !serviceDoneToday(s, todayStr())) reasons.push('今天还没签');
    if (s.linkStatus === 'dead') reasons.push('疑似失效');
    return `<div class="landing-checkin-item"><span class="ck">💚</span><span class="ck-name">${esc(s.name)}</span><span class="ck-note">${reasons.length ? esc(reasons.join(' · ')) : '状态还行'}</span><span class="badge ${healthClass(score)}">${score} 分</span><button class="btn small ghost" data-act="edit" data-id="${s.id}">编辑</button></div>`;
  }).join('');
}

function renderBanner() {
  const soon = services
    .filter((s) => s.expiresAt)
    .map((s) => ({ s, d: daysUntil(s.expiresAt) }))
    .filter((x) => x.d <= 7)
    .sort((a, b) => a.d - b.d);
  const el = $('#expiry-banner');
  if (!soon.length) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.innerHTML = soon.map(({ s, d }) => {
    const cls = d < 0 ? 'bad' : '';
    const txt = d < 0 ? `已过期 ${-d} 天` : (d === 0 ? '今天到期' : `${d} 天后到期`);
    return `<span class="expiry-item ${cls}">⏰ <b>${esc(s.name)}</b> ${txt}（${esc(s.expiresAt)}）</span>`;
  }).join('');
}

function renderCheckin() {
  const t = todayStr();
  const list = services.filter((s) => todayCohort(s, t));
  /* v49：未签的上浮、已签的下沉，点完自动流动；同组内保持原顺序
     v53：标记异常的沉到底（不算待签，不占上面位置）
     v57：已签 = 全部账号都签完（serviceDoneToday），只签了一部分还算未签，留在上面 */
  list.sort((a, b) => ((a.abnormal ? 2 : serviceDoneToday(a, t) ? 1 : 0)) - ((b.abnormal ? 2 : serviceDoneToday(b, t) ? 1 : 0)));
  const box = $('#checkin-list');
  if (!list.length) {
    box.innerHTML = `<div class="empty">今天没有需要签到的服务。${live() ? '点右上角「➕ 添加服务」，把「签到频率」设为「每天」就会按周期出现在这里。' : '登录后添加，把「签到频率」设为「每天」即可。'}</div>`;
    return;
  }
  box.innerHTML = list.map((s) => {
    const ok = serviceDoneToday(s, t);
    const p = serviceProgress(s, t);
    const st = streak(s.checkins);
    const last = (s.checkins || []).length ? s.checkins[s.checkins.length - 1] : '从未签到';
    const right = live()
      ? (ok
        ? `<span class="signed-tag">✓ 今日已签</span><button class="btn ghost" data-act="uncheckin" data-id="${s.id}">↩ 撤回</button>`
        : `<button class="btn primary" data-act="checkin" data-id="${s.id}">签到 +5⚡</button>`)
      : `<button class="btn ghost" data-act="wantlogin">🔒 登录后签到</button>`;
    return `<div class="checkin-row${s.abnormal ? ' abnormal' : ''}">
      <div class="ci-info">
        <div class="ci-name">${esc(s.name)} ${s.abnormal ? '<span class="chip abn">⚠️ 异常</span>' : ''}${st ? `<span class="chip fire">🔥 连续${st}天</span>` : ''}${p.total > 1 ? `<span class="chip">${ok ? '✓ 全部账号已签' : `已签 ${p.done}/${p.total} · ${Math.round(p.done / p.total * 100)}%`}</span>` : ''}</div>
        <div class="ci-sub">${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.url)}</a>` : '未填网址'} · 上次：${esc(last)}</div>
      </div>
      ${right}
    </div>`;
  }).join('');
}

function renderHeatmap() {
  const el = $('#heatmap');
  const hist = meta.history || {};
  const today = new Date();
  const dow = (today.getDay() + 6) % 7;
  const start = new Date(today);
  start.setDate(start.getDate() - (dow + 77));
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  let html = '';
  for (let w = 0; w < 12; w++) {
    html += '<div class="hm-col">';
    for (let r = 0; r < 7; r++) {
      const d = new Date(start);
      d.setDate(start.getDate() + w * 7 + r);
      if (d > today) { html += '<div class="hm-cell hm-future"></div>'; continue; }
      const key = fmt(d);
      const c = (hist[key] && hist[key].c) || 0;
      const cls = c >= 4 ? 'hm-4' : (c >= 2 ? 'hm-2' : (c === 1 ? 'hm-1' : ''));
      html += `<div class="hm-cell ${cls}" title="${key} · 签到 ${c} 次"></div>`;
    }
    html += '</div>';
  }
  el.innerHTML = html;
}

function renderAch() {
  const list = meta.achievements || [];
  const un = list.filter((a) => a.unlockedAt).length;
  $('#ach-count').textContent = `${un}/${list.length} 已解锁 · 解锁各 +10⚡`;
  $('#ach-grid').innerHTML = list.map((a) => `<div class="ach ${a.unlockedAt ? '' : 'locked'}" title="${esc(a.unlockedAt ? '解锁于 ' + a.unlockedAt : '还没解锁：' + a.desc)}">
    <div class="a-ico">${a.unlockedAt ? a.icon : '🔒'}</div>
    <div class="a-name">${esc(a.name)}</div>
    <div class="a-desc">${esc(a.desc)}</div>
    ${a.unlockedAt ? `<div class="a-date">🎉 ${esc(a.unlockedAt)}</div>` : ''}
  </div>`).join('');
}

function renderChips() {
  const counts = {};
  services.forEach((s) => { counts[s.category] = (counts[s.category] || 0) + 1; });
  const mk = (key, label, count) =>
    `<button class="chip ${filter === key ? 'on' : ''}" data-cat="${key}">${label} <i>${count}</i></button>`;
  let html = mk('all', '全部', services.length);
  html += mk('fav', '★ 我的收藏', services.filter(isFav).length);
  /* “收藏”分类不单独再出一个筛选 chip：上面的“我的收藏”已经按统一口径（星标或收藏分类）汇总，避免两个同功能按钮 */
  for (const [k, v] of Object.entries(CATS)) if (k !== 'fav') html += mk(k, `${v.icon} ${v.label}`, counts[k] || 0);
  $('#chips').innerHTML = html;
  /* v60：标签栏——所有用过的标签，点一下只看带这个标签的服务，再点取消 */
  const tagCounts = {};
  services.forEach((s) => { (s.tags || []).forEach((t) => { tagCounts[t] = (tagCounts[t] || 0) + 1; }); });
  const tagRow = $('#tag-row');
  if (tagRow) {
    tagRow.innerHTML = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).map(([t, n]) =>
      `<button class="chip${tagFilter === t ? ' on' : ''}" data-tag="${esc(t)}">#${esc(t)} <i>${n}</i></button>`).join('');
  }
}

function cardBold(s) {
  if (s.notes) return s.notes.split(/\r?\n/)[0];
  if (s.checkinFrequency === 'daily') return everyDays(s) > 1 ? `每${everyDays(s)}天签到送奖励，坚持别断` : '每日签到送奖励，坚持别断';
  if (s.expiresAt) {
    const d = daysUntil(s.expiresAt);
    return `到期 ${s.expiresAt}${d !== null ? `（剩 ${d} 天）` : ''}`;
  }
  return '点击标题直达官网';
}

function cardHTML(s, idx) {
  const cat = CATS[s.category] || CATS.relay;
  const num = String(idx + 1).padStart(2, '0');
  const d = daysUntil(s.expiresAt);
  const st = streak(s.checkins);
  const checkedToday = live() && serviceDoneToday(s, todayStr());
  const prog = serviceProgress(s, todayStr());
  const partialBadge = (prog.total > 1 && prog.done > 0 && !checkedToday) ? `<span class="badge b-warn">已签 ${prog.done}/${prog.total}</span>` : '';
  let exp = '';
  if (d !== null) {
    let badge, cls;
    if (d < 0) { badge = `已过期${-d}天`; cls = 'b-bad'; }
    else if (d <= 7) { badge = d === 0 ? '今天到期' : `${d}天后到期`; cls = 'b-warn'; }
    else { badge = `剩${d}天`; cls = 'b-ok'; }
    exp = `<span class="badge ${cls}">⏰ ${badge}</span>`;
  }
  const bold = cardBold(s);
  const noteLines = (s.notes || '').split(/\r?\n/).slice(1).filter(Boolean);
  const health = healthScore(s);
  const healthBadge = health !== null ? `<span class="badge ${healthClass(health)}" title="健康分：在线率 + 到期远近 + 签到 + 死链">💚 ${health}</span>` : '';
  const tagChips = (s.tags || []).map((t) => `<button class="tag-chip" data-tag="${esc(t)}" title="只看带“${esc(t)}”标签的服务">${esc(t)}</button>`).join('');
  const nextCk = nextCheckinLabel(s, todayStr());
  const lastRenew = (s.renewHistory || []).length ? s.renewHistory[s.renewHistory.length - 1].at : '';
  const up7 = uptimeRate(s, 7);
  const up30 = uptimeRate(s, 30);
  const metaLine = [
    s.registeredAt ? `注册 ${esc(s.registeredAt)}` : '',
    s.expiresAt ? `到期 ${esc(s.expiresAt)}` : '',
    lastRenew ? `上次续期 ${esc(lastRenew)}` : '',
    s.price ? esc(s.price) : '',
    s.hasAccount ? '账号已录 🔒' : '',
    nextCk ? `下次签到 ${nextCk}` : '',
    up7 !== null ? `在线 ${up7}%（7天）` : '',
    up30 !== null && up30 !== up7 ? `30天 ${up30}%` : ''
  ].filter(Boolean).join(' · ') || (live() ? '补个账号备注吧' : '登录后可补全信息');

  const actions = live()
    ? `<div class="card-acts">
        ${bulkMode ? `<input type="checkbox" class="bulk-check" data-bulk-id="${s.id}" ${bulkSel.has(s.id) ? 'checked' : ''}>` : ''}
        <button class="btn small ghost fav-btn${isFav(s) ? ' on' : ''}" data-act="fav" data-id="${s.id}" title="收藏 / 取消收藏">${isFav(s) ? '★ 已收藏' : '☆ 收藏'}</button>
        ${s.checkinFrequency === 'daily' && s.category !== 'idle'
          ? (checkedToday
            ? `<button class="btn small ok" data-act="uncheckin" data-id="${s.id}">↩ 撤回</button>`
            : (dueToday(s, todayStr())
              ? `<button class="btn small primary" data-act="checkin" data-id="${s.id}">签到</button>` : '')) : ''}
        <button class="btn small ghost" data-act="acc-manager" data-id="${s.id}" title="管这个服务的账号（加/改/删账号）">👤 账号${accountList(s).length ? ` (${accountList(s).length})` : ''}</button>
        <button class="btn small ghost" data-act="edit" data-id="${s.id}">编辑</button>
        <button class="btn small ghost" data-act="duplicate" data-id="${s.id}" title="复制出一个一样的服务">复制</button>
        <button class="btn small ghost" data-act="move-up" data-id="${s.id}" title="上移">↑</button>
        <button class="btn small ghost" data-act="move-down" data-id="${s.id}" title="下移">↓</button>
        <button class="btn small ghost" data-act="del" data-id="${s.id}">删除</button>
      </div>`
    : (s.checkinFrequency === 'daily' && s.category !== 'idle'
      ? `<div class="card-acts"><button class="btn small ghost" data-act="wantlogin">🔒 登录后签到</button></div>` : '');

  return `<div class="card${s.abnormal ? ' abnormal' : ''}" data-id="${s.id}">
    <span class="ghost-num">${num}</span>
    <div class="c-head">
      <span class="cat-pill ${cat.cls}"><i></i>${cat.icon} ${cat.label}</span>
      <span class="c-badges">${isFav(s) ? '<span class="badge b-fav">★ 收藏</span>' : ''}${s.abnormal ? '<span class="badge b-bad">⚠️ 异常</span>' : ''}${s.visits ? `<span class="badge b-visit" title="累计访问 ${s.visits} 次">👆 ${s.visits}</span>` : ''}${exp}${healthBadge}${s.linkStatus === 'dead' ? '<span class="badge b-bad" title="最近一次检测打不开">⚠️ 疑似失效</span>' : ''}${st ? `<span class="badge b-fire">🔥 连${st}天</span>` : ''}${checkedToday ? '<span class="badge b-ok">今日已签</span>' : ''}${partialBadge}</span>
    </div>
    <div class="c-title">${favIcon(s)}${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener" data-visit="${s.id}">${esc(s.name)} <span class="arrow">↗</span></a>` : esc(s.name)}</div>
    <div class="c-desc">${esc(bold)}</div>
    ${tagChips ? `<div class="c-tags">${tagChips}</div>` : ''}
    <div class="c-div"></div>
    <div class="c-note">${metaLine}</div>
    ${noteLines.map((l) => `<div class="c-note">${esc(l)}</div>`).join('')}
    ${actions}
  </div>`;
}

function renderGrid() {
  const kw = q.trim().toLowerCase();
  const list = services.filter((s) => {
    if (filter === 'fav' && !isFav(s)) return false;
    if (filter !== 'all' && filter !== 'fav' && s.category !== filter) return false;
    /* v60：标签筛选——点卡片上的标签或标签栏，只看带这个标签的服务 */
    if (tagFilter && !(s.tags || []).includes(tagFilter)) return false;
    if (kw) {
      const hay = `${s.name} ${s.account || ''} ${s.url} ${s.notes} ${s.secret || ''} ${(s.tags || []).join(' ')}`.toLowerCase();
      if (!hay.includes(kw)) return false;
    }
    return true;
  });
  const grid = $('#grid');
  if (!list.length) {
    grid.innerHTML = `<div class="empty">没有匹配的服务。${live() ? '点「➕ 添加服务」把它们都记下来吧。' : '登录后就可以记录了。'}</div>`;
    return;
  }
  const groups = (filter === 'all' || filter === 'fav') ? Object.keys(CATS) : [filter];
  /* v48：搜索时强制全展开，不把搜到的卡片藏在收起的组里 */
  const collapsedCats = kw ? new Set() : loadCollapsedCats();
  let html = '', counter = 0;
  for (const cat of groups) {
    const items = list.filter((s) => s.category === cat);
    if (!items.length) continue;
    const isCol = collapsedCats.has(cat);
    html += `<h2 class="sec-title${isCol ? ' collapsed' : ''}" data-cat="${esc(cat)}"><span class="sec-arrow">${isCol ? '▸' : '▾'}</span>${CATS[cat].icon} ${CATS[cat].label} <i>${items.length}</i></h2><div class="cards${isCol ? ' hidden' : ''}">`;
    html += items.map((s) => cardHTML(s, counter++)).join('');
    html += '</div>';
  }
  grid.innerHTML = html;
  /* 入场交错动画只做一次：搜索/筛选时再逐张淡入会感觉很卡 */
  const searching = document.activeElement === $('#search');
  grid.querySelectorAll('.card').forEach((el, i) => {
    el.draggable = live();
    if (!searching && !reduceMotion && gridFirstRender) {
      el.style.animationDelay = `${Math.min(i * 45, 450)}ms`;
      el.classList.add('reveal-in');
    }
  });
  gridFirstRender = false;
}

/* ---------- 收藏按分类分组：按 CATS 顺序出组，不在 CATS 里的归“其他” ---------- */
function favGroups(favs) {
  const groups = [];
  for (const [id, c] of Object.entries(CATS)) {
    const items = favs.filter((s) => s.category === id);
    if (items.length) groups.push({ title: `${c.icon} ${c.label}`, items });
  }
  const rest = favs.filter((s) => !CATS[s.category]);
  if (rest.length) groups.push({ title: '📦 其他', items: rest });
  return groups;
}
function landingSiteCard(s, star) {
  const host = (() => { try { return new URL(s.url).hostname; } catch { return s.url || ''; } })();
  return `<a class="landing-site" href="${esc(s.url || '#')}" target="_blank" rel="noopener">${favIcon(s)}<b>${star ? '★ ' : ''}${esc(s.name)}</b><i>${esc(host)}</i><span>${CATS[s.category]?.label || s.category}</span><span class="go">直达 ↗</span></a>`;
}

/* ---------- 登录前落地页：只渲染今日签到 + 我的网站 ---------- */
function renderLanding() {
  const t = todayStr();
  const daily = services.filter((s) => todayCohort(s, t));
  /* v53：落地统计只算可计的，异常不占分母；列表仍含异常红显
     v57：落地统计也按账号算（多账号的站，一个账号算一个单位） */
  const countable = daily.filter((s) => !s.abnormal);
  const units = countable.map((s) => serviceProgress(s, t));
  const totalUnits = units.reduce((n, p) => n + p.total, 0);
  const done = units.reduce((n, p) => n + p.done, 0);
  const doneEl = $('#lf-done');
  if (doneEl) doneEl.textContent = `${done}/${totalUnits}`;
  const streakEl = $('#lf-streak');
  if (streakEl) streakEl.textContent = `${Math.max(0, ...services.map((s) => maxRun(s.checkins)))} 天`;
  const sitesEl = $('#lf-sites');
  if (sitesEl) sitesEl.textContent = services.length;
  const bar = $('#landing-checkin-bar');
  if (bar) bar.style.width = totalUnits ? `${(done / totalUnits) * 100}%` : '0';
  const ccEl = $('#landing-checkin-count');
  if (ccEl) ccEl.textContent = totalUnits ? `${done}/${totalUnits}` : '';
  const list = $('#landing-checkin-list');
  if (list) {
    list.innerHTML = daily.length
      ? daily.map((s) => {
          const ok = serviceDoneToday(s, t);
          const p = serviceProgress(s, t);
          return `<div class="landing-checkin-item${ok ? ' done' : ''}${s.abnormal ? ' abnormal' : ''}"><span class="ck ${ok ? 'done' : 'todo'}">${ok ? '✓' : ''}</span><span class="ck-name">${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.name)}</a>` : esc(s.name)}</span><span class="ck-note">${ok ? '今日已签' : (s.abnormal ? '⚠️ 异常，暂时签到不了' : (p.total > 1 ? `已签 ${p.done}/${p.total} · 登录后可签到` : '登录后可签到'))}</span></div>`;
        }).join('')
      : '<div class="empty">还没有需要每日签到的服务。</div>';
  }
  const favGrid = $('#landing-fav-grid');
  if (favGrid) {
    const favs = [...services].filter(isFav).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
    const fcEl = $('#landing-fav-count');
    if (fcEl) fcEl.textContent = favs.length ? `${favs.length}` : '';
    favGrid.innerHTML = favs.length
      ? favGroups(favs).map((g) => `<div class="landing-fav-group"><div class="fav-group-title">${esc(g.title)} <i>${g.items.length}</i></div><div class="landing-sites">${g.items.map((s) => landingSiteCard(s, true)).join('')}</div></div>`).join('')
      : '<div class="empty">还没有收藏。登录后在服务卡片上点 ☆ 收藏，或添加服务时选“收藏”分类，都会归拢到这里。</div>';
  }
  const grid = $('#landing-sites-grid');
  if (grid) {
    const sorted = [...services].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
    /* 落地页搜索：只过滤“我的网站”网格（签到、收藏区和滚动条不受影响） */
    const kw = ($('#landing-search')?.value || '').trim().toLowerCase();
    const shown = kw
      ? sorted.filter((s) => {
          const host = (() => { try { return new URL(s.url).hostname; } catch { return s.url || ''; } })();
          return `${s.name} ${s.url || ''} ${host} ${CATS[s.category]?.label || s.category}`.toLowerCase().includes(kw);
        })
      : sorted;
    const scEl = $('#landing-sites-count');
    if (scEl) scEl.textContent = shown.length ? `${shown.length}` : '';
    /* 首页滚动条：网站名横向慢速滚动，点击名字直达（内容复制两份实现无缝循环） */
    const track = $('#landing-ticker-track');
    if (track) {
      const units = sorted.map((s) => `<a href="${esc(s.url || '#')}" target="_blank" rel="noopener">${esc(s.name)}</a><span class="tk-dot">✦</span>`).join('');
      track.innerHTML = units ? units + units : '';
      track.closest('.landing-ticker').style.display = units ? '' : 'none';
    }
    grid.innerHTML = shown.length
      ? `<div class="landing-sites">${shown.map((s) => {
          const host = (() => { try { return new URL(s.url).hostname; } catch { return s.url || ''; } })();
          return `<a class="landing-site" href="${esc(s.url || '#')}" target="_blank" rel="noopener">${favIcon(s)}<b>${isFav(s) ? '★ ' : ''}${esc(s.name)}</b><i>${esc(host)}</i><span>${CATS[s.category]?.label || s.category}</span><span class="go">直达 ↗</span></a>`;
        }).join('')}</div>`
      : (kw ? '<div class="empty">没有匹配的网站，换个关键词试试。</div>' : '<div class="empty">还没有收录网站，登录后添加。</div>');
  }
  /* v60：公开状态页——每个服务的在线/离线 + 7 天在线率（只用公开接口里的数据） */
  const stList = $('#landing-status-list');
  if (stList) {
    const withStatus = services.filter((s) => s.url);
    const upCount = withStatus.filter((s) => s.linkStatus === 'ok').length;
    const scEl = $('#landing-status-count');
    if (scEl) scEl.textContent = withStatus.length ? `${upCount}/${withStatus.length} 在线` : '';
    stList.innerHTML = withStatus.length
      ? withStatus.map((s) => {
          const dot = s.linkStatus === 'ok' ? '🟢' : (s.linkStatus === 'dead' ? '🔴' : '⚪');
          const label = s.linkStatus === 'ok' ? '在线' : (s.linkStatus === 'dead' ? '疑似离线' : '未检测');
          const up = (s.uptime7 !== null && s.uptime7 !== undefined) ? ` · 7天在线率 ${s.uptime7}%` : '';
          return `<div class="landing-checkin-item"><span class="ck">${dot}</span><span class="ck-name">${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.name)}</a>` : esc(s.name)}</span><span class="ck-note">${label}${up}</span></div>`;
        }).join('')
      : '<div class="empty">还没有可检测的服务。</div>';
  }
  /* 渲染完再量一次：框内装不下时才显示滚动提示 */
  requestAnimationFrame(checkLandingScroll);
}

/* 首页框内滚动提示：内容超出框高时才显示“框内滚动查看全部” */
function checkLandingScroll() {
  [['landing-checkin-list', 'landing-checkin-hint'], ['landing-fav-grid', 'landing-fav-hint'], ['landing-sites-grid', 'landing-sites-hint']].forEach(([listId, hintId]) => {
    const el = document.getElementById(listId), hint = document.getElementById(hintId);
    if (el && hint) hint.classList.toggle('hidden', el.scrollHeight <= el.clientHeight + 4);
  });
}
let landingScrollTimer = null;
addEventListener('resize', () => {
  clearTimeout(landingScrollTimer);
  landingScrollTimer = setTimeout(checkLandingScroll, 150);
});

/* ---------- 收藏管理专区（仅登录后） ---------- */
function renderFav() {
  const box = $('#fav-list');
  if (!box) return;
  const favs = [...services].filter(isFav).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  const count = $('#fav-count');
  if (count) count.textContent = `共 ${favs.length} 个收藏`;
  box.innerHTML = favs.length
    ? favGroups(favs).map((g) => `<div class="fav-group-title">${esc(g.title)} <i>${g.items.length}</i></div>${g.items.map((s) => {
        const host = (() => { try { return new URL(s.url).hostname; } catch { return s.url || ''; } })();
        return `<div class="landing-checkin-item"><span class="ck">★</span><span class="ck-name">${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.name)}</a>` : esc(s.name)}</span><span class="ck-note">${esc(CATS[s.category]?.label || s.category)} · ${esc(host)}</span><button class="btn small ghost" data-act="fav" data-id="${s.id}">取消收藏</button></div>`;
      }).join('')}`).join('')
    : '<div class="empty">还没有收藏。在下面服务台账的卡片上点 ☆ 收藏，或点“添加服务”/“编辑”时勾选收藏、选“收藏”分类，就会集中到这里。</div>';
}

/* ---------- 临期提醒专区（仅登录后，30 天内到期含已过期） ---------- */
/* v59：续期记录展开/收起（纯前端，不写数据） */
const expandedRenewHistory = new Set();
function renderExpiring() {
  const box = $('#expiring-list');
  if (!box) return;
  const items = services
    .filter((s) => s.expiresAt)
    .map((s) => ({ s, d: daysUntil(s.expiresAt) }))
    .filter((x) => x.d <= 30)
    .sort((a, b) => a.d - b.d);
  const navCount = $('#expiring-nav-count');
  if (navCount) navCount.textContent = items.length ? items.length : '';
  const count = $('#expiring-count');
  if (count) count.textContent = items.length ? `共 ${items.length} 个临期` : '';
  box.innerHTML = items.length
    ? items.map(({ s, d }) => {
        const host = (() => { try { return new URL(s.url).hostname; } catch { return s.url || ''; } })();
        const badge = d < 0
          ? `<span class="exp-badge overdue">已过期 ${-d} 天</span>`
          : (d === 0 ? '<span class="exp-badge overdue">今天到期</span>'
          : (d <= 7 ? `<span class="exp-badge soon">${d} 天后到期</span>`
          : `<span class="exp-badge later">${d} 天后到期</span>`));
        const hist = (s.renewHistory || []).slice().reverse().map((h) => `<div>${esc(h.at)}：${esc(h.from || '—')} → ${esc(h.to)}</div>`).join('');
        return `<div class="exp-item"><div class="landing-checkin-item"><span class="ck">⏰</span><span class="ck-name">${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.name)}</a>` : esc(s.name)}</span><span class="ck-note">${esc(CATS[s.category]?.label || s.category)} · 到期 ${esc(s.expiresAt)}${host ? ` · ${esc(host)}` : ''}</span>${badge}<button class="btn small ghost" data-act="renew" data-id="${s.id}">${renewLabel(s)}</button><button class="btn small ghost" data-act="edit" data-id="${s.id}">编辑</button>${(s.prevRenew || s.prevExpiresAt) ? `<button class="btn small ghost" data-act="undo-renew" data-id="${s.id}">↩ 撤回续期</button>` : ''}${(s.renewHistory || []).length ? `<button class="btn small ghost" data-act="toggle-renew-hist" data-id="${s.id}">📜 记录 (${s.renewHistory.length})</button>` : ''}</div>${expandedRenewHistory.has(s.id) && hist ? `<div class="renew-hist">${hist}</div>` : ''}</div>`;
      }).join('')
    : '<div class="empty">太好了，30 天内没有要到期的服务。</div>';
  renderCalendar();
}

/* ---------- 到期日历：按月看哪天有服务到期 ---------- */
let calYear = null, calMonth = null; // 0-based month；null = 本月
let calSelected = ''; // 选中的日期 YYYY-MM-DD
function renderCalendar() {
  const box = $('#expiry-calendar');
  if (!box) return;
  if (calYear === null) {
    const t = todayStr().split('-').map(Number);
    calYear = t[0]; calMonth = t[1] - 1; calSelected = todayStr();
  }
  const byDate = {};
  for (const s of services) {
    if (!s.expiresAt) continue;
    (byDate[s.expiresAt] = byDate[s.expiresAt] || []).push(s);
  }
  const startWeekday = new Date(calYear, calMonth, 1).getDay();
  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  const today = todayStr();
  let cells = '';
  for (let i = 0; i < startWeekday; i++) cells += '<span class="cal-day empty"></span>';
  for (let d = 1; d <= daysInMonth; d++) {
    const ymd = `${calYear}-${String(calMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const list = byDate[ymd] || [];
    const cls = ['cal-day'];
    if (ymd === today) cls.push('today');
    if (list.length) cls.push('has-exp');
    if (ymd === calSelected) cls.push('selected');
    if (ymd < today) cls.push('past');
    cells += `<button class="${cls.join(' ')}" data-cal-day="${ymd}" ${list.length ? '' : 'disabled'}><b>${d}</b>${list.length ? `<i>${list.length}个</i>` : ''}</button>`;
  }
  box.innerHTML = `<div class="cal-head"><button class="btn small ghost" id="cal-prev">‹</button><b>${calYear}年${calMonth + 1}月</b><button class="btn small ghost" id="cal-next">›</button></div><div class="cal-week"><span>日</span><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span></div><div class="cal-grid">${cells}</div>`;
  $('#cal-prev').addEventListener('click', () => { calMonth--; if (calMonth < 0) { calMonth = 11; calYear--; } renderCalendar(); });
  $('#cal-next').addEventListener('click', () => { calMonth++; if (calMonth > 11) { calMonth = 0; calYear++; } renderCalendar(); });
  box.querySelectorAll('[data-cal-day]').forEach((b) => b.addEventListener('click', () => { calSelected = b.dataset.calDay; renderCalendar(); renderCalDayList(); }));
  renderCalDayList();
}
function renderCalDayList() {
  const box = $('#cal-day-list');
  if (!box) return;
  const list = services.filter((s) => s.expiresAt === calSelected);
  if (!list.length) { box.innerHTML = ''; return; }
  const [, m, d] = calSelected.split('-');
  box.innerHTML = `<div class="cal-day-list"><b>${+m}月${+d}日到期（${list.length}个）：</b>${list.map((s) => s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.name)}</a>` : esc(s.name)).join('、')}</div>`;
}

/* ---------- Telegram 通知设置 ---------- */
async function loadNotify() {
  try {
    const n = await api('/api/notify');
    $('#n-chat').value = n.chatId || '';
    $('#n-expiring').checked = n.expiring !== false;
    $('#n-checkin').checked = n.checkin !== false;
    $('#n-pushhour').value = (n.pushHour === undefined ? 9 : n.pushHour);
    $('#n-repeat').value = (n.repeatHours === undefined ? 0 : n.repeatHours);
    $('#notify-status').textContent = n.configured ? '已配置' : '未配置';
  } catch { /* 未登录时不打扰 */ }
}
/* 反馈一眼可见：成功绿色、失败红色，不再是一行不起眼的灰字 */
function notifyMsg(text, ok) {
  const msg = $('#notify-msg');
  msg.textContent = text;
  msg.style.color = ok ? '#34d399' : '#f87171';
}
$('#btn-notify-save').addEventListener('click', async () => {
  const b = $('#btn-notify-save');
  if (b.disabled) return;
  b.disabled = true;
  try {
    await api('/api/notify', { method: 'POST', body: JSON.stringify({ token: $('#n-token').value, chatId: $('#n-chat').value, expiring: $('#n-expiring').checked, checkin: $('#n-checkin').checked, pushHour: $('#n-pushhour').value, repeatHours: $('#n-repeat').value }) });
    $('#n-token').value = '';
    notifyMsg('已保存。', true);
    loadNotify();
  } catch (e) { notifyMsg(e.message, false); }
  finally { b.disabled = false; }
});
$('#btn-notify-resolve').addEventListener('click', async () => {
  const b = $('#btn-notify-resolve');
  if (b.disabled) return;
  b.disabled = true;
  try {
    const r = await api('/api/notify/resolve', { method: 'POST' });
    $('#n-chat').value = r.chatId;
    notifyMsg(`已获取并保存 Chat ID：${r.chatId}`, true);
    loadNotify();
  } catch (e) { notifyMsg(e.message, false); }
  finally { b.disabled = false; }
});
$('#btn-notify-test').addEventListener('click', async () => {
  /* 防连点：测试消息连点会往 Telegram 发两条 */
  const b = $('#btn-notify-test');
  if (b.disabled) return;
  b.disabled = true;
  const oldText = b.textContent;
  b.textContent = '发送中…';
  try {
    await api('/api/notify/test', { method: 'POST' });
    notifyMsg('测试消息已发送，请去 Telegram 查看。', true);
  } catch (e) { notifyMsg(e.message, false); }
  finally { b.disabled = false; b.textContent = oldText; }
});

/* ---------- 弹窗 ---------- */
function renderCatOptions() {
  $('#f-category').innerHTML = Object.entries(CATS).map(([id, c]) => `<option value="${id}">${esc(c.icon)} ${esc(c.label)}</option>`).join('');
}
/* 多账号：取服务的账号列表；老数据只有 account/secret 时当成一个默认账号 */
function accountList(s) {
  if (Array.isArray(s?.accounts) && s.accounts.length) return s.accounts;
  if (s?.account || s?.secret) return [{ id: 'legacy', label: '默认', username: s.account || '', password: s.secret || '', notes: '', isDefault: true }];
  return [];
}
/* ---------- 账号管理弹窗（v58：和服务编辑页分开，单独管一个服务的账号） ---------- */
let accMgrSvcId = null; // 正在管哪个服务的账号
let accMgrEditId = null; // 正在编辑哪个账号（null = 正在添加）
function accMgrSvc() { return services.find((s) => s.id === accMgrSvcId) || null; }
function openAccManager(svcId) {
  const svc = services.find((s) => s.id === svcId);
  if (!svc) return;
  accMgrSvcId = svcId;
  accMgrEditId = null;
  $('#acc-modal-title').textContent = `👤 ${svc.name} 的账号`;
  hideAccForm();
  renderAccManager();
  $('#acc-overlay').classList.remove('hidden');
}
function closeAccManager() {
  $('#acc-overlay').classList.add('hidden');
  accMgrSvcId = null;
  accMgrEditId = null;
}
/* 弹窗里的账号列表：只读展示 + 复制/签到/设默认/编辑/删除；编辑和删除都走下面的保存 */
function renderAccManager() {
  const box = $('#am-list');
  if (!box) return;
  const svc = accMgrSvc();
  if (!svc) { box.innerHTML = ''; return; }
  const t = todayStr();
  const list = accountList(svc);
  const canCheckin = svc.checkinFrequency === 'daily' && svc.category !== 'idle';
  const p = serviceProgress(svc, t);
  const prog = (canCheckin && p.total > 1) ? `<span class="muted">已签 ${p.done}/${p.total} · ${Math.round(p.done / p.total * 100)}%</span>` : '';
  const head = `<div class="acc-panel-head"><b>👤 账号（${list.length}）</b>${prog}${svc.url ? `<a href="${esc(svc.url)}" target="_blank" rel="noopener">直达网站 ↗</a>` : ''}</div>`;
  const rows = list.map((a) => {
    const signed = accCheckins(a).includes(t);
    const signBtn = canCheckin
      ? (signed
        ? `<span class="signed-tag">✓ 今日已签</span><button class="btn small ghost" data-act="uncheckin-acc" data-id="${svc.id}" data-acc="${esc(a.id)}">↩ 撤回</button>`
        : `<button class="btn small primary" data-act="checkin-acc" data-id="${svc.id}" data-acc="${esc(a.id)}">签到</button>`)
      : '';
    return `<div class="acc-item">
      <div class="acc-item-top"><b>${esc(a.label)}</b>${a.isDefault ? '<span class="acc-default-tag">★ 默认</span>' : `<button class="btn small ghost" data-act="set-default-acc" data-id="${svc.id}" data-acc="${esc(a.id)}">设为默认</button>`}<span style="margin-left:auto;display:flex;gap:6px;align-items:center">${signBtn}<button class="btn small ghost" data-act="acc-edit" data-id="${svc.id}" data-acc="${esc(a.id)}">编辑</button><button class="btn small ghost" data-act="acc-del" data-id="${svc.id}" data-acc="${esc(a.id)}">删除</button></span></div>
      <div class="acc-line"><span class="acc-k">账号</span><span class="acc-v">${esc(a.username) || '<i class="muted">（空）</i>'}</span><button class="btn small ghost" data-act="copy-acc-user" data-id="${svc.id}" data-acc="${esc(a.id)}">复制</button></div>
      <div class="acc-line"><span class="acc-k">密码</span><span class="acc-v acc-pw">••••••</span><button class="btn small ghost" data-act="toggle-pw" data-id="${svc.id}" data-acc="${esc(a.id)}">👁</button><button class="btn small ghost" data-act="copy-acc-pw" data-id="${svc.id}" data-acc="${esc(a.id)}">复制</button></div>
      ${a.notes ? `<div class="acc-note">${esc(a.notes)}</div>` : ''}
    </div>`;
  }).join('');
  box.innerHTML = head + (rows || '<div class="empty">还没录账号，点下面的“➕ 添加账号”。</div>');
}
/* 弹窗关着就什么都不做；开着就按最新的 services 重画（签到/设默认后刷新用） */
function refreshAccManager() {
  if (!accMgrSvcId || $('#acc-overlay')?.classList.contains('hidden')) return;
  if (!accMgrSvc()) { closeAccManager(); return; }
  renderAccManager();
}
function hideAccForm() {
  $('#am-form')?.classList.add('hidden');
  accMgrEditId = null;
}
/* v59：密码生成器——crypto 随机，四类字符（大小写/数字/符号）至少各一个，
   排除了容易看错的 I O l o 0 1 */
function generatePassword(len) {
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnpqrstuvwxyz', '23456789', '!@#$%^&*_-+='];
  const all = sets.join('');
  const n = Math.min(64, Math.max(8, parseInt(len, 10) || 16));
  const buf = new Uint32Array(n);
  crypto.getRandomValues(buf);
  const pick = (set, i) => set[buf[i] % set.length];
  const chars = sets.map((set, i) => pick(set, i));
  for (let i = sets.length; i < n; i++) chars.push(pick(all, i));
  for (let i = chars.length - 1; i > 0; i--) { const j = buf[i] % (i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
  return chars.join('');
}
$('#am-gen-pw').addEventListener('click', () => {
  const pw = generatePassword($('#am-pw-len').value);
  $('#am-password').value = pw;
  toast('已生成强密码，记得保存账号');
});
function showAccForm(acc) {
  accMgrEditId = acc ? acc.id : null;
  $('#am-label').value = acc?.label || '';
  $('#am-username').value = acc?.username || '';
  $('#am-password').value = acc?.password || '';
  $('#am-notes').value = acc?.notes || '';
  $('#am-form-save').textContent = acc ? '保存修改' : '添加账号';
  $('#am-form').classList.remove('hidden');
  $('#am-username').focus();
}
/* 把一整份账号数组存回去（带上各账号的签到记录，免得保存时丢了）；保存完刷新列表 */
async function saveAccAccounts(next) {
  const svc = accMgrSvc();
  if (!svc) return;
  const r = await api(`/api/services/${svc.id}`, { method: 'PUT', body: JSON.stringify({ accounts: next }) });
  await loadAll();
  refreshAccManager();
  return r;
}
async function saveAccForm() {
  const svc = accMgrSvc();
  if (!svc) return;
  const username = $('#am-username').value.trim();
  const password = $('#am-password').value;
  if (!username && !password) return toast('账号和密码至少填一个', 'bad');
  const cur = accountList(svc);
  const one = {
    id: accMgrEditId || '',
    label: $('#am-label').value.trim().slice(0, 30) || '账号',
    username: username.slice(0, 200),
    password: password.slice(0, 500),
    notes: $('#am-notes').value.trim().slice(0, 200),
    isDefault: false
  };
  let next;
  if (accMgrEditId) {
    const old = cur.find((a) => a.id === accMgrEditId);
    if (!old) return toast('找不到该账号', 'bad');
    one.isDefault = old.isDefault;
    one.checkins = old.checkins || [];
    next = cur.map((a) => (a.id === accMgrEditId ? one : a));
  } else {
    one.isDefault = !cur.length;
    one.checkins = [];
    next = [...cur, one];
  }
  if (next.length && !next.some((a) => a.isDefault)) next[0].isDefault = true;
  const saveBtn = $('#am-form-save');
  if (saveBtn.disabled) return;
  saveBtn.disabled = true;
  try {
    await saveAccAccounts(next);
    hideAccForm();
    toast(accMgrEditId ? '已保存' : '已添加账号');
  } catch (err) { handleAuthErr(err); }
  finally { saveBtn.disabled = false; }
}
async function deleteAccAccount(accId) {
  const svc = accMgrSvc();
  if (!svc) return;
  const acc = accountList(svc).find((a) => a.id === accId);
  if (!acc) return;
  if (!confirm(`确定删除账号「${acc.label}」？删除后不可恢复。`)) return;
  const next = accountList(svc).filter((a) => a.id !== accId);
  if (next.length && !next.some((a) => a.isDefault)) next[0].isDefault = true;
  try {
    await saveAccAccounts(next);
    toast('已删除账号');
  } catch (err) { handleAuthErr(err); }
}
$('#am-add').addEventListener('click', () => showAccForm(null));
$('#am-form-cancel').addEventListener('click', hideAccForm);
$('#am-form-save').addEventListener('click', saveAccForm);
$('#am-done').addEventListener('click', closeAccManager);
$('#acc-overlay').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeAccManager(); });
function openModal(svc) {
  editingId = svc ? svc.id : null;
  $('#modal-title').textContent = svc ? '编辑服务' : '添加服务';
  $('#f-name').value = svc?.name || '';
  renderCatOptions();
  $('#f-category').value = (svc?.category && CATS[svc.category]) ? svc.category : 'relay';
  $('#f-url').value = svc?.url || '';
  $('#f-tags').value = (svc?.tags || []).join('，');
  $('#f-registered').value = svc?.registeredAt || todayStr();
  $('#f-expires').value = svc?.expiresAt || '';
  expiryDirty = false; // 新开弹窗：到期日还没手动改过，可以自动填
  $('#f-price').value = svc?.price || '';
  $('#f-frequency').value = svc?.checkinFrequency || 'none';
  $('#f-every-days').value = svc?.checkinEveryDays ?? 1;
  $('#f-renew-days').value = svc?.renewDays ?? 365;
  $('#f-every-days').disabled = ($('#f-frequency').value !== 'daily');
  $('#f-notes').value = svc?.notes || '';
  $('#f-fav').checked = isFav(svc);
  $('#f-abnormal').checked = !!svc?.abnormal;
  /* v60：自动签到配置——请求头一行一个“名字: 值”，打开时拼回文本框 */
  const as = svc?.autoSignin || {};
  $('#f-autosignin-enabled').checked = !!as.enabled;
  $('#f-autosignin-url').value = as.url || '';
  $('#f-autosignin-method').value = as.method === 'GET' ? 'GET' : 'POST';
  $('#f-autosignin-headers').value = Object.entries(as.headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n');
  $('#f-autosignin-body').value = as.body || '';
  $('#f-autosignin-expect').value = as.expect || '';
  $('#autosignin-test-msg').textContent = '';
  const last = svc?.autoSigninLast;
  $('#autosignin-last').textContent = last ? `上次自动签到：${last.at || ''} ${last.ok ? '✅ 成功' : `❌ 失败（${last.note || 'HTTP ' + (last.status || '')}）`}` : '';
  $('#overlay').classList.remove('hidden');
  $('#f-name').focus();
}
function closeModal() {
  $('#overlay').classList.add('hidden');
  editingId = null;
}

/* v51：改开始时间或续期周期时自动填到期日；手动改过到期日则不覆盖 */
$('#f-registered').addEventListener('change', autoFillExpires);
$('#f-renew-days').addEventListener('change', autoFillExpires);
$('#f-expires').addEventListener('input', () => { expiryDirty = true; });

/* v60：自动签到——测试这个请求（只发请求不记签到，返回状态和结果） */
$('#btn-autosignin-test').addEventListener('click', async () => {
  const msg = $('#autosignin-test-msg');
  const url = $('#f-autosignin-url').value.trim();
  if (!url) { msg.textContent = '先填签到接口网址'; return; }
  const headers = {};
  for (const line of $('#f-autosignin-headers').value.split('\n')) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    if (k) headers[k] = v;
  }
  const btn = $('#btn-autosignin-test');
  if (btn.disabled) return;
  btn.disabled = true;
  msg.textContent = '请求中…';
  try {
    const r = await api('/api/auto-signin/test', { method: 'POST', body: JSON.stringify({ autoSignin: {
      enabled: true, url, method: $('#f-autosignin-method').value, headers,
      body: $('#f-autosignin-body').value, expect: $('#f-autosignin-expect').value.trim()
    } }) });
    msg.textContent = r.ok ? `✅ 请求成功（HTTP ${r.status}）` : `❌ 没签上：${r.note || 'HTTP ' + r.status}`;
  } catch (err) { msg.textContent = '测试失败：' + (err.message || ''); }
  finally { btn.disabled = false; }
});

/* ---------- 事件 ---------- */
document.body.addEventListener('click', async (e) => {
  /* 访问统计：点标题链接打点计数（不拦截跳转） */
  const vEl = e.target.closest('[data-visit]');
  if (vEl) {
    const s = services.find((x) => x.id === vEl.dataset.visit);
    if (s && live()) {
      s.visits = (s.visits || 0) + 1;
      api(`/api/services/${s.id}/visit`, { method: 'POST' }).catch(() => {});
      const badge = vEl.closest('.card')?.querySelector('.b-visit');
      if (badge) badge.textContent = `👆 ${s.visits}`;
      else renderGrid();
    }
    return;
  }

  const chip = e.target.closest('[data-cat]');
  if (chip) { filter = chip.dataset.cat; renderChips(); renderGrid(); return; }

  /* v60：标签筛选——点标签栏或卡片上的标签，只看带这个标签的服务；再点同一个取消 */
  const tagEl = e.target.closest('[data-tag]');
  if (tagEl) {
    const t = tagEl.dataset.tag;
    tagFilter = (tagFilter === t) ? null : t;
    renderChips();
    renderGrid();
    return;
  }

  const cp = e.target.closest('[data-copy]');
  if (cp) { await copyText(cp.dataset.copy); toast('已复制'); return; }

  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  const id = btn.dataset.id;

  /* 防连点：写数据的按钮点下去就禁用，直到请求 + 刷新完成；失败也恢复。
     只拦真正写数据的动作，打开弹窗/登录/查看密钥这种纯前端动作不拦 */
  const guarded = ['fav', 'checkin', 'uncheckin', 'checkin-acc', 'uncheckin-acc', 'renew', 'undo-renew', 'move-up', 'move-down', 'del', 'duplicate', 'set-default-acc'].includes(act);
  if (guarded) btn.disabled = true;
  try {
    if (act === 'wantlogin') { openLogin(); return; }
    /* v59：续期记录展开/收起（纯前端，不写数据） */
    if (act === 'toggle-renew-hist') {
      if (expandedRenewHistory.has(id)) expandedRenewHistory.delete(id);
      else expandedRenewHistory.add(id);
      renderExpiring();
      return;
    }
    /* v58：账号管理弹窗的打开/编辑/删除（弹窗本身不写数据，保存时才 PUT） */
    if (act === 'acc-manager') { openAccManager(id); return; }
    if (act === 'acc-edit') {
      const svc = services.find((x) => x.id === id);
      const acc = svc ? accountList(svc).find((a) => a.id === btn.dataset.acc) : null;
      if (!acc) return;
      showAccForm(acc);
      return;
    }
    if (act === 'acc-del') { deleteAccAccount(btn.dataset.acc); return; }
    const findAcc = () => {
      const svc = services.find((x) => x.id === id);
      const acc = svc ? accountList(svc).find((a) => a.id === btn.dataset.acc) : null;
      return { svc, acc };
    };
    if (act === 'copy-acc-user' || act === 'copy-acc-pw') {
      const { acc } = findAcc();
      if (!acc) return;
      await copyText(act === 'copy-acc-user' ? acc.username : acc.password);
      toast(act === 'copy-acc-user' ? '账号已复制' : '密码已复制');
      return;
    }
    if (act === 'toggle-pw') {
      const { acc } = findAcc();
      if (!acc) return;
      const span = btn.closest('.acc-line')?.querySelector('.acc-pw');
      if (!span) return;
      span.textContent = span.textContent === '••••••' ? (acc.password || '（空）') : '••••••';
      return;
    }
    if (act === 'toggle-dup-pw') {
      const g = dupPwGroups[parseInt(btn.dataset.dupIdx, 10)];
      if (!g) return;
      const span = btn.closest('.panel-head')?.querySelector('.acc-pw');
      if (!span) return;
      span.textContent = span.textContent === '••••••' ? g.pw : '••••••';
      return;
    }
    if (act === 'set-default-acc') {
      const { svc, acc } = findAcc();
      if (!svc || !acc) return;
      const next = accountList(svc).map((a) => ({ ...a, isDefault: a.id === acc.id }));
      await api(`/api/services/${id}`, { method: 'PUT', body: JSON.stringify({ accounts: next }) });
      await loadAll();
      refreshAccManager();
      toast(`已把「${acc.label}」设为默认账号`);
      return;
    }
    if (act === 'fav') {
      const svc = services.find((s) => s.id === id);
      if (!svc) return;
      /* 点星 / 取消星只改星标，绝不碰分类：收藏分类的服务取消收藏后，
         只是不再显示在收藏栏，台账里仍在“收藏”分组下 */
      const next = !isFav(svc);
      const payload = { favorite: next };
      await api(`/api/services/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
      svc.favorite = next;
      starBurst(e.clientX, e.clientY, next);
      renderGrid();
      renderFav();
      renderChips();
      toast(next ? '★ 已收藏，首页可见' : '已取消收藏');
      return;
    }
    if (act === 'checkin' || act === 'uncheckin') {
      const r = await api(`/api/services/${id}/${act}`, { method: 'POST' });
      if (act === 'checkin') {
        if (r.xpGained > 0) toast(`+${r.xpGained} 热情值 ⚡`, 'gold');
        if (r.allDone) { confetti(90); setTimeout(() => toast('🎉 今日全勤达成！奖励 +10⚡', 'gold'), 900); }
        if (r.unlocked && r.unlocked.length) {
          confetti(110);
          setTimeout(() => toast(`🏆 解锁成就：${r.unlocked.map((a) => `${a.icon} ${a.name}`).join('、')}（+10⚡）`, 'gold'), 1800);
        }
      } else {
        toast('已撤回今日签到');
      }
      await loadAll();
    } else if (act === 'checkin-acc' || act === 'uncheckin-acc') {
      /* v57：只签/撤一个账号；签完最后一个账号服务才算签完（这时才给分） */
      const r = await api(`/api/services/${id}/${act === 'checkin-acc' ? 'checkin-account' : 'uncheckin-account'}`, { method: 'POST', body: JSON.stringify({ accountId: btn.dataset.acc }) });
      if (act === 'checkin-acc') {
        if (r.xpGained > 0) toast(`+${r.xpGained} 热情值 ⚡`, 'gold');
        else if (r.accounts && r.accounts.length > 1) {
          const doneN = r.accounts.filter((a) => (a.checkins || []).includes(todayStr())).length;
          toast(`已签 ${doneN}/${r.accounts.length}`);
        }
        if (r.allDone) { confetti(90); setTimeout(() => toast('🎉 今日全勤达成！奖励 +10⚡', 'gold'), 900); }
        if (r.unlocked && r.unlocked.length) {
          confetti(110);
          setTimeout(() => toast(`🏆 解锁成就：${r.unlocked.map((a) => `${a.icon} ${a.name}`).join('、')}（+10⚡）`, 'gold'), 1800);
        }
      } else {
        toast('已撤回该账号的今日签到');
      }
      await loadAll();
      refreshAccManager();
    } else if (act === 'renew') {
      const r = await api(`/api/services/${id}/renew`, { method: 'POST' });
      await loadAll();
      toast(`已续到 ${r.expiresAt}`);
    } else if (act === 'undo-renew') {
      const r = await api(`/api/services/${id}/undo-renew`, { method: 'POST' });
      await loadAll();
      toast(`已撤回续期，恢复到 ${r.expiresAt}`);
    } else if (act === 'move-up' || act === 'move-down') {
      await api(`/api/services/${id}/move`, { method: 'POST', body: JSON.stringify({ dir: act === 'move-down' ? 'down' : 'up' }) });
      await loadAll();
    } else if (act === 'edit') {
      openModal(services.find((s) => s.id === id));
    } else if (act === 'duplicate') {
      /* v59：复制服务——服务端复制一份（名字后加“副本”），跳到新卡片 */
      const r = await api(`/api/services/${id}/duplicate`, { method: 'POST' });
      await loadAll();
      toast('已复制一个服务');
      const el = r?.id ? document.querySelector(`.card[data-id="${r.id}"]`) : null;
      if (el) {
        el.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
        el.classList.add('card-flash');
        setTimeout(() => el.classList.remove('card-flash'), 1500);
      }
    } else if (act === 'del') {
      const svc = services.find((s) => s.id === id);
      if (confirm(`确定删除「${svc ? svc.name : ''}」？删除后不可恢复。`)) {
        /* 先让卡片淡出缩小，动画播完再真正删除；接口失败则把卡片恢复原样 */
        const cardEl = btn.closest('.card');
        if (cardEl) cardEl.classList.add('card-leaving');
        await new Promise((r) => setTimeout(r, 280));
        try {
          await api(`/api/services/${id}`, { method: 'DELETE' });
          await loadAll();
          toast('已删除');
        } catch (err) {
          if (cardEl) cardEl.classList.remove('card-leaving');
          handleAuthErr(err);
        }
      }
    } else if (act === 'reveal') {
      const el = document.querySelector(`[data-secret-id="${id}"]`);
      if (el) {
        if (el.dataset.shown === '1') { el.textContent = '••••••'; el.dataset.shown = ''; }
        else { el.textContent = el.dataset.v; el.dataset.shown = '1'; }
      }
    }
  } catch (err) { handleAuthErr(err); }
  finally { if (guarded) btn.disabled = false; }
});

/* 签到频率切到“不签到”时，间隔输入框禁用（反之恢复） */
$('#f-frequency').addEventListener('change', () => {
  $('#f-every-days').disabled = ($('#f-frequency').value !== 'daily');
});

$('#btn-check-all').addEventListener('click', async () => {
  const t = todayStr();
  const todo = services.filter((s) => dueToday(s, t) && !s.abnormal);
  if (!todo.length) return;
  const btn = $('#btn-check-all');
  btn.disabled = true;
  btn.textContent = '签到中…';
  /* 服务端一次签完：原来是逐个请求，签一半断网会留一半 */
  try {
    const r = await api('/api/checkins/all', { method: 'POST' });
    await loadAll();
    toast(`⚡ 一键全签完成，共 +${r.xpGained || 0} 热情值！`, 'gold');
    if ((r.unlocked && r.unlocked.length) || r.allDone) confetti(120);
  } catch (err) {
    /* 失败也要把按钮恢复，别卡在“签到中…” */
    btn.disabled = false;
    btn.textContent = '⚡ 一键全签';
    handleAuthErr(err);
  }
});

$('#l-captcha-refresh').addEventListener('click', loadCaptcha);
$('#l-captcha-img').addEventListener('click', loadCaptcha);
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#l-err').classList.add('hidden');
  try {
    me = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username: $('#l-user').value.trim(), password: $('#l-pass').value, captchaId, captcha: $('#l-captcha').value, totp: $('#l-totp').value.trim() || undefined })
    });
    $('#l-pass').value = '';
    $('#l-captcha').value = '';
    $('#l-totp').value = '';
    $('#login-overlay').classList.add('hidden');
    await loadAll();
    confetti(60);
    toast(`欢迎回来，${me.username}！`, 'gold');
  } catch (err) {
    /* v60：密码对了但没填动态码——把二次验证框露出来，让用户填了再登 */
    if (err.message === 'need_totp') {
      $('#l-totp-row').style.display = '';
      $('#l-err').textContent = '开了二次验证，请输入 Authenticator 里的 6 位动态码';
      $('#l-err').classList.remove('hidden');
      $('#l-totp').focus();
      return;
    }
    $('#l-err').textContent = err.message;
    $('#l-err').classList.remove('hidden');
    /* 验证码一次性作废：任何一次登录失败都换一张，旧图再填也无效 */
    $('#l-captcha').value = '';
    loadCaptcha();
  }
});

$('#btn-login').addEventListener('click', openLogin);
$('#btn-hero-login').addEventListener('click', openLogin);
const landingLogin = $('#landing-login');
if (landingLogin) landingLogin.addEventListener('click', openLogin);
const landingHeroLogin = $('#landing-hero-login');
if (landingHeroLogin) landingHeroLogin.addEventListener('click', openLogin);
const landingFootLogin = $('#landing-foot-login');
if (landingFootLogin) landingFootLogin.addEventListener('click', openLogin);
$('#login-cancel').addEventListener('click', () => $('#login-overlay').classList.add('hidden'));
$('#login-overlay').addEventListener('click', (e) => { if (e.target === e.currentTarget) $('#login-overlay').classList.add('hidden'); });

$('#btn-logout').addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST' }); } catch {}
  location.reload();
});

$('#btn-add').addEventListener('click', () => openModal(null));
$('#modal-cancel').addEventListener('click', closeModal);
$('#overlay').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeModal(); });
$('#pass-overlay').addEventListener('click', (e) => { if (e.target === e.currentTarget) $('#pass-overlay').classList.add('hidden'); });
$('#btn-pass').addEventListener('click', () => $('#pass-overlay').classList.remove('hidden'));
$('#pass-cancel').addEventListener('click', () => $('#pass-overlay').classList.add('hidden'));

$('#modal-save').addEventListener('click', async () => {
  const isEdit = !!editingId;
  const f = {
    name: $('#f-name').value.trim(),
    category: $('#f-category').value,
    url: $('#f-url').value.trim(),
    tags: $('#f-tags').value.split(/[,，、\s]+/).map((t) => t.trim()).filter(Boolean).slice(0, 10),
    registeredAt: $('#f-registered').value,
    expiresAt: $('#f-expires').value,
    price: $('#f-price').value.trim(),
    checkinFrequency: $('#f-frequency').value,
    checkinEveryDays: Math.min(365, Math.max(1, parseInt($('#f-every-days').value, 10) || 1)),
    renewDays: Math.min(3650, Math.max(1, parseInt($('#f-renew-days').value, 10) || 365)),
    notes: $('#f-notes').value.trim(),
    favorite: $('#f-fav').checked,
    abnormal: $('#f-abnormal').checked,
    /* v60：自动签到配置——请求头一行一个“名字: 值”，解析成对象；没填网址就不发这个字段 */
    autoSignin: (() => {
      const url = $('#f-autosignin-url').value.trim();
      if (!url) return null;
      const headers = {};
      for (const line of $('#f-autosignin-headers').value.split('\n')) {
        const i = line.indexOf(':');
        if (i <= 0) continue;
        const k = line.slice(0, i).trim();
        const v = line.slice(i + 1).trim();
        if (k) headers[k] = v;
      }
      return {
        enabled: $('#f-autosignin-enabled').checked,
        url,
        method: $('#f-autosignin-method').value,
        headers,
        body: $('#f-autosignin-body').value,
        expect: $('#f-autosignin-expect').value.trim()
      };
    })()
  };
  /* 星标和分类互不干涉：收藏分类 + 没勾星是合法组合（分在收藏组，但不在收藏栏），
     保存时不再强制把分类改回中转站 */
  if (!f.name) return toast('名称必填', 'bad');
  /* 防连点：新增时连点会建出多个服务，点下去就禁用，请求完恢复 */
  const saveBtn = $('#modal-save');
  if (saveBtn.disabled) return;
  saveBtn.disabled = true;
  const oldText = saveBtn.textContent;
  saveBtn.textContent = '保存中…';
  try {
    let r;
    const savedIdBefore = isEdit ? editingId : null;
    if (isEdit) r = await api(`/api/services/${editingId}`, { method: 'PUT', body: JSON.stringify(f) });
    else r = await api('/api/services', { method: 'POST', body: JSON.stringify(f) });
    closeModal();
    await loadAll();
    /* 保存微动画：平滑滑到刚保存的那张卡片并闪光提示（被筛选掉时找不到卡片就跳过） */
    const savedId = savedIdBefore || r?.id;
    const savedEl = savedId ? document.querySelector(`.card[data-id="${savedId}"]`) : null;
    if (savedEl) {
      savedEl.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
      savedEl.classList.add('card-flash');
      setTimeout(() => savedEl.classList.remove('card-flash'), 1500);
    }
    if (!isEdit) {
      toast(`已添加，记录新服务 +10⚡`, 'gold');
      if (r.unlocked && r.unlocked.length) { confetti(100); setTimeout(() => toast(`🏆 解锁成就：${r.unlocked.map((a) => `${a.icon} ${a.name}`).join('、')}`, 'gold'), 1200); }
    } else toast('已保存');
  } catch (err) { handleAuthErr(err); }
  finally { saveBtn.disabled = false; saveBtn.textContent = oldText; }
});

$('#pass-save').addEventListener('click', async () => {
  const o = $('#p-old').value, n = $('#p-new').value, n2 = $('#p-new2').value;
  if (n !== n2) return toast('两次新密码不一致', 'bad');
  const psBtn = $('#pass-save');
  if (psBtn.disabled) return;
  psBtn.disabled = true;
  try {
    await api('/api/password', { method: 'POST', body: JSON.stringify({ oldPassword: o, newPassword: n }) });
    $('#pass-overlay').classList.add('hidden');
    ['p-old', 'p-new', 'p-new2'].forEach((id) => { $('#' + id).value = ''; });
    toast('密码已修改');
  } catch (err) { handleAuthErr(err); }
  finally { psBtn.disabled = false; }
});

$('#btn-export').addEventListener('click', async () => {
  try {
    await api('/api/export-md', { method: 'POST' });
    toast('已导出到 服务台账.md');
  } catch (err) { handleAuthErr(err); }
});

$('#btn-backup').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = '/api/backup';
  a.download = `service-hub-backup-${todayStr()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  toast('备份已开始下载');
});
/* 从备份恢复：先在页面上确认，服务端还会先自动存一份当前数据 */
$('#btn-restore').addEventListener('click', () => $('#restore-file').click());
$('#restore-file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  let j;
  try { j = JSON.parse(await f.text()); } catch { toast('这个文件不是合法的 JSON', 'bad'); return; }
  const inner = j.data || j;
  const count = Array.isArray(inner.services) ? inner.services.length : 0;
  if (!count) { toast('备份文件里没有服务列表', 'bad'); return; }
  if (!confirm(`确定用这个备份恢复吗？会把现有 ${services.length} 个服务替换成备份里的 ${count} 个（当前数据会先自动备份到服务器，账号密码和机器人 Token 不变）。`)) return;
  try {
    const r = await api('/api/backup', { method: 'POST', body: JSON.stringify({ data: inner }) });
    await loadAll();
    toast(`已恢复，共 ${r.services} 个服务`);
  } catch (err) { handleAuthErr(err); }
});

/* ---------- CSV 批量导入 / 导出 ---------- */
/* CSV 解析：支持引号字段、字段内逗号/换行、"" 转义 */
function parseCSV(text) {
  const rows = [];
  let row = [], cur = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      rows.push(row); row = [];
    } else cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}
function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const CSV_COLS = ['name', 'url', 'category', 'account', 'secret', 'price', 'registeredAt', 'expiresAt', 'checkinFrequency', 'checkinEveryDays', 'renewDays', 'favorite', 'abnormal', 'notes'];
function servicesToCSV() {
  const lines = [CSV_COLS.join(',')];
  for (const s of services) {
    lines.push(CSV_COLS.map((c) => csvEscape(c === 'favorite' || c === 'abnormal' ? (s[c] ? 'true' : 'false') : (s[c] ?? ''))).join(','));
  }
  return '\uFEFF' + lines.join('\r\n'); // BOM：Excel 打开不乱码
}
/* CSV 表头 → 字段：中英文都认 */
const CSV_HEADERS = {
  name: ['name', '名称', '服务名', '服务'],
  url: ['url', '网址', '地址', '链接'],
  category: ['category', '分类'],
  account: ['account', '账号', '用户名'],
  secret: ['secret', '密码', '密钥'],
  price: ['price', '价格'],
  registeredAt: ['registeredat', '注册日期', '注册/购买日期', '开始时间', '注册'],
  expiresAt: ['expiresat', '到期日', '到期', '结束时间'],
  checkinFrequency: ['checkinfrequency', '签到频率', '频率'],
  checkinEveryDays: ['checkineverydays', '签到间隔', '间隔'],
  renewDays: ['renewdays', '续期周期', '周期'],
  favorite: ['favorite', '收藏'],
  abnormal: ['abnormal', '异常'],
  notes: ['notes', '备注', 'note']
};
function normHeader(h) { return String(h || '').trim().toLowerCase().replace(/[\s_/]/g, ''); }
function mapCSVRows(rows) {
  const header = rows[0].map(normHeader);
  const idx = {};
  for (const [field, names] of Object.entries(CSV_HEADERS)) {
    for (const n of names) {
      const i = header.indexOf(normHeader(n));
      if (i >= 0) { idx[field] = i; break; }
    }
  }
  const list = [];
  let skipped = 0;
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const get = (f) => (idx[f] === undefined ? '' : String(row[idx[f]] ?? '').trim());
    const name = get('name');
    if (!name) { skipped++; continue; }
    const catVal = get('category');
    let category = 'relay';
    if (catVal) {
      if (CATS[catVal]) category = catVal;
      else {
        const hit = Object.entries(CATS).find(([, c]) => c.label === catVal);
        if (hit) category = hit[0];
      }
    }
    const normDate = (v) => {
      const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(v);
      return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : '';
    };
    const boolVal = (v) => ['true', '1', '是', 'yes', 'y', '★'].includes(v.toLowerCase());
    const freq = get('checkinFrequency');
    list.push({
      name: name.slice(0, 100),
      url: get('url').slice(0, 500),
      category,
      account: get('account').slice(0, 500),
      secret: get('secret').slice(0, 500),
      price: get('price').slice(0, 500),
      registeredAt: normDate(get('registeredAt')),
      expiresAt: normDate(get('expiresAt')),
      checkinFrequency: (freq === 'daily' || freq === '每天') ? 'daily' : 'none',
      checkinEveryDays: Math.min(365, Math.max(1, parseInt(get('checkinEveryDays'), 10) || 1)),
      renewDays: Math.min(3650, Math.max(1, parseInt(get('renewDays'), 10) || 365)),
      favorite: boolVal(get('favorite')),
      abnormal: boolVal(get('abnormal')),
      notes: get('notes').slice(0, 500)
    });
  }
  return { list, skipped };
}
$('#btn-csv-export').addEventListener('click', () => {
  const blob = new Blob([servicesToCSV()], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `hubmate-services-${todayStr()}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(`已导出 ${services.length} 个服务为 CSV`);
});
$('#btn-csv-import').addEventListener('click', () => $('#csv-file').click());
/* v60：账号导出 CSV——服务名/账号名/账号/密码/备注，可直接导进 1Password、Bitwarden；
   文件里含密码，下载后妥善保管，别发给别人 */
$('#btn-acc-export').addEventListener('click', () => {
  const rows = [['服务', '账号名称', '账号', '密码', '网址', '备注']];
  let n = 0;
  for (const s of services) {
    for (const a of accountList(s)) {
      rows.push([s.name, a.label || '', a.username || '', a.password || '', s.url || '', a.notes || '']);
      n++;
    }
  }
  if (!n) { toast('还没录过账号', 'bad'); return; }
  const escCsv = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = '\uFEFF' + rows.map((r) => r.map(escCsv).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `hubmate-accounts-${todayStr()}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(`已导出 ${n} 个账号为 CSV（文件含密码，妥善保管）`);
});
$('#csv-file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  let text;
  try { text = await f.text(); } catch { toast('读不到这个文件', 'bad'); return; }
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // 去掉 BOM
  const rows = parseCSV(text);
  if (!rows.length) { toast('这个 CSV 是空的', 'bad'); return; }
  const { list, skipped } = mapCSVRows(rows);
  if (!list.length) { toast('这个 CSV 里没有能导入的服务（名称必填）', 'bad'); return; }
  const preview = list.slice(0, 5).map((s) => s.name).join('、');
  if (!confirm(`CSV 里共 ${rows.length - 1} 行数据，其中 ${list.length} 个有效${skipped ? `、${skipped} 个跳过（名称为空）` : ''}。\n前几个：${preview}${list.length > 5 ? '…' : ''}\n确定导入这 ${list.length} 个服务吗？只新增，不覆盖现有服务。`)) return;
  try {
    const r = await api('/api/services/import', { method: 'POST', body: JSON.stringify({ services: list }) });
    toast(`已导入 ${r.imported} 个服务${r.skipped ? `，跳过 ${r.skipped} 个` : ''}`);
    await loadAll();
  } catch (err) { handleAuthErr(err); }
});

/* ---------- 批量操作：勾选卡片，一次改分类或删除 ---------- */
let bulkMode = false;
const bulkSel = new Set();
function updateBulkCount() {
  const el = $('#bulk-count');
  if (el) el.textContent = bulkSel.size ? `已选 ${bulkSel.size} 个` : '还没选';
}
function setBulkMode(on) {
  bulkMode = on;
  if (!on) bulkSel.clear();
  $('#bulk-bar').classList.toggle('hidden', !on);
  $('#btn-bulk').textContent = on ? '☑️ 退出批量' : '☑️ 批量';
  if (on) {
    $('#bulk-cat').innerHTML = Object.entries(CATS).map(([id, c]) => `<option value="${id}">${esc(c.icon)} ${esc(c.label)}</option>`).join('');
  }
  updateBulkCount();
  renderGrid();
}
$('#btn-bulk').addEventListener('click', () => setBulkMode(!bulkMode));
$('#btn-bulk-exit').addEventListener('click', () => setBulkMode(false));
$('#btn-bulk-all').addEventListener('click', () => {
  const ids = [...document.querySelectorAll('#grid .card')].map((el) => el.dataset.id);
  const allSelected = ids.length && ids.every((id) => bulkSel.has(id));
  for (const id of ids) { if (allSelected) bulkSel.delete(id); else bulkSel.add(id); }
  document.querySelectorAll('#grid .bulk-check').forEach((cb) => { cb.checked = bulkSel.has(cb.dataset.bulkId); });
  updateBulkCount();
});
$('#btn-bulk-move').addEventListener('click', async () => {
  if (!bulkSel.size) { toast('先勾选要移动的服务', 'bad'); return; }
  const b = $('#btn-bulk-move');
  if (b.disabled) return;
  b.disabled = true;
  try {
    const r = await api('/api/services/bulk', { method: 'POST', body: JSON.stringify({ ids: [...bulkSel], action: 'category', category: $('#bulk-cat').value }) });
    bulkSel.clear();
    updateBulkCount();
    await loadAll();
    toast(`已移动 ${r.moved} 个服务`);
  } catch (err) { handleAuthErr(err); }
  finally { b.disabled = false; }
});
$('#btn-bulk-del').addEventListener('click', async () => {
  if (!bulkSel.size) { toast('先勾选要删除的服务', 'bad'); return; }
  if (!confirm(`确定删除选中的 ${bulkSel.size} 个服务？此操作不可撤销。`)) return;
  const b = $('#btn-bulk-del');
  if (b.disabled) return;
  b.disabled = true;
  try {
    const r = await api('/api/services/bulk', { method: 'POST', body: JSON.stringify({ ids: [...bulkSel], action: 'delete' }) });
    bulkSel.clear();
    updateBulkCount();
    await loadAll();
    toast(`已删除 ${r.deleted} 个服务`);
  } catch (err) { handleAuthErr(err); }
  finally { b.disabled = false; }
});
/* v59：批量编辑——签到间隔 / 续期周期，空着的字段不动 */
$('#btn-bulk-edit').addEventListener('click', async () => {
  if (!bulkSel.size) { toast('先勾选要改的服务', 'bad'); return; }
  const every = $('#bulk-every').value.trim();
  const renew = $('#bulk-renew').value.trim();
  if (!every && !renew) { toast('先填签到间隔或续期周期', 'bad'); return; }
  const b = $('#btn-bulk-edit');
  if (b.disabled) return;
  b.disabled = true;
  try {
    const r = await api('/api/services/bulk', { method: 'POST', body: JSON.stringify({ ids: [...bulkSel], action: 'edit', checkinEveryDays: every, renewDays: renew }) });
    $('#bulk-every').value = '';
    $('#bulk-renew').value = '';
    await loadAll();
    toast(`已更新 ${r.updated} 个服务`);
  } catch (err) { handleAuthErr(err); }
  finally { b.disabled = false; }
});

$('#btn-linkcheck').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = '检测中…';
  try {
    const r = await api('/api/linkcheck', { method: 'POST' });
    await loadAll();
    toast(r.dead ? `检测完成：${r.dead} 个疑似失效，已标在卡片上` : '检测完成：全部链接正常');
  } catch (err) { handleAuthErr(err); }
  btn.disabled = false;
  btn.textContent = '🔗 检测链接';
});

/* ---------- 重复清理：同名 / 同域名分组，删完自动重扫 ---------- */
let dupesScanned = false;
function dupDomain(u) {
  u = String(u || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try { return new URL(u).hostname.replace(/^www\./i, '').toLowerCase(); } catch { return ''; }
}
function scanDupes() {
  const box = $('#dupes-list');
  if (!box) return;
  dupesScanned = true;
  const byName = new Map(), byDom = new Map();
  for (const s of services) {
    const nk = s.name.trim().toLowerCase();
    if (nk) { if (!byName.has(nk)) byName.set(nk, []); byName.get(nk).push(s); }
    const dk = dupDomain(s.url);
    if (dk) { if (!byDom.has(dk)) byDom.set(dk, []); byDom.get(dk).push(s); }
  }
  const groups = [];
  for (const [k, v] of byName) if (v.length > 1) groups.push({ title: `同名：${k}`, list: v });
  for (const [k, v] of byDom) if (v.length > 1) groups.push({ title: `同域名：${k}`, list: v });
  if (!groups.length) { box.innerHTML = '<p class="muted">没有发现重复服务。</p>'; return; }
  box.innerHTML = groups.map((g) => `
    <div class="panel-head" style="margin-top:14px"><h3 style="font-size:15px">${esc(g.title)}</h3><span class="muted">${g.list.length} 个</span></div>
    ${g.list.map((s) => `<div class="landing-checkin-item"><span class="ck">♻️</span><span class="ck-name">${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.name)}</a>` : esc(s.name)}</span><span class="ck-note">${esc(CATS[s.category]?.label || s.category)} · ${esc(dupDomain(s.url) || '')}</span><button class="btn small ghost" data-act="edit" data-id="${s.id}">编辑</button><button class="btn small ghost" data-dup-del="${s.id}">删除</button></div>`).join('')}
  `).join('');
}
$('#btn-dup-scan').addEventListener('click', scanDupes);

/* 密码复用：同一个密码用在多个账号上就成一组（只统计已录进来的账号，空密码不算） */
let dupPwGroups = [];
function findDupPasswords() {
  const byPw = new Map();
  for (const s of services) {
    for (const a of accountList(s)) {
      const pw = (a.password || '').trim();
      if (!pw) continue;
      if (!byPw.has(pw)) byPw.set(pw, []);
      byPw.get(pw).push({ service: s.name, serviceId: s.id, label: a.label, username: a.username });
    }
  }
  return [...byPw.entries()].filter(([, list]) => list.length > 1)
    .map(([pw, list]) => ({ pw, list }))
    .sort((a, b) => b.list.length - a.list.length);
}
function renderPwReuse() {
  const box = $('#pwreuse-list');
  if (!box) return;
  dupPwGroups = findDupPasswords();
  const total = dupPwGroups.reduce((n, g) => n + g.list.length, 0);
  const badge = $('#pwreuse-nav-count');
  if (badge) badge.textContent = dupPwGroups.length ? dupPwGroups.length : '';
  $('#pwreuse-count').textContent = dupPwGroups.length ? `${dupPwGroups.length} 组重复 · 涉及 ${total} 个账号` : '';
  if (!dupPwGroups.length) { box.innerHTML = '<p class="muted">没有发现重复密码 ✓ 每个账号的密码都不一样，很安全。</p>'; return; }
  box.innerHTML = dupPwGroups.map((g, i) => `
    <div class="panel-head" style="margin-top:14px"><h3 style="font-size:15px">密码 <span class="acc-pw">••••••</span> <button class="btn small ghost" data-act="toggle-dup-pw" data-dup-idx="${i}">👁</button></h3><span class="muted">${g.list.length} 个账号在用</span></div>
    ${g.list.map((u) => `<div class="landing-checkin-item"><span class="ck">🔐</span><span class="ck-name">${esc(u.service)}</span><span class="ck-note">${esc(u.label)}${u.username ? ' · ' + esc(u.username) : ''}</span><button class="btn small ghost" data-act="edit" data-id="${u.serviceId}">编辑</button></div>`).join('')}
  `).join('');
}

/* 年度总结：今年的签到天数、总次数、签到攒的经验（每天首次 +5、全勤 +10，都记在 history 里）、
   最常签到的服务、收录数、收藏数 */
function renderYearReview() {
  const box = $('#year-list');
  if (!box) return;
  const y = String(new Date().getFullYear());
  const hist = meta.history || {};
  let days = 0, xp = 0;
  for (const [d, h] of Object.entries(hist)) {
    if (!d.startsWith(y + '-')) continue;
    if ((h.c || 0) > 0) days++;
    xp += (h.x || 0) + (h.all ? 10 : 0);
  }
  let totalCk = 0, top = null, topN = 0;
  for (const s of services) {
    const n = (s.checkins || []).filter((d) => d.startsWith(y + '-')).length;
    totalCk += n;
    if (n > topN) { topN = n; top = s; }
  }
  const favs = services.filter(isFav).length;
  $('#year-title').textContent = `📈 ${y} 年总结`;
  box.innerHTML = `
    <div class="year-grid">
      <div class="year-stat"><b>${days}</b><span>签到天数</span></div>
      <div class="year-stat"><b>${totalCk}</b><span>总签到次数</span></div>
      <div class="year-stat"><b>${xp}⚡</b><span>签到攒的经验</span></div>
      <div class="year-stat"><b>${top ? esc(top.name) : '—'}</b><span>最常签到${top ? `（${topN} 次）` : ''}</span></div>
      <div class="year-stat"><b>${services.length}</b><span>收录服务</span></div>
      <div class="year-stat"><b>${favs}</b><span>收藏</span></div>
    </div>`;
}
$('#dupes-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-dup-del]');
  if (!btn) return;
  const id = btn.dataset.dupDel;
  const svc = services.find((s) => s.id === id);
  if (!confirm(`确定删除「${svc ? svc.name : ''}」？删除后不可恢复。`)) return;
  btn.disabled = true;
  try {
    await api(`/api/services/${id}`, { method: 'DELETE' });
    await loadAll();
    toast('已删除');
  } catch (err) { handleAuthErr(err); }
  finally { btn.disabled = false; }
});

/* ---------- 分类管理：改名换图标直接在行内改，删完自动刷新 ---------- */
const BUILTIN_CAT_IDS = ['fav', 'checkin', 'relay', 'vps', 'game', 'domain', 'idle'];
/* 图标下拉的精选集：前 7 个是系统分类在用的，剩下的按用途排；
   当前图标不在集里时（比如以前手填的）会把它补到最前面，免得下拉显示空白 */
const ICON_OPTIONS = ['★', '📅', '🔀', '🖥️', '🎮', '🌐', '🧟', '💿', '📀', '💾', '🐧', '🛠️', '🔧', '⚙️', '🧰', '📦', '🌍', '🧭', '🔍', '📑', '📚', '📰', '🎬', '🎵', '📺', '🎨', '🖼️', '💰', '🛒', '🏦', '📧', '💬', '📱', '🔒', '🛡️', '🔑', '☁️', '🤖', '🚀', '⚡', '💻', '🎓', '💡', '📊', '📝', '🎁', '❤️', '⭐'];
function iconOptions(selected) {
  const opts = ICON_OPTIONS.includes(selected) ? ICON_OPTIONS : [selected, ...ICON_OPTIONS];
  return opts.map((ic) => `<option value="${esc(ic)}"${ic === selected ? ' selected' : ''}>${esc(ic)}</option>`).join('');
}
function renderCats() {
  const box = $('#cats-list');
  if (!box || !live()) return;
  const addSel = $('#c-icon');
  if (addSel) addSel.innerHTML = iconOptions(addSel.value || ICON_OPTIONS[0]);
  const counts = {};
  for (const s of services) counts[s.category] = (counts[s.category] || 0) + 1;
  box.innerHTML = Object.entries(CATS).map(([id, c]) => {
    const builtin = BUILTIN_CAT_IDS.includes(id);
    return `<div class="cat-row"><select class="cat-icon" data-id="${id}">${iconOptions(c.icon)}</select><input class="cat-name" data-id="${id}" value="${esc(c.label)}"><span class="muted">${counts[id] || 0} 个服务</span><button class="btn small ghost" data-cat-save="${id}">保存</button>${builtin ? '<span class="muted">系统分类</span>' : `<button class="btn small ghost" data-cat-del="${id}">删除</button>`}</div>`;
  }).join('');
}
$('#btn-cat-add').addEventListener('click', async () => {
  const label = $('#c-label').value.trim();
  const icon = $('#c-icon').value;
  if (!label) { toast('分类名不能为空', 'bad'); return; }
  const b = $('#btn-cat-add');
  if (b.disabled) return;
  b.disabled = true;
  try {
    await api('/api/categories', { method: 'POST', body: JSON.stringify({ label, icon }) });
    $('#c-label').value = '';
    $('#c-icon').value = ICON_OPTIONS[0];
    await loadAll();
    toast('分类已添加');
  } catch (err) { handleAuthErr(err); }
  finally { b.disabled = false; }
});
$('#cats-list').addEventListener('click', async (e) => {
  const saveBtn = e.target.closest('[data-cat-save]');
  const delBtn = e.target.closest('[data-cat-del]');
  const pressed = saveBtn || delBtn;
  if (pressed) pressed.disabled = true;
  try {
    if (saveBtn) {
      const id = saveBtn.dataset.catSave;
      const row = saveBtn.closest('.cat-row');
      await api(`/api/categories/${id}`, { method: 'PUT', body: JSON.stringify({ label: row.querySelector('.cat-name').value.trim(), icon: row.querySelector('.cat-icon').value }) });
      await loadAll();
      toast('已保存');
    } else if (delBtn) {
      const id = delBtn.dataset.catDel;
      const c = CATS[id];
      if (!confirm(`确定删除分类「${c ? c.label : ''}」？`)) return;
      await api(`/api/categories/${id}`, { method: 'DELETE' });
      await loadAll();
      toast('已删除');
    }
  } catch (err) { handleAuthErr(err); }
  finally { if (pressed) pressed.disabled = false; }
});

/* ESC 关闭所有弹窗 */
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  closeModal();
  $('#login-overlay').classList.add('hidden');
  $('#pass-overlay').classList.add('hidden');
});

/* 搜索防抖：每敲一下都全量重绘卡片是卡顿来源之一 */
let searchTimer = null;
$('#search').addEventListener('input', (e) => {
  q = e.target.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(renderGrid, 150);
});

/* ---------- 视觉特效 ---------- */
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* 主题切换（霓虹紫 / 深海蓝 / 翡翠绿），粒子、进度环、趋势图全部跟随 */
const THEMES = {
  neon: { particles: ['232,121,249', '34,211,238', '167,139,250'] },
  ocean: { particles: ['56,189,248', '34,211,238', '96,165,250'] },
  emerald: { particles: ['52,211,153', '163,230,53', '45,212,191'] },
  day: { particles: ['124,58,237', '8,145,178', '219,39,119'] }
};
let particleColors = THEMES.neon.particles;
/* 跟随系统：auto 时按 iOS 系统深色/浅色解析（浅色→day，深色→neon），系统切换时自动跟 */
function effectiveTheme(name) {
  if (name === 'auto') return window.matchMedia('(prefers-color-scheme: light)').matches ? 'day' : 'neon';
  return THEMES[name] ? name : 'neon';
}
let currentTheme = 'neon';
function applyTheme(name, save) {
  if (!THEMES[name] && name !== 'auto') name = 'neon';
  currentTheme = name;
  const eff = effectiveTheme(name);
  document.body.dataset.theme = eff;
  particleColors = THEMES[eff].particles;
  document.querySelectorAll('.theme-dot').forEach((d) => d.classList.toggle('on', d.dataset.theme === name));
  if (save) try { localStorage.setItem('sh-theme', name); } catch {}
  const cs = getComputedStyle(document.body);
  const g2 = cs.getPropertyValue('--g2').trim();
  const g3 = cs.getPropertyValue('--accent-2').trim();
  const stops = document.querySelectorAll('#ringGrad stop');
  if (stops[0] && g2) stops[0].setAttribute('stop-color', g2);
  if (stops[1] && g3) stops[1].setAttribute('stop-color', g3);
  /* 手机浏览器顶栏颜色跟主题走 */
  const themeColor = { neon: '#08040f', ocean: '#020a16', emerald: '#02120c', day: '#eef1f7' }[eff];
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta && themeColor) meta.setAttribute('content', themeColor);
  drawTrend();
}
window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  if (currentTheme === 'auto') applyTheme('auto', false);
});
document.querySelectorAll('.theme-dot').forEach((d) =>
  d.addEventListener('click', () => applyTheme(d.dataset.theme, true)));
applyTheme((() => { try { return localStorage.getItem('sh-theme'); } catch { return null; } })() || 'neon');

/* 日历订阅：链接就是本站 origin + /api/calendar.ics，复制后去 iPhone 日历里订阅 */
const calUrl = location.origin + '/api/calendar.ics';
const calUrlEl = document.getElementById('cal-url');
if (calUrlEl) calUrlEl.textContent = calUrl;
document.getElementById('btn-copy-cal')?.addEventListener('click', async () => { await copyText(calUrl); toast('订阅链接已复制'); });

/* v59：API 令牌（给 iOS 快捷指令用）——令牌只在生成那一刻显示一次，平时只告诉你有没有；
   令牌只放进内存变量，不存 localStorage，刷新页面就没了（要再看就重新生成） */
let apiTokenShown = '';
async function refreshApiTokenStatus() {
  if (!live()) return;
  try {
    const r = await api('/api/api-token/status');
    $('#apitoken-status').textContent = r.hasToken ? '已有令牌' : '还没生成令牌';
    $('#btn-apitoken-gen').textContent = r.hasToken ? '重新生成令牌' : '生成令牌';
  } catch { /* 未登录时不显示 */ }
}
function setApiTokenExample(tok) {
  const url = `${location.origin}/api/checkins/all?token=${tok}`;
  const curl = `curl -X POST "${location.origin}/api/checkins/all" -H "Authorization: Bearer ${tok}"`;
  const urlEl = $('#apitoken-url');
  if (urlEl) urlEl.textContent = url;
  const curlEl = $('#apitoken-curl');
  if (curlEl) curlEl.textContent = curl;
}
$('#btn-apitoken-gen')?.addEventListener('click', async () => {
  const b = $('#btn-apitoken-gen');
  if (b.disabled) return;
  b.disabled = true;
  try {
    const r = await api('/api/api-token', { method: 'POST' });
    apiTokenShown = r.token || '';
    $('#apitoken-value').textContent = apiTokenShown;
    $('#btn-copy-apitoken').disabled = !apiTokenShown;
    $('#apitoken-status').textContent = '已有令牌';
    b.textContent = '重新生成令牌';
    setApiTokenExample(apiTokenShown);
    toast('令牌已生成，只显示这一次，记得复制保存');
  } catch (err) { handleAuthErr(err); }
  finally { b.disabled = false; }
});
$('#btn-copy-apitoken')?.addEventListener('click', async () => {
  if (!apiTokenShown) return;
  await copyText(apiTokenShown);
  toast('令牌已复制');
});
$('#btn-apitoken-revoke')?.addEventListener('click', async () => {
  if (!confirm('确定作废这个令牌？作废后用它做的快捷指令就签不了到了。')) return;
  const b = $('#btn-apitoken-revoke');
  if (b.disabled) return;
  b.disabled = true;
  try {
    await api('/api/api-token/revoke', { method: 'POST' });
    apiTokenShown = '';
    $('#apitoken-value').textContent = '还没生成令牌';
    $('#btn-copy-apitoken').disabled = true;
    $('#apitoken-status').textContent = '还没生成令牌';
    $('#btn-apitoken-gen').textContent = '生成令牌';
    setApiTokenExample('你的令牌');
    toast('令牌已作废');
  } catch (err) { handleAuthErr(err); }
  finally { b.disabled = false; }
});
setApiTokenExample('你的令牌');

/* v60：二次验证——密钥只在生成那一刻显示一次，平时只告诉你开没开；
   启用要验一次动态码，关闭要密码 + 动态码双重确认 */
let totpSecretShown = '';
async function refreshTotpStatus() {
  if (!live()) return;
  try {
    const r = await api('/api/totp/status');
    $('#totp-status').textContent = r.enabled ? '已启用' : '未启用';
  } catch { /* 未登录时不显示 */ }
}
$('#btn-totp-setup')?.addEventListener('click', async () => {
  const b = $('#btn-totp-setup');
  if (b.disabled) return;
  b.disabled = true;
  try {
    const r = await api('/api/totp/setup', { method: 'POST' });
    totpSecretShown = r.secret || '';
    $('#totp-secret').textContent = totpSecretShown;
    $('#btn-copy-totp').disabled = !totpSecretShown;
    $('#totp-msg').textContent = '密钥已生成（只显示这一次）：在 Authenticator 里手动添加账号，密钥填上面那串；然后输一次动态码点“启用二次验证”。otpauth 链接：' + (r.otpauth || '');
    toast('密钥已生成，记得在手机里绑好');
  } catch (err) { handleAuthErr(err); }
  finally { b.disabled = false; }
});
$('#btn-copy-totp')?.addEventListener('click', async () => {
  if (!totpSecretShown) return;
  await copyText(totpSecretShown);
  toast('密钥已复制');
});
$('#btn-totp-enable')?.addEventListener('click', async () => {
  const code = $('#totp-code').value.trim();
  if (!/^\d{6}$/.test(code)) { toast('先输 6 位动态码', 'bad'); return; }
  const b = $('#btn-totp-enable');
  if (b.disabled) return;
  b.disabled = true;
  try {
    await api('/api/totp/enable', { method: 'POST', body: JSON.stringify({ code }) });
    $('#totp-status').textContent = '已启用';
    $('#totp-msg').textContent = '二次验证已启用。下次登录除了密码，还要输 Authenticator 里的动态码。';
    toast('二次验证已启用');
  } catch (err) { handleAuthErr(err); }
  finally { b.disabled = false; }
});
$('#btn-totp-disable')?.addEventListener('click', async () => {
  const code = $('#totp-code').value.trim();
  if (!/^\d{6}$/.test(code)) { toast('关掉二次验证也要输一次动态码', 'bad'); return; }
  const pw = prompt('请输入登录密码确认关闭二次验证：');
  if (!pw) return;
  const b = $('#btn-totp-disable');
  if (b.disabled) return;
  b.disabled = true;
  try {
    await api('/api/totp/disable', { method: 'POST', body: JSON.stringify({ password: pw, code }) });
    totpSecretShown = '';
    $('#totp-secret').textContent = '还没生成密钥';
    $('#btn-copy-totp').disabled = true;
    $('#totp-status').textContent = '未启用';
    $('#totp-msg').textContent = '二次验证已关闭。';
    toast('二次验证已关闭');
  } catch (err) { handleAuthErr(err); }
  finally { b.disabled = false; }
});

/* v60：GitHub 自动备份——Token 只存服务端，状态里不返回它 */
async function refreshGithubStatus() {
  if (!live()) return;
  try {
    const r = await api('/api/github-backup/status');
    $('#gh-repo').value = r.repo || '';
    $('#gh-branch').value = r.branch || 'main';
    $('#github-status').textContent = r.configured ? '已配置' : '未配置';
    $('#gh-msg').textContent = r.lastAt ? `上次备份：${r.lastAt} ${r.lastOk ? '✅ 成功' : `❌ 失败（${r.lastNote || ''}）`}` : '还没备份过。';
  } catch { /* 未登录时不显示 */ }
}
$('#btn-gh-save')?.addEventListener('click', async () => {
  const b = $('#btn-gh-save');
  if (b.disabled) return;
  b.disabled = true;
  try {
    const r = await api('/api/github-backup/save', { method: 'POST', body: JSON.stringify({ token: $('#gh-token').value.trim(), repo: $('#gh-repo').value.trim(), branch: $('#gh-branch').value.trim() }) });
    $('#gh-token').value = '';
    $('#github-status').textContent = r.configured ? '已配置' : '未配置';
    toast(r.configured ? '已保存，每天自动备份' : '已保存，还差 Token 或仓库');
    refreshGithubStatus();
  } catch (err) { handleAuthErr(err); }
  finally { b.disabled = false; }
});
$('#btn-gh-run')?.addEventListener('click', async () => {
  const b = $('#btn-gh-run');
  if (b.disabled) return;
  b.disabled = true;
  try {
    const r = await api('/api/github-backup/run', { method: 'POST' });
    toast(r.skipped ? '数据没变，不用推' : '已备份到 GitHub');
    refreshGithubStatus();
  } catch (err) { handleAuthErr(err); }
  finally { b.disabled = false; }
});

/* v61：多服务器同步——口令只在生成那一刻显示一次，平时只告诉你配没配 */
let syncTokenShown = '';
async function refreshSyncStatus() {
  if (!live()) return;
  try {
    const r = await api('/api/sync/config');
    $('#sync-peers').value = (r.peers || []).join('\n');
    $('#sync-status').textContent = r.configured ? '已配置' : '未配置';
    $('#sync-msg').textContent = r.lastAt ? `上次同步：${r.lastAt}（拉取 ${r.lastPulled} 次，推送 ${r.lastPushed} 次）` : '还没同步过。配好口令和对方地址后，启动时和每 5 分钟自动同步一次。';
  } catch { /* 未登录时不显示 */ }
}
$('#btn-sync-token')?.addEventListener('click', async () => {
  const b = $('#btn-sync-token');
  if (b.disabled) return;
  b.disabled = true;
  try {
    const r = await api('/api/sync/token', { method: 'POST' });
    syncTokenShown = r.token || '';
    $('#sync-token-value').textContent = syncTokenShown;
    $('#btn-copy-sync-token').disabled = !syncTokenShown;
    toast('同步口令已生成（只显示这一次），去其他服务器上填同一个口令');
  } catch (err) { handleAuthErr(err); }
  finally { b.disabled = false; }
});
$('#btn-copy-sync-token')?.addEventListener('click', async () => {
  if (!syncTokenShown) return;
  await copyText(syncTokenShown);
  toast('同步口令已复制');
});
$('#btn-sync-save')?.addEventListener('click', async () => {
  const b = $('#btn-sync-save');
  if (b.disabled) return;
  b.disabled = true;
  try {
    const r = await api('/api/sync/config', { method: 'POST', body: JSON.stringify({ token: $('#sync-token').value.trim(), peers: $('#sync-peers').value.split('\n').map((u) => u.trim()).filter(Boolean) }) });
    $('#sync-token').value = '';
    $('#sync-status').textContent = r.configured ? '已配置' : '未配置';
    toast(r.configured ? '已保存，启动时和每 5 分钟自动同步' : '已保存，还差同步口令或对方地址');
    refreshSyncStatus();
  } catch (err) { handleAuthErr(err); }
  finally { b.disabled = false; }
});
$('#btn-sync-run')?.addEventListener('click', async () => {
  const b = $('#btn-sync-run');
  if (b.disabled) return;
  b.disabled = true;
  try {
    const r = await api('/api/sync/run', { method: 'POST' });
    toast(r.pulled || r.pushed ? `同步完成：拉取 ${r.pulled} 次，推送 ${r.pushed} 次` : '数据已经是最新，不用同步');
    await loadAll();
    refreshSyncStatus();
  } catch (err) { handleAuthErr(err); }
  finally { b.disabled = false; }
});

/* 数字滚动 */
function countUp(el, val) {
  if (!el) return;
  const from = parseInt(el.textContent, 10) || 0;
  if (from === val || reduceMotion) { el.textContent = val; return; }
  const t0 = performance.now(), dur = 650;
  requestAnimationFrame(function step(t) {
    const p = Math.min(1, (t - t0) / dur);
    el.textContent = Math.round(from + (val - from) * (1 - Math.pow(1 - p, 3)));
    if (p < 1) requestAnimationFrame(step);
  });
}

/* 打字机（每日一句） */
let typeTimer = null;
function typewrite(el, text) {
  if (!el) return;
  clearInterval(typeTimer);
  if (reduceMotion) { el.textContent = text; return; }
  el.textContent = '';
  el.classList.add('typing');
  let i = 0;
  typeTimer = setInterval(() => {
    el.textContent = text.slice(0, ++i);
    if (i >= text.length) { clearInterval(typeTimer); setTimeout(() => el.classList.remove('typing'), 2000); }
  }, 45);
}

/* 签到趋势图（近 14 天柱状图，canvas 手绘，生长动画，随主题变色） */
function drawTrend() {
  const cv = document.getElementById('trend-chart');
  if (!cv || !services.length) return;
  const W = cv.clientWidth, H = cv.clientHeight;
  if (!W || !H) return;
  const dpr = window.devicePixelRatio || 1;
  cv.width = W * dpr; cv.height = H * dpr;
  const ctx = cv.getContext('2d');
  ctx.scale(dpr, dpr);
  const days = [], counts = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    days.push(key);
    counts.push(services.reduce((n, s) => n + ((s.checkins || []).includes(key) ? 1 : 0), 0));
  }
  const max = Math.max(1, ...counts);
  const cs = getComputedStyle(document.body);
  const g2 = cs.getPropertyValue('--g2').trim() || '#d946ef';
  const g3 = cs.getPropertyValue('--accent-2').trim() || '#22d3ee';
  const bw = W / 14, barW = Math.min(26, bw * .55), base = H - 16;
  const t0 = performance.now(), dur = 600;
  requestAnimationFrame(function tick(t) {
    const p = reduceMotion ? 1 : Math.min(1, (t - t0) / dur);
    const e2 = 1 - Math.pow(1 - p, 3);
    ctx.clearRect(0, 0, W, H);
    days.forEach((dkey, i) => {
      const h = Math.max(3, (counts[i] / max) * (H - 42) * e2);
      const x = i * bw + (bw - barW) / 2, y = base - h;
      const grad = ctx.createLinearGradient(0, y, 0, base);
      grad.addColorStop(0, i === 13 ? g3 : g2);
      grad.addColorStop(1, g3);
      ctx.globalAlpha = counts[i] ? .95 : .14;
      ctx.fillStyle = grad;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, y, barW, h, 5); else ctx.rect(x, y, barW, h);
      ctx.fill();
      ctx.globalAlpha = 1;
      if (p === 1) {
        if (counts[i]) {
          ctx.fillStyle = 'rgba(240,240,255,.8)';
          ctx.font = '600 10px sans-serif'; ctx.textAlign = 'center';
          ctx.fillText(counts[i], x + barW / 2, y - 5);
        }
        if (i % 3 === 1 || i === 13) {
          ctx.fillStyle = 'rgba(150,140,190,.65)';
          ctx.font = '9px sans-serif'; ctx.textAlign = 'center';
          ctx.fillText(`${+dkey.slice(5, 7)}/${+dkey.slice(8)}`, x + barW / 2, H - 3);
        }
      }
    });
    if (p < 1) requestAnimationFrame(tick);
  });
}
let trendTimer = null;
addEventListener('resize', () => {
  clearTimeout(trendTimer);
  trendTimer = setTimeout(drawTrend, 150);
});

/* 星空粒子（canvas，主题三色 + 邻近连线） */
(function starfield() {
  const cv = document.getElementById('fx');
  if (!cv || !heavyFx || reduceMotion) return;
  const ctx = cv.getContext('2d');
  let W, H, pts;
  function resize() {
    W = cv.width = innerWidth;
    H = cv.height = innerHeight;
    const n = Math.min(50, Math.floor(W * H / 30000));
    pts = Array.from({ length: n }, () => ({
      x: Math.random() * W, y: Math.random() * H,
      vx: (Math.random() - .5) * .35, vy: (Math.random() - .5) * .35,
      r: Math.random() * 1.8 + .6,
      ci: (Math.random() * 3) | 0
    }));
  }
  addEventListener('resize', resize);
  resize();
  requestAnimationFrame(function tick() {
    if (document.hidden) { requestAnimationFrame(tick); return; }
    ctx.clearRect(0, 0, W, H);
    for (const p of pts) {
      p.x += p.vx; p.y += p.vy;
      if (p.x < -20) p.x = W + 20; else if (p.x > W + 20) p.x = -20;
      if (p.y < -20) p.y = H + 20; else if (p.y > H + 20) p.y = -20;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, 7);
      ctx.fillStyle = `rgba(${particleColors[p.ci]},.55)`;
      ctx.fill();
    }
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const dx = pts[i].x - pts[j].x, dy = pts[i].y - pts[j].y;
        const d2 = dx * dx + dy * dy;
        if (d2 < 13000) {
          ctx.strokeStyle = `rgba(${particleColors[2]},${(1 - d2 / 13000) * .16})`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(pts[i].x, pts[i].y);
          ctx.lineTo(pts[j].x, pts[j].y);
          ctx.stroke();
        }
      }
    }
    requestAnimationFrame(tick);
  });
})();

/* 鼠标跟随光球（screen 混合模式，柔光扫过页面） */
(function cursorGlow() {
  const g = document.getElementById('cursor-glow');
  if (!g || !heavyFx || reduceMotion) return;
  let tx = innerWidth * .6, ty = innerHeight * .3, x = tx, y = ty;
  document.addEventListener('mousemove', (e) => { tx = e.clientX; ty = e.clientY; });
  requestAnimationFrame(function tick() {
    x += (tx - x) * .07; y += (ty - y) * .07;
    g.style.transform = `translate(${x - 160}px, ${y - 160}px)`;
    requestAnimationFrame(tick);
  });
})();

/* 按钮涟漪 */
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.btn, .chip, .nav-item');
  if (!btn || reduceMotion) return;
  const r = btn.getBoundingClientRect();
  const size = Math.max(r.width, r.height);
  const rip = document.createElement('span');
  rip.className = 'ripple';
  rip.style.width = rip.style.height = `${size}px`;
  rip.style.left = `${e.clientX - r.left - size / 2}px`;
  rip.style.top = `${e.clientY - r.top - size / 2}px`;
  btn.appendChild(rip);
  setTimeout(() => rip.remove(), 650);
});

/* 展示页回到顶部：滚过 600px 才出现，滚动监听用 rAF 节流 */
(function backToTop() {
  const btn = $('#landing-to-top');
  if (!btn) return;
  let ticking = false, lastY = scrollY;
  addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      const y = scrollY, goingUp = y < lastY;
      lastY = y;
      /* v47：只有往上滑才出现，往下滑阅读时藏起来，不压正文 */
      btn.classList.toggle('show', y > 600 && goingUp);
      ticking = false;
    });
  }, { passive: true });
  btn.addEventListener('click', () => scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' }));
})();

/* ---------- v47 面板说明折叠（手机） ---------- */
document.addEventListener('click', (e) => {
  const t = e.target.closest('.help-toggle');
  if (!t) return;
  const f = t.closest('.help-fold');
  if (!f) return;
  f.classList.toggle('open');
  t.textContent = f.classList.contains('open') ? '📖 说明 ▴' : '📖 说明 ▾';
});

/* ---------- v48 台账分类分组折叠（状态存浏览器） ---------- */
function loadCollapsedCats() {
  try { return new Set(JSON.parse(localStorage.getItem('hub-collapsed-cats') || '[]')); } catch { return new Set(); }
}
function saveCollapsedCats(set) {
  try { localStorage.setItem('hub-collapsed-cats', JSON.stringify([...set])); } catch {}
}
document.addEventListener('click', (e) => {
  const h = e.target.closest('#grid .sec-title');
  if (!h) return;
  const cards = h.nextElementSibling;
  if (!cards || !cards.classList.contains('cards')) return;
  const set = loadCollapsedCats();
  const nowCollapsed = cards.classList.toggle('hidden');
  h.classList.toggle('collapsed', nowCollapsed);
  const arrow = h.querySelector('.sec-arrow');
  if (arrow) arrow.textContent = nowCollapsed ? '▸' : '▾';
  if (nowCollapsed) set.add(h.dataset.cat); else set.delete(h.dataset.cat);
  saveCollapsedCats(set);
});

/* ---------- v48 弹窗更多设置折叠（手机） ---------- */
document.addEventListener('click', (e) => {
  const t = e.target.closest('.more-toggle');
  if (!t) return;
  const f = t.closest('.more-fold');
  if (!f) return;
  f.classList.toggle('open');
  t.textContent = f.classList.contains('open') ? '⚙️ 更多设置：签到与续期规则 ▴' : '⚙️ 更多设置：签到与续期规则 ▾';
});

/* ---------- 极简 Markdown 渲染（仅展示用，存的还是纯文本，老记事不用迁移） ----------
   顺序是关键：先转义 HTML，再把围栏代码块和行内代码抽成占位符（里面的 Markdown 不转），
   行内格式转完、按行分块后，最后把占位符还原。链接只放行 http(s)/mailto/#，其余只留文字 */
function renderMarkdown(src) {
  const codeBlocks = [], codeSpans = [];
  let text = esc(src);
  text = text.replace(/```([\s\S]*?)(?:```|$)/g, (_, code) => {
    let c = code;
    /* 开口 fence 同行的内容是语言标记（如 js），不是代码；换行后才是正文 */
    if (!c.startsWith('\n') && c.includes('\n')) c = c.slice(c.indexOf('\n') + 1);
    codeBlocks.push(c.replace(/^\n|\n$/g, ''));
    return `\u0000BLOCK${codeBlocks.length - 1}\u0000`;
  });
  text = text.replace(/`([^`\n]+)`/g, (_, code) => {
    codeSpans.push(code);
    return `\u0000SPAN${codeSpans.length - 1}\u0000`;
  });
  text = text.replace(/\*\*([^\n*]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/(^|[^\w*])\*([^\n*]+)\*/g, '$1<em>$2</em>');
  text = text.replace(/\[([^\]\n]+)\]\(([^)\s\n]+)\)/g, (_, t, u) => {
    return /^(https?:\/\/|mailto:|#)/i.test(u) ? `<a href="${u}" target="_blank" rel="noopener">${t}</a>` : t;
  });
  const lines = text.split('\n');
  let html = '', i = 0, para = [];
  const flushPara = () => { if (para.length) { html += `<p>${para.join('<br>')}</p>`; para = []; } };
  while (i < lines.length) {
    const line = lines[i];
    const block = line.match(/^\u0000BLOCK(\d+)\u0000$/);
    if (block) { flushPara(); html += `<pre><code>${codeBlocks[+block[1]]}</code></pre>`; i++; continue; }
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) { flushPara(); html += `<h${h[1].length}>${h[2]}</h${h[1].length}>`; i++; continue; }
    if (/^\s*---+\s*$/.test(line)) { flushPara(); html += '<hr>'; i++; continue; }
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      flushPara();
      const tag = ul ? 'ul' : 'ol';
      html += `<${tag}>`;
      while (i < lines.length) {
        const m = lines[i].match(ul ? /^\s*[-*+]\s+(.*)$/ : /^\s*\d+[.)]\s+(.*)$/);
        if (!m) break;
        html += `<li>${m[1]}</li>`;
        i++;
      }
      html += `</${tag}>`;
      continue;
    }
    const q = line.match(/^&gt;\s?(.*)$/); // > 已被 esc 转成 &gt;
    if (q) {
      flushPara();
      const buf = [];
      while (i < lines.length) {
        const m = lines[i].match(/^&gt;\s?(.*)$/);
        if (!m) break;
        buf.push(m[1]); i++;
      }
      html += `<blockquote>${buf.join('<br>')}</blockquote>`;
      continue;
    }
    if (!line.trim()) { flushPara(); i++; continue; }
    para.push(line); i++;
  }
  flushPara();
  html = html.replace(/\u0000BLOCK(\d+)\u0000/g, (_, k) => `<code>${codeBlocks[+k]}</code>`); // 行内围栏的兜底
  html = html.replace(/\u0000SPAN(\d+)\u0000/g, (_, k) => `<code>${codeSpans[+k]}</code>`);
  return html;
}
/* 摘要用：把 Markdown 标记剥掉，只剩纯文字，免得列表里露一堆 # * [ ] */
function stripMarkdown(s) {
  return String(s || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,3}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[^\w*])\*([^*]+)\*/g, '$1$2')
    .replace(/^---+\s*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ---------- 记事本（仅登录后）：新建 / 编辑 / 删除 / 搜索 ---------- */
let notes = [], noteEditingId = null, noteKw = '', noteExpandedId = null, noteDeleteArmedId = null, noteEditorDeleteArmed = false;
async function loadNotes() {
  try { notes = await api('/api/notes'); }
  catch { notes = []; }
  renderNotes();
}
function renderNotes() {
  const box = $('#notes-list');
  if (!box) return;
  const kw = noteKw.trim().toLowerCase();
  const list = notes.filter((n) => !kw || `${n.title || ''} ${n.content || ''}`.toLowerCase().includes(kw));
  const count = $('#notes-count');
  if (count) count.textContent = `共 ${notes.length} 条`;
  box.innerHTML = list.length
    ? list.map((n) => {
        const open = n.id === noteExpandedId;
        const body = n.content
          ? (open ? renderMarkdown(n.content) : esc(stripMarkdown(n.content)))
          : '<span class="muted">（空内容）</span>';
        /* 点一下只展开看全文，不进编辑；删除是页内二次确认，不再用系统弹框（有的手机浏览器弹不出来，点了等于没点） */
        const acts = (noteDeleteArmedId === n.id)
          ? `<button class="btn danger" data-note-act="del-confirm" data-id="${n.id}">确认删除？</button><button class="btn ghost" data-note-act="del-cancel" data-id="${n.id}">取消</button>`
          : `<button class="btn primary" data-note-act="edit" data-id="${n.id}">编辑</button><button class="btn danger" data-note-act="del" data-id="${n.id}">删除</button>`;
        const inner = open
          ? `<div class="note-full">${body}</div><div class="note-acts">${acts}</div>`
          : `<p class="note-snippet">${body}</p>`;
        return `<div class="note-item${open ? ' open' : ''}" data-id="${n.id}"><div class="note-head"><b>${esc(n.title) || '（无标题）'}</b><span class="note-time">${esc(n.updatedAt || n.createdAt || '')}</span></div>${inner}</div>`;
      }).join('')
    : (kw ? '<div class="empty">没有匹配的记事，换个关键词试试。</div>' : '<div class="empty">还没有记事，点「新建记事」写第一条。</div>');
  box.querySelectorAll('.note-item').forEach((el) => {
    el.addEventListener('click', () => {
      noteExpandedId = (noteExpandedId === el.dataset.id) ? null : el.dataset.id;
      renderNotes();
    });
  });
  box.querySelectorAll('[data-note-act]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.id, act = btn.dataset.noteAct;
      if (act === 'edit') openNoteEditor(id);
      else if (act === 'del') { noteDeleteArmedId = id; renderNotes(); }
      else if (act === 'del-confirm') requestDeleteNote(id);
      else if (act === 'del-cancel') { noteDeleteArmedId = null; renderNotes(); }
    });
  });
}
/* 页内二次确认后的真删除：不再用系统 confirm */
async function requestDeleteNote(id) {
  const btns = [...document.querySelectorAll(`[data-note-act="del-confirm"][data-id="${id}"]`)];
  const edBtn = $('#btn-note-del');
  if (edBtn) btns.push(edBtn);
  btns.forEach((b) => { b.disabled = true; });
  try {
    await api(`/api/notes/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (noteDeleteArmedId === id) noteDeleteArmedId = null;
    if (noteExpandedId === id) noteExpandedId = null;
    if (noteEditingId === id) closeNoteEditor();
    await loadNotes();
    toast('已删除');
  } catch (err) { toast('删除失败：' + (err.message || err)); }
  finally { btns.forEach((b) => { b.disabled = false; }); }
}
function resetNoteEditorDeleteArm() {
  noteEditorDeleteArmed = false;
  const btn = $('#btn-note-del');
  if (btn) btn.textContent = '删除这条';
}
function openNoteEditor(id) {
  const n = notes.find((x) => x.id === id);
  noteEditingId = id || null;
  $('#note-title').value = n ? (n.title || '') : '';
  $('#note-content').value = n ? (n.content || '') : '';
  $('#btn-note-del').style.display = n ? '' : 'none';
  resetNotePreview();
  resetNoteEditorDeleteArm();
  $('#note-editor').classList.remove('hidden');
  $('#note-editor').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'nearest' });
  $('#note-title').focus();
}
function closeNoteEditor() {
  noteEditingId = null;
  resetNotePreview();
  resetNoteEditorDeleteArm();
  $('#note-editor').classList.add('hidden');
}
$('#btn-note-new')?.addEventListener('click', () => openNoteEditor(null));
$('#btn-note-cancel')?.addEventListener('click', closeNoteEditor);
let noteSearchTimer = null;
$('#notes-search')?.addEventListener('input', (e) => {
  clearTimeout(noteSearchTimer);
  noteSearchTimer = setTimeout(() => { noteKw = e.target.value; renderNotes(); }, 150);
});
$('#btn-note-save')?.addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const title = $('#note-title').value, content = $('#note-content').value;
  if (!title.trim() && !content.trim()) { toast('标题和内容不能都空'); return; }
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = '保存中…';
  try {
    let saved;
    if (noteEditingId) saved = await api(`/api/notes/${encodeURIComponent(noteEditingId)}`, { method: 'PUT', body: JSON.stringify({ title, content }) });
    else saved = await api('/api/notes', { method: 'POST', body: JSON.stringify({ title, content }) });
    noteExpandedId = saved.id; // 保存完直接展开这一条，所见即所存
    await loadNotes();
    closeNoteEditor();
    toast('已保存');
  } catch (err) { toast('保存失败：' + (err.message || err)); }
  finally { btn.disabled = false; btn.textContent = old; }
});
$('#btn-note-del')?.addEventListener('click', () => {
  if (!noteEditingId) return;
  const btn = $('#btn-note-del');
  if (!noteEditorDeleteArmed) {
    noteEditorDeleteArmed = true;
    btn.textContent = '确认删除？';
    return;
  }
  requestDeleteNote(noteEditingId);
});

/* ---------- 记事工具栏：纯函数算新文本和新选区，调用处只负责读写 textarea ----------
   手机端点工具栏会让输入框失焦，所以选区平时就记下来（select/keyup/click/input），
   点按钮时先恢复选区再套格式；存的还是 Markdown，预览直接复用展开后的文章渲染 */
let noteSel = { start: 0, end: 0 };
const noteTaEl = $('#note-content');
['select', 'keyup', 'click', 'input'].forEach((ev) => noteTaEl?.addEventListener(ev, () => {
  noteSel = { start: noteTaEl.selectionStart ?? 0, end: noteTaEl.selectionEnd ?? 0 };
}));
function mdWrap(value, start, end, left, right) {
  const sel = value.slice(start, end);
  if (sel.startsWith(left) && sel.endsWith(right) && sel.length >= left.length + right.length) {
    return [value.slice(0, start) + sel.slice(left.length, -right.length) + value.slice(end), start, end - left.length - right.length];
  }
  return [value.slice(0, start) + left + sel + right + value.slice(end), start + left.length, end + left.length];
}
function mdLinePrefix(value, start, end, prefix) {
  const ls = value.lastIndexOf('\n', start - 1) + 1;
  let le = value.indexOf('\n', end);
  if (le === -1) le = value.length;
  const lines = value.slice(ls, le).split('\n');
  const allHave = lines.every((l) => l.startsWith(prefix));
  const next = lines.map((l) => (allHave ? l.slice(prefix.length) : prefix + l)).join('\n');
  return [value.slice(0, ls) + next + value.slice(le), ls, ls + next.length];
}
function mdHeading(value, start) {
  const ls = value.lastIndexOf('\n', start - 1) + 1;
  let le = value.indexOf('\n', start);
  if (le === -1) le = value.length;
  const line = value.slice(ls, le);
  const m = line.match(/^(#{1,3})\s+/);
  const next = m ? line.slice(m[0].length) : '# ' + line;
  return [value.slice(0, ls) + next + value.slice(le), ls, ls + next.length];
}
function mdLink(value, start, end) {
  const sel = value.slice(start, end);
  const text = sel || '链接文字';
  const ins = `[${text}](https://)`;
  const nv = value.slice(0, start) + ins + value.slice(end);
  const urlStart = start + 1 + text.length + 2; // '[' + 文字 + '](' 之后就是网址
  return [nv, urlStart, urlStart + 'https://'.length];
}
let notePreviewing = false;
function resetNotePreview() {
  notePreviewing = false;
  $('#note-content')?.classList.remove('hidden');
  $('#note-preview')?.classList.add('hidden');
  const pb = $('#btn-note-preview');
  if (pb) pb.textContent = '👁 预览';
}
document.querySelectorAll('#note-editor [data-md]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const ta = $('#note-content');
    if (!ta) return;
    ta.focus();
    ta.setSelectionRange(noteSel.start, noteSel.end);
    const v = ta.value, s = ta.selectionStart, e = ta.selectionEnd;
    const kind = btn.dataset.md;
    let r = null;
    if (kind === 'bold') r = mdWrap(v, s, e, '**', '**');
    else if (kind === 'italic') r = mdWrap(v, s, e, '*', '*');
    else if (kind === 'code') r = mdWrap(v, s, e, '`', '`');
    else if (kind === 'heading') r = mdHeading(v, s);
    else if (kind === 'list') r = mdLinePrefix(v, s, e, '- ');
    else if (kind === 'quote') r = mdLinePrefix(v, s, e, '> ');
    else if (kind === 'link') r = mdLink(v, s, e);
    if (!r) return;
    ta.value = r[0];
    ta.setSelectionRange(r[1], r[2]);
    noteSel = { start: r[1], end: r[2] };
    if (notePreviewing) $('#note-preview').innerHTML = renderMarkdown(ta.value);
  });
});
$('#btn-note-preview')?.addEventListener('click', () => {
  const ta = $('#note-content'), pv = $('#note-preview');
  if (!ta || !pv) return;
  notePreviewing = !notePreviewing;
  if (notePreviewing) {
    pv.innerHTML = ta.value ? renderMarkdown(ta.value) : '<span class="muted">（空内容）</span>';
    ta.classList.add('hidden');
    pv.classList.remove('hidden');
    $('#btn-note-preview').textContent = '✏️ 编辑';
  } else {
    resetNotePreview();
    ta.focus();
  }
});

/* 落地页搜索：输入防抖 150ms，只重绘落地页；输入框本身不在重绘区内，不会丢焦点 */
let landingSearchTimer = null;
$('#landing-search')?.addEventListener('input', () => {
  clearTimeout(landingSearchTimer);
  landingSearchTimer = setTimeout(renderLanding, 150);
});

/* 快捷键：/ 聚焦搜索 · N 新建服务 · C 一键全签 */
document.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (k !== '/' && k !== 'n' && k !== 'c') return;
  const tag = (document.activeElement || {}).tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (document.querySelector('.modal-mask:not(.hidden)')) return;
  if (k === '/') { e.preventDefault(); $('#search').focus(); }
  else if (k === 'n' && live()) { e.preventDefault(); openModal(null); }
  else if (k === 'c' && live()) { e.preventDefault(); $('#btn-check-all').click(); }
});

/* 卡片拖拽排序（登录后可用，顺序自动保存到服务端） */
let dragId = null;
const gridEl = document.getElementById('grid');
/* 批量勾选：卡片上的复选框只改本地选中集，不触发卡片其他行为 */
gridEl.addEventListener('change', (e) => {
  const cb = e.target.closest('.bulk-check');
  if (!cb) return;
  if (cb.checked) bulkSel.add(cb.dataset.bulkId); else bulkSel.delete(cb.dataset.bulkId);
  updateBulkCount();
});
gridEl.addEventListener('dragstart', (e) => {
  const c = e.target.closest('.card');
  if (!c || !live()) { e.preventDefault(); return; }
  dragId = c.dataset.id;
  c.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
});
gridEl.addEventListener('dragend', () => {
  dragId = null;
  gridEl.querySelectorAll('.dragging,.drag-over').forEach((x) => x.classList.remove('dragging', 'drag-over'));
});
gridEl.addEventListener('dragover', (e) => {
  if (!dragId) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const c = e.target.closest('.card');
  gridEl.querySelectorAll('.drag-over').forEach((x) => x.classList.remove('drag-over'));
  if (c && c.dataset.id !== dragId) c.classList.add('drag-over');
});
gridEl.addEventListener('drop', async (e) => {
  if (!dragId) return;
  e.preventDefault();
  const c = e.target.closest('.card');
  const from = services.findIndex((s) => s.id === dragId);
  gridEl.querySelectorAll('.dragging,.drag-over').forEach((x) => x.classList.remove('dragging', 'drag-over'));
  if (from < 0 || !c || c.dataset.id === dragId) { dragId = null; return; }
  const to = services.findIndex((s) => s.id === c.dataset.id);
  if (to < 0) { dragId = null; return; }
  const [moved] = services.splice(from, 1);
  services.splice(to, 0, moved);
  services.forEach((s, i) => { s.sortOrder = i; });
  dragId = null;
  renderAll();
  try {
    await api('/api/reorder', { method: 'POST', body: JSON.stringify({ ids: services.map((s) => s.id) }) });
    toast('排序已保存');
  } catch (err) { handleAuthErr(err); }
});

/* 卡片聚光灯 + 3D 倾斜（事件委托，兼容动态渲染）
   原来每次 mousemove 都全量查一遍 .card.is-tilting，改成只记上一张卡 + rAF 节流 */
let lastTiltCard = null, tiltQueued = false, lastMouse = null;
document.addEventListener('mousemove', (e) => {
  const glow = e.target.closest('.card, .stat, .ach');
  if (glow) {
    const r = glow.getBoundingClientRect();
    glow.style.setProperty('--mx', `${e.clientX - r.left}px`);
    glow.style.setProperty('--my', `${e.clientY - r.top}px`);
  }
  if (reduceMotion || !heavyFx) return;
  lastMouse = e;
  if (tiltQueued) return;
  tiltQueued = true;
  requestAnimationFrame(() => {
    tiltQueued = false;
    const ev = lastMouse;
    const card = ev.target.closest('.card');
    if (lastTiltCard && lastTiltCard !== card) {
      lastTiltCard.classList.remove('is-tilting');
      lastTiltCard.style.transform = '';
    }
    lastTiltCard = card;
    if (card) {
      const r = card.getBoundingClientRect();
      const rx = ((ev.clientY - r.top) / r.height - .5) * -5;
      const ry = ((ev.clientX - r.left) / r.width - .5) * 5;
      card.classList.add('is-tilting');
      card.style.transform = `translateY(-4px) perspective(750px) rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg)`;
    }
  });
});

/* ---------- 启动：先渲染公开预览，已有会话则无缝进入正式模式 ---------- */
(async function init() {
  try { await loadPreview(); } catch {}
  try { await loadAll(); } catch {}
})();
