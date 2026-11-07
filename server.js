/* 我的服务台 —— 零依赖 Node.js 服务（生产加固版）
   启动：node server.js（或双击 start.bat）
   数据：data/data.json，每次请求都会重新读取，手动改文件也能生效
   加固：安全响应头 + CSP、gzip 压缩、ETag 缓存、登录防爆破、
        健康检查、优雅退出、数据备份下载、静态目录防穿越 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { exec } = require('child_process');

const PORT = Number(process.env.PORT) || 7788;
const HOST = process.env.HOST || '0.0.0.0';
/* HOST=127.0.0.1 时说明前面有反代（nginx），信任它传来的真实 IP 与 HTTPS 标记；
   直接暴露 0.0.0.0 时不信任这些头，防伪造。也可用 TRUST_PROXY=1 强制开启 */
const TRUST_PROXY = HOST === '127.0.0.1' || process.env.TRUST_PROXY === '1';
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const PUBLIC_DIR = path.join(ROOT, 'public');
const LEDGER_FILE = path.join(ROOT, '服务台账.md');

/* 分类存在 data.json 里，可增删改；老数据没有该字段时先用默认 7 个，不写盘，
   等第一次增删改时再随那次写入一起落盘。id 一旦生成不再变，只改名/换图标。 */
const DEFAULT_CATEGORIES = [
  { id: 'fav', label: '收藏', icon: '★', cls: 't-fav' },
  { id: 'checkin', label: '每日签到', icon: '📅', cls: 't-checkin' },
  { id: 'relay', label: '中转站/API', icon: '🔀', cls: 't-relay' },
  { id: 'vps', label: 'VPS/服务器', icon: '🖥️', cls: 't-vps' },
  { id: 'game', label: '游戏', icon: '🎮', cls: 't-game' },
  { id: 'domain', label: '域名/订阅', icon: '🌐', cls: 't-domain' },
  { id: 'idle', label: '已闲置', icon: '🧟', cls: 't-idle' }
];
const BUILTIN_CATS = new Set(DEFAULT_CATEGORIES.map((c) => c.id));
function categoriesOf(data) {
  if (Array.isArray(data.categories) && data.categories.length) return data.categories;
  return DEFAULT_CATEGORIES;
}
function ensureCategories(data) {
  if (!Array.isArray(data.categories) || !data.categories.length) {
    data.categories = DEFAULT_CATEGORIES.map((c) => ({ ...c }));
  }
  return data.categories;
}
function normCat(c) {
  return { id: c.id, label: c.label, icon: c.icon || '🏷️', cls: c.cls || 't-custom' };
}
function cleanIcon(v) {
  return [...String(v || '')].slice(0, 2).join('').trim() || '🏷️';
}
const SESSION_MS = 30 * 86400 * 1000;
const GZIP_MIN = 1024; // 超过 1KB 且客户端支持时才压缩

/* ---------- 安全响应头（API 与静态文件统一加） ---------- */
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cross-Origin-Opener-Policy': 'same-origin'
};
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; " +
  "img-src 'self' data:; connect-src 'self'; font-src 'self'; " +
  "object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

/* ---------- 小工具 ---------- */
/* 全站日期统一按北京时间（UTC+8）算，不依赖服务器时区（instabox 是 UTC）。
   否则北京时间 0–8 点会错位：凌晨签到记到昨天、夜里消息显示昨天日期。 */
function cstNow() { return new Date(Date.now() + 8 * 3600e3); }
function cstHour() { return cstNow().getUTCHours(); }
function todayStr() {
  const d = cstNow();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
function cstDateTime() {
  const d = cstNow();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}
function nextDay(ds) {
  const [y, m, d] = ds.split('-').map(Number);
  const dt = new Date(y, m - 1, d + 1);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}
function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJSON(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(String(pw), salt, 32).toString('hex')}`;
}
function verifyPassword(pw, stored) {
  try {
    const [salt, hash] = String(stored).split(':');
    const check = crypto.scryptSync(String(pw), salt, 32).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(check, 'hex'));
  } catch { return false; }
}
function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => {
      buf += c;
      if (buf.length > 1e6) { reject(new Error('请求体过大')); req.destroy(); }
    });
    req.on('end', () => resolve(buf));
    req.on('error', reject);
  });
}
async function jsonBody(req) {
  try { return JSON.parse((await readBody(req)) || '{}'); } catch { return {}; }
}
function maybeGzip(req, headers, body) {
  if (body.length >= GZIP_MIN && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) {
    headers['Content-Encoding'] = 'gzip';
    headers['Vary'] = 'Accept-Encoding';
    return zlib.gzipSync(body);
  }
  return body;
}
function sendJSON(req, res, status, obj, headers) {
  const h = Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  }, SEC_HEADERS, headers || {});
  const body = maybeGzip(req, h, Buffer.from(JSON.stringify(obj), 'utf8'));
  res.writeHead(status, h);
  res.end(body);
}
/* 反代后取真实客户端 IP（仅信任代理模式） */
function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xff) return xff;
  }
  return req.socket.remoteAddress || '?';
}

/* ---------- 登录防爆破：每 IP 10 分钟最多 10 次尝试 ---------- */
const loginHits = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of loginHits) if (now > rec.resetAt) loginHits.delete(ip);
}, 60e3).unref();
function loginThrottled(ip) {
  const now = Date.now();
  let rec = loginHits.get(ip);
  if (!rec || now > rec.resetAt) { rec = { count: 0, resetAt: now + 10 * 60e3 }; loginHits.set(ip, rec); }
  rec.count++;
  return rec.count > 10;
}

/* ---------- 登录图形验证码（内置，无需第三方账号；答案只存服务端，一次性，5 分钟过期） ---------- */
const captchas = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [id, rec] of captchas) if (now > rec.expiresAt) captchas.delete(id);
}, 60e3).unref();
function makeCaptcha() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  const colors = ['#1e3a8a', '#7c2d12', '#14532d', '#581c87', '#991b1b'];
  const texts = [...code].map((ch, i) => {
    const x = 18 + i * 28, y = 28 + Math.floor(Math.random() * 8 - 4);
    const r = Math.floor(Math.random() * 36 - 18);
    return `<text x="${x}" y="${y}" font-size="26" font-weight="700" font-family="Arial, sans-serif" fill="${colors[Math.floor(Math.random() * colors.length)]}" transform="rotate(${r} ${x} ${y})">${ch}</text>`;
  }).join('');
  const lines = [0, 1, 2].map(() => {
    const y1 = Math.floor(Math.random() * 44), y2 = Math.floor(Math.random() * 44);
    return `<line x1="0" y1="${y1}" x2="130" y2="${y2}" stroke="#a5b4fc" stroke-width="1" opacity="0.7"/>`;
  }).join('');
  const dots = Array.from({ length: 24 }, () =>
    `<circle cx="${Math.floor(Math.random() * 130)}" cy="${Math.floor(Math.random() * 44)}" r="1.2" fill="#c7d2fe"/>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="130" height="44" viewBox="0 0 130 44"><rect width="130" height="44" fill="#ede9fe"/>${lines}${dots}${texts}</svg>`;
  const id = crypto.randomBytes(12).toString('hex');
  if (captchas.size > 500) { const first = captchas.keys().next().value; captchas.delete(first); }
  captchas.set(id, { code, expiresAt: Date.now() + 5 * 60e3 });
  return { id, svg };
}
function verifyCaptcha(id, answer) {
  if (!id || !answer) return false;
  const rec = captchas.get(id);
  captchas.delete(id); /* 无论对错都一次性作废，防止重放 */
  if (!rec || Date.now() > rec.expiresAt) return false;
  return String(answer).trim().toUpperCase() === rec.code;
}

/* ---------- 等级 ---------- */
const LEVELS = [
  { xp: 0, t: '初出茅庐' },
  { xp: 25, t: '签到学徒' },
  { xp: 60, t: '勤奋打工人' },
  { xp: 120, t: '白嫖达人' },
  { xp: 200, t: '资产管家' },
  { xp: 320, t: '羊毛大师' },
  { xp: 480, t: '资本新贵' },
  { xp: 700, t: '签到仙人' },
  { xp: 1000, t: '资产管理大亨' },
  { xp: 1500, t: '传说管理人' }
];
function levelOf(xp) {
  let i = 0;
  while (i + 1 < LEVELS.length && xp >= LEVELS[i + 1].xp) i++;
  const next = LEVELS[i + 1] || null;
  return {
    lv: i + 1,
    title: LEVELS[i].t,
    xp,
    nextXp: next ? next.xp : null,
    nextTitle: next ? next.t : null,
    progress: next ? Math.min(100, Math.round(((xp - LEVELS[i].xp) / (next.xp - LEVELS[i].xp)) * 100)) : 100
  };
}

/* ---------- 成就 ---------- */
const ACH_DEFS = [
  { id: 'first', icon: '🎉', name: '初次签到', desc: '完成人生第一次签到' },
  { id: 'all1', icon: '✅', name: '单日全勤', desc: '一天内签完所有每日签到服务' },
  { id: 'week', icon: '📅', name: '完美一周', desc: '连续 7 天天天全勤' },
  { id: 's7', icon: '🔥', name: '七日连签', desc: '单个服务连续签到 7 天' },
  { id: 's30', icon: '⚡', name: '三十连签', desc: '单个服务连续签到 30 天' },
  { id: 'night', icon: '🌙', name: '夜猫子', desc: '凌晨 0~5 点还在签到（隐藏成就）' },
  { id: 'c10', icon: '🗃️', name: '十件套', desc: '台账记录满 10 个服务' },
  { id: 'c30', icon: '🏦', name: '资产大户', desc: '台账记录满 30 个服务' },
  { id: 'xp100', icon: '💰', name: '百点家产', desc: '累计获得 100 点热情值' }
];
function maxRun(dates) {
  const s = [...new Set(dates)].sort();
  let best = 0, run = 0, prev = null;
  for (const d of s) {
    run = (prev && nextDay(prev) === d) ? run + 1 : 1;
    prev = d;
    if (run > best) best = run;
  }
  return best;
}
function dailyServices(data) {
  return data.services.filter((s) => s.checkinFrequency === 'daily' && s.category !== 'idle');
}
function ensureMeta(data) {
  let dirty = false;
  if (typeof data.xp !== 'number') { data.xp = 0; dirty = true; }
  if (!data.achievements || typeof data.achievements !== 'object') { data.achievements = {}; dirty = true; }
  if (!data.flags || typeof data.flags !== 'object') { data.flags = {}; dirty = true; }
  if (!data.history || typeof data.history !== 'object') {
    data.history = {};
    for (const s of data.services) {
      for (const d of (s.checkins || [])) {
        data.history[d] = data.history[d] || { c: 0 };
        data.history[d].c++;
      }
    }
    dirty = true;
  }
  return dirty;
}
function syncAchievements(data) {
  const unlocked = [];
  const award = (id) => {
    if (!data.achievements[id]) {
      data.achievements[id] = todayStr();
      data.xp += 10;
      unlocked.push(ACH_DEFS.find((a) => a.id === id));
    }
  };
  if (data.services.some((s) => (s.checkins || []).length)) award('first');
  const best = Math.max(0, ...data.services.map((s) => maxRun(s.checkins || [])));
  if (best >= 7) award('s7');
  if (best >= 30) award('s30');
  if (Object.values(data.history).some((h) => h && h.all)) award('all1');
  const allDays = Object.keys(data.history).filter((k) => data.history[k].all).sort();
  let run = 0, bestAll = 0, prev = null;
  for (const d of allDays) {
    run = (prev && nextDay(prev) === d) ? run + 1 : 1;
    prev = d;
    if (run > best) bestAll = run;
  }
  if (bestAll >= 7) award('week');
  if (data.flags.night) award('night');
  if (data.services.length >= 10) award('c10');
  if (data.services.length >= 30) award('c30');
  if (data.xp >= 100) award('xp100');
  return unlocked;
}
function metaPayload(data) {
  const t = todayStr();
  const daily = dailyServices(data);
  const best = Math.max(0, ...data.services.map((s) => maxRun(s.checkins || [])));
  return {
    username: data.username,
    xp: data.xp,
    level: levelOf(data.xp),
    passwordIsDefault: data.passwordIsDefault !== false,
    categories: categoriesOf(data).map(normCat),
    stats: {
      services: data.services.length,
      totalCheckins: data.services.reduce((n, s) => n + (s.checkins || []).length, 0),
      bestStreak: best,
      dailyTotal: daily.length,
      doneToday: daily.filter((s) => (s.checkins || []).includes(t)).length
    },
    achievements: ACH_DEFS.map((a) => ({ ...a, unlockedAt: data.achievements[a.id] || null })),
    history: data.history
  };
}
function publicServices(data) {
  return data.services.map((s) => ({
    id: s.id,
    name: s.name,
    category: s.category,
    url: s.url,
    registeredAt: s.registeredAt,
    expiresAt: s.expiresAt,
    price: s.price,
    checkinFrequency: s.checkinFrequency,
    checkinEveryDays: checkinEvery(s),
    renewDays: renewEvery(s),
    favorite: !!s.favorite,
    abnormal: !!s.abnormal,
    checkins: s.checkins || [],
    hasAccount: (Array.isArray(s.accounts) && s.accounts.length > 0) || !!s.account,
    visits: s.visits || 0,
    sortOrder: s.sortOrder ?? 0,
    notes: s.notes || ''
  }));
}

/* ---------- 数据 ---------- */
function loadData() {
  let data = readJSON(DATA_FILE, null);
  if (!data || !Array.isArray(data.services)) {
    data = {
      username: 'jason',
      passwordHash: hashPassword('jason123'),
      xp: 0,
      achievements: {},
      flags: {},
      history: {},
      services: [
        {
          id: crypto.randomBytes(12).toString('hex'),
          name: '示例 · 某签到中转站',
          category: 'checkin',
          url: 'https://example.com',
          account: 'jason',
          secret: '',
          registeredAt: '2026-10-20',
          expiresAt: '',
          price: '',
          checkinFrequency: 'daily',
          notes: '示例数据：签到送额度。在卡片上可以编辑或删除。',
          checkins: ['2026-10-25', '2026-10-26']
        },
        {
          id: crypto.randomBytes(12).toString('hex'),
          name: '示例 · 一台 VPS',
          category: 'vps',
          url: '',
          account: 'root',
          secret: '',
          registeredAt: '2026-01-10',
          expiresAt: '2026-11-03',
          price: '$10/年',
          checkinFrequency: 'none',
          notes: '示例数据：演示 7 天内到期提醒。',
          checkins: []
        }
      ]
    };
    writeJSON(DATA_FILE, data);
  }
  ensureMeta(data);
  /* 旧数据迁移：补齐排序与访问次数字段；单个账号迁成 accounts 数组 */
  let ndirty = false;
  data.services.forEach((s, i) => {
    if (typeof s.sortOrder !== 'number') { s.sortOrder = i; ndirty = true; }
    if (typeof s.visits !== 'number') { s.visits = 0; ndirty = true; }
    const snap = JSON.stringify([s.accounts, s.account, s.secret]);
    normalizeAccounts(s);
    if (JSON.stringify([s.accounts, s.account, s.secret]) !== snap) ndirty = true;
  });
  if (ndirty) writeJSON(DATA_FILE, data);
  return data;
}
function loadSessions() { return readJSON(SESSIONS_FILE, {}); }
function saveSessions(sessions) {
  const cutoff = Date.now() - SESSION_MS;
  for (const k of Object.keys(sessions)) if (sessions[k].created < cutoff) delete sessions[k];
  writeJSON(SESSIONS_FILE, sessions);
}
function currentUser(req) {
  const token = parseCookies(req.headers.cookie).session;
  if (!token) return null;
  const sessions = loadSessions();
  const rec = sessions[token];
  if (!rec || Date.now() - rec.created > SESSION_MS) return null;
  return { token, sessions };
}
/* ---------- 多账号：一个服务可存多个账号（名字/账号/密码/备注），其中一个是默认 ---------- */
function sanitizeAccount(a) {
  if (!a || typeof a !== 'object') return null;
  return {
    id: String(a.id || crypto.randomBytes(6).toString('hex')).slice(0, 32),
    label: String(a.label || '').trim().slice(0, 30) || '账号',
    username: String(a.username || '').trim().slice(0, 200),
    password: String(a.password || '').slice(0, 500),
    notes: String(a.notes || '').trim().slice(0, 200),
    isDefault: !!a.isDefault
  };
}
/* 归一化：accounts 数组是唯一事实来源；account/secret 只做默认账号的镜像（兼容旧代码、CSV、台账） */
function normalizeAccounts(svc) {
  if (!Array.isArray(svc.accounts)) svc.accounts = [];
  svc.accounts = svc.accounts.map(sanitizeAccount).filter(Boolean).slice(0, 20);
  if (!svc.accounts.length && (svc.account || svc.secret)) {
    svc.accounts.push({ id: crypto.randomBytes(6).toString('hex'), label: '默认', username: String(svc.account || ''), password: String(svc.secret || ''), notes: '', isDefault: true });
  }
  let def = svc.accounts.find((a) => a.isDefault);
  if (!def && svc.accounts.length) { svc.accounts[0].isDefault = true; def = svc.accounts[0]; }
  svc.accounts.forEach((a) => { if (a !== def) a.isDefault = false; });
  svc.account = def ? def.username : '';
  svc.secret = def ? def.password : '';
  return svc;
}
function pickFields(b, existing, catIds) {
  const out = {};
  if (typeof b.name === 'string') out.name = b.name.trim().slice(0, 100);
  if (b.category !== undefined) out.category = (catIds || []).includes(b.category) ? b.category : 'relay';
  if (b.checkinFrequency !== undefined) out.checkinFrequency = b.checkinFrequency === 'daily' ? 'daily' : 'none';
  if (b.checkinEveryDays !== undefined) out.checkinEveryDays = clampInt(b.checkinEveryDays, 1, 365, 1);
  if (b.renewDays !== undefined) out.renewDays = clampInt(b.renewDays, 1, 3650, 365);
  if (b.favorite !== undefined) out.favorite = !!b.favorite;
  if (b.abnormal !== undefined) out.abnormal = !!b.abnormal;
  /* 星标和分类互不干涉，只在一种情况下顺带点星：这次请求把分类“新选进”收藏
     （新建就是收藏分类，或原来不是收藏分类、这次改成了收藏分类），这样分类选收藏的
     服务会归拢进收藏栏。只改星标的请求、以及本来就是收藏分类的编辑，都尊重请求里的
     星标值，绝不强制改回、也绝不改分类 */
  if (b.category === 'fav' && (!existing || existing.category !== 'fav')) out.favorite = true;
  /* 多账号：传了 accounts 数组就用它（默认账号同步到 account/secret）；只传了旧式
     account/secret 就改默认账号（没有就新建一个）。account/secret 不再单独走下面的循环 */
  if (Array.isArray(b.accounts)) {
    out.accounts = b.accounts.map(sanitizeAccount).filter(Boolean).slice(0, 20);
    const def = out.accounts.find((a) => a.isDefault) || out.accounts[0];
    out.account = def ? def.username : '';
    out.secret = def ? def.password : '';
  } else if (b.account !== undefined || b.secret !== undefined) {
    const base = Array.isArray(existing?.accounts) ? existing.accounts.map(sanitizeAccount).filter(Boolean) : [];
    const acc = base.find((a) => a.isDefault) || base[0];
    const username = typeof b.account === 'string' ? b.account.trim().slice(0, 200) : (acc ? acc.username : '');
    const password = typeof b.secret === 'string' ? b.secret.slice(0, 500) : (acc ? acc.password : '');
    if (acc) {
      acc.username = username; acc.password = password;
      out.accounts = base;
    } else {
      out.accounts = [{ id: crypto.randomBytes(6).toString('hex'), label: '默认', username, password, notes: '', isDefault: true }];
    }
    out.account = username;
    out.secret = password;
  }
  for (const k of ['url', 'price', 'notes', 'registeredAt', 'expiresAt']) {
    if (typeof b[k] === 'string') out[k] = b[k].trim().slice(0, 500);
  }
  return out;
}

/* ---------- Telegram 通知（Bot API，零依赖；Token 只存 data.json，永不返回给前端） ---------- */
function notifyCfg(data) {
  if (!data.notify || typeof data.notify !== 'object') data.notify = {};
  return data.notify;
}
/* 提醒写回合并：只把本轮改过的日期字段合并到盘上最新数据里。
   Token、Chat ID 等其他设置绝不参与合并，免得把用户刚保存的新设置盖回去 */
function mergeNotifyWrites(fresh, n, prev) {
  const fn = notifyCfg(fresh);
  for (const k of ['lastExpiring', 'lastCheckin', 'lastCheckinRepeatAt']) {
    if (n[k] !== undefined && n[k] !== prev[k]) fn[k] = n[k];
  }
  return fresh;
}
function tgApiUrl(token, method) { return `https://api.telegram.org/bot${token}/${method}`; }
/* 签到提醒消息下的按钮：点一下直接签完，不用打开网站 */
const CHECKIN_KB = { inline_keyboard: [[{ text: '✅ 全部签到', callback_data: 'checkin_all' }]] };
async function tgSend(token, chatId, text, markup) {
  const payload = { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true };
  if (markup) payload.reply_markup = markup;
  const res = await fetch(tgApiUrl(token, 'sendMessage'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.description || `Telegram 返回 ${res.status}`);
  return j;
}
/* Telegram HTML 模式下服务名必须转义，否则名字里的 <>& 会破坏格式 */
function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
/* 日期加一年：2 月 29 日 → 次年 2 月 28 日，不会溢出到 3 月 */
function addYear(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y + 1, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) dt.setUTCDate(0);
  return dt.toISOString().slice(0, 10);
}
/* 日期加 N 天：按 UTC 日期算，不受服务器时区干扰 */
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * 86400e3).toISOString().slice(0, 10);
}
/* 整数钳制：非法值回 fallback */
function clampInt(v, lo, hi, fb) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fb;
}
/* 签到间隔（天）：默认 1 天；老数据没这个字段也按 1 天算 */
function checkinEvery(s) {
  return clampInt(s.checkinEveryDays, 1, 365, 1);
}
/* 续期周期（天）：默认 365 天；老数据没这个字段也按 365 天算 */
function renewEvery(s) {
  return clampInt(s.renewDays, 1, 3650, 365);
}
/* 两个日期相差天数（b - a），按 UTC 日期算 */
function dayDiff(a, b) {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400e3);
}
/* 今天该不该签：没签过就是到期；上次签到距今满间隔天数才到期 */
function checkinDue(s, t) {
  const c = (s.checkins || []).filter(Boolean).sort();
  if (!c.length) return true;
  return dayDiff(c[c.length - 1], t) >= checkinEvery(s);
}
/* 今日签到 cohort：今天到期 + 今天已签；N 天制下不该签的服务不计入今日；
   v53：标记异常的服务也不计入（不挡全勤、不进提醒），只在面板里红显 */
function checkinCohort(data, t) {
  return dailyServices(data).filter((s) => !s.abnormal && (checkinDue(s, t) || (s.checkins || []).includes(t)));
}
/* 与前端 daysUntil 同口径：按服务器本地日期算剩余天数 */
function daysUntilSrv(dateStr) {
  if (!dateStr) return null;
  const [y, m, d] = dateStr.split('-').map(Number);
  const [ty, tm, td] = todayStr().split('-').map(Number);
  return Math.round((new Date(y, m - 1, d) - new Date(ty, tm - 1, td)) / 86400e3);
}
function expiringList(data) {
  return data.services
    .filter((s) => s.expiresAt && daysUntilSrv(s.expiresAt) <= 30)
    .map((s) => ({ s, d: daysUntilSrv(s.expiresAt) }))
    .sort((a, b) => a.d - b.d);
}
/* 今日未签：只算今天到期的服务，不到期的不催；v53：标记异常的也不催、不参与一键全签 */
function unsignedDaily(data, t) {
  return dailyServices(data).filter((s) => !s.abnormal && checkinDue(s, t));
}
/* 单个签到的核心步骤（不含全勤奖励）：单签接口和批量签到共用，XP 口径不可能跑偏 */
function doCheckin(data, svc, t) {
  let xp = 0;
  if (!(svc.checkins || []).includes(t)) {
    svc.checkins = svc.checkins || [];
    svc.checkins.push(t);
    svc.checkins.sort();
    data.history[t] = data.history[t] || { c: 0 };
    data.history[t].c++;
    if (!data.history[t].x) { xp += 5; data.history[t].x = 5; } // 每天首次签到才给分，防反复签退刷分
    data.flags = data.flags || {};
    if (cstHour() < 5) data.flags.night = true;
  }
  return xp;
}
/* 全勤奖励：今日 cohort 全部签完且今天还没领过才给；不到期的服务不挡全勤 */
function allDoneBonus(data, t) {
  const cohort = checkinCohort(data, t);
  const allDone = cohort.length > 0 && cohort.every((s) => (s.checkins || []).includes(t));
  data.history[t] = data.history[t] || { c: 0 };
  if (allDone && !data.history[t].all) {
    data.history[t].all = true;
    return { allDone, bonus: 10 };
  }
  return { allDone, bonus: 0 };
}
/* 批量签到：把当天所有未签的每日服务一次签完，只写一次盘 */
/* 一键全签（不写盘）：给 Telegram 轮询用，由轮询最后统一做合并写回，避免中途整盘写回盖掉用户改动 */
function checkinAllTodayNoWrite(data) {
  const t = todayStr();
  const todo = unsignedDaily(data, t);
  let xpGained = 0;
  for (const svc of todo) xpGained += doCheckin(data, svc, t);
  const { allDone, bonus } = allDoneBonus(data, t);
  xpGained += bonus;
  data.xp = (data.xp || 0) + xpGained;
  const unlocked = syncAchievements(data);
  return { signed: todo.length, xpGained, allDone, unlocked, xp: data.xp, level: levelOf(data.xp) };
}
function checkinAllToday(data) {
  const r = checkinAllTodayNoWrite(data);
  writeJSON(DATA_FILE, data);
  return r;
}
/* 临期/签到两行文案的唯一来源：真实提醒与测试预览共用，版式不可能再跑偏 */
function expiringLines(items) {
  const lines = items.slice(0, 20).map(({ s, d }) => {
    const name = escHtml(s.name);
    if (d < 0) return `• <b>${name}</b> 服务已过期 ${-d} 天（${s.expiresAt}）`;
    if (d === 0) return `• <b>${name}</b> 服务今天到期（${s.expiresAt}）`;
    return `• <b>${name}</b> 服务即将到期，还剩 ${d} 天（${s.expiresAt}）`;
  });
  if (items.length > 20) lines.push(`…等共 ${items.length} 个临期服务`);
  return lines;
}
function checkinLines(todo) {
  const lines = todo.slice(0, 20).map((s) => `• <b>${escHtml(s.name)}</b>`);
  if (todo.length > 20) lines.push(`…等共 ${todo.length} 个`);
  return lines;
}
/* 每小时检查一次；北京时间 9 点后才发（默认，设置里可改），避开半夜与日期错位。
   每天每种最多发一次：没事可推时也记下日期，不空转；发送失败不记日期，下小时重试。
   注意：绝不在启动时立即发——每次部署都会重启服务，启动即发等于部署就骚扰一次。 */
async function runNotifyChecks() {
  try {
    const data = loadData();
    const n = notifyCfg(data);
    if (!n.token || !n.chatId) return;
    /* 记下本轮开始时的日期字段：写回时只合并本轮改过的，盘上更新的以盘上为准 */
    const prevNotify = { lastExpiring: n.lastExpiring, lastCheckin: n.lastCheckin, lastCheckinRepeatAt: n.lastCheckinRepeatAt };
    const pushHour = (n.pushHour === undefined ? 9 : n.pushHour);
    if (cstHour() < pushHour) return;
    const t = todayStr();
    let dirty = false;
    const tryPush = async (fn) => {
      try { await fn(); return true; }
      catch (e) { console.error('[!] TG 推送失败:', e.message); return false; }
    };
    if (n.expiring !== false && n.lastExpiring !== t) {
      const items = expiringList(data);
      let ok = true;
      if (items.length) {
        ok = await tryPush(() => tgSend(n.token, n.chatId,
          `⏰ <b>服务台临期提醒</b> · ${t}\n共 ${items.length} 个服务临期：\n\n${expiringLines(items).join('\n')}`));
      }
      if (ok) { n.lastExpiring = t; dirty = true; }
    }
    if (n.checkin !== false && n.lastCheckin !== t) {
      const todo = unsignedDaily(data, t);
      let ok = true;
      if (todo.length) {
        ok = await tryPush(() => tgSend(n.token, n.chatId,
          `⚡ <b>服务台签到提醒</b> · ${t}\n今日还有 ${todo.length} 个站未签到：\n\n${checkinLines(todo).join('\n')}\n\n👉 点下面按钮直接签完，别断了连签。`, CHECKIN_KB));
      }
      if (ok) { n.lastCheckin = t; n.lastCheckinRepeatAt = Date.now(); dirty = true; }
    }
    /* 签到重复提醒：固定提醒发完后，每隔 repeatHours 小时再查一次还有没有未签；
       只在固定时间到 23 点之间推，夜里不打扰；签完了自然停；锚点就是上面固定提醒的时间。 */
    if (n.checkin !== false && n.repeatHours > 0 && n.lastCheckin === t) {
      const todo = unsignedDaily(data, t);
      const h = cstHour();
      const last = n.lastCheckinRepeatAt || 0;
      if (todo.length && h >= pushHour && h < 23 && Date.now() - last >= n.repeatHours * 3600e3) {
        const okR = await tryPush(() => tgSend(n.token, n.chatId,
          `⚡ <b>服务台签到提醒（复查）</b> · ${t}\n今日还有 ${todo.length} 个站未签到：\n\n${checkinLines(todo).join('\n')}\n\n👉 点下面按钮直接签完，别断了连签。`, CHECKIN_KB));
        if (okR) { n.lastCheckinRepeatAt = Date.now(); dirty = true; }
      }
    }
    /* 写回前重读：这一小时里用户可能改过数据，只合并提醒自己改的日期字段 */
    if (dirty) writeJSON(DATA_FILE, mergeNotifyWrites(loadData(), n, prevNotify));
  } catch (e) { console.error('[!] TG 定时检查异常:', e.message); }
}
setInterval(runNotifyChecks, 3600e3).unref();

/* 机器人回话：每分钟拉一次 getUpdates，只回配置好的那个 Chat ID 发来的命令。
   注意这里永不传 offset（不确认消息），这样设置页的“自动获取 Chat ID”仍能取到消息；
   用 tgSeen 记已处理的最大 update_id 来去重，首次启动只记不回，避免对历史消息刷屏。 */
/* 轮询开始时快照：只记轮询自己会改的字段，写回时用来区分“轮询改的”与“用户改的” */
function snapshotPollState(data) {
  return {
    tgSeen: (data.notify || {}).tgSeen,
    checkins: new Map(data.services.map((s) => [s.id, JSON.stringify(s.checkins || [])])),
    history: JSON.parse(JSON.stringify(data.history || {})),
    xp: data.xp,
    achievements: JSON.parse(JSON.stringify(data.achievements || {})),
    flags: JSON.parse(JSON.stringify(data.flags || {})),
  };
}
/* 轮询写回合并：只把轮询自己改的字段合并到盘上最新数据里，其余一律以盘上为准；
   Token 等敏感字段绝不参与合并。签到用并集、计数用增量，免得互相盖掉 */
function mergePollWrites(cur, mutated, snap) {
  const cn = notifyCfg(cur);
  const mn = mutated.notify || {};
  if (mn.tgSeen !== undefined) cn.tgSeen = Math.max(cn.tgSeen || 0, mn.tgSeen);
  for (const s of mutated.services) {
    const before = snap.checkins.get(s.id);
    if (before !== undefined && JSON.stringify(s.checkins || []) !== before) {
      const cs = cur.services.find((x) => x.id === s.id);
      if (cs) cs.checkins = [...new Set([...(cs.checkins || []), ...(s.checkins || [])])].sort();
    }
  }
  const mh = mutated.history || {};
  cur.history = cur.history || {};
  for (const [k, v] of Object.entries(mh)) {
    if (JSON.stringify(v) !== JSON.stringify(snap.history[k])) {
      const base = cur.history[k] || {};
      const delta = (v.c || 0) - ((snap.history[k] && snap.history[k].c) || 0);
      cur.history[k] = { ...base, ...v, c: Math.max(0, (base.c || 0) + delta) };
    }
  }
  if (mutated.xp !== snap.xp) cur.xp = (cur.xp || 0) + (mutated.xp - snap.xp);
  const ma = mutated.achievements || {};
  cur.achievements = cur.achievements || {};
  for (const [k, v] of Object.entries(ma)) if (!(k in cur.achievements)) cur.achievements[k] = v;
  const mf = mutated.flags || {};
  cur.flags = cur.flags || {};
  for (const [k, v] of Object.entries(mf)) if (JSON.stringify(v) !== JSON.stringify(snap.flags[k])) cur.flags[k] = v;
  return cur;
}
async function pollBotCommands() {
  try {
    const data = loadData();
    const n = notifyCfg(data);
    if (!n.token || !n.chatId) return;
    /* 快照在先：后面网络往返期间用户可能改数据，写回时只合并轮询自己改的字段 */
    const snap = snapshotPollState(data);
    const res = await fetch(tgApiUrl(n.token, 'getUpdates'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
    });
    const j = await res.json().catch(() => ({}));
    if (!j.ok || !Array.isArray(j.result)) return;
    if (n.tgSeen === undefined) {
      n.tgSeen = j.result.reduce((m, u) => Math.max(m, u.update_id || 0), 0);
      writeJSON(DATA_FILE, mergePollWrites(loadData(), data, snap));
      return;
    }
    const fresh = j.result.filter((u) => (u.update_id || 0) > n.tgSeen);
    if (!fresh.length) return;
    const t = todayStr();
    for (const u of fresh) {
      n.tgSeen = Math.max(n.tgSeen, u.update_id || 0);
      /* 按钮回调：提醒消息下的“全部签到”被点了。用不写盘版批量签到，只改内存里的
         data 对象，最后统一做合并写回——签到结果不会丢，用户的同期改动也不会被盖掉 */
      const cb = u.callback_query;
      if (cb) {
        if (String(cb.from && cb.from.id) !== String(n.chatId)) continue;
        if (cb.data === 'checkin_all') {
          const r = checkinAllTodayNoWrite(data);
          await fetch(tgApiUrl(n.token, 'answerCallbackQuery'), {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ callback_query_id: cb.id, text: r.signed ? `已签到 ${r.signed} 个${r.xpGained ? `，+${r.xpGained}⚡` : ''}` : '今日已全部签完 ✓' })
          }).catch(() => {});
          const mid = cb.message && cb.message.message_id;
          if (mid) {
            await fetch(tgApiUrl(n.token, 'editMessageText'), {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: n.chatId, message_id: mid, text: `⚡ <b>服务台签到提醒</b> · ${t}\n今日已全部签到 ✓${r.signed ? `（刚才签了 ${r.signed} 个）` : ''}`, parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } })
            }).catch(() => {});
          }
        }
        continue;
      }
      const msg = u.message;
      if (!msg || String(msg.chat && msg.chat.id) !== String(n.chatId)) continue;
      const text = String(msg.text || '').trim();
      const send = (txt) => tgSend(n.token, n.chatId, txt).catch(() => {});
      if (text === '/start' || text === '/help') {
        await send(`🤖 <b>服务台机器人</b>\n/today 今日签到情况\n/expiring 临期服务列表`);
      } else if (text === '/today') {
        const cohort = checkinCohort(data, t);
        const done = cohort.filter((s) => (s.checkins || []).includes(t)).length;
        const todo = unsignedDaily(data, t);
        const body = todo.length
          ? `今日签到 ${done}/${cohort.length}，还有 ${todo.length} 个未签：\n\n${checkinLines(todo).join('\n')}`
          : `今日签到 ${done}/${cohort.length}，已全部签完 ✓`;
        if (todo.length) await tgSend(n.token, n.chatId, `⚡ <b>今日签到</b> · ${t}\n${body}`, CHECKIN_KB).catch(() => {});
        else await send(`⚡ <b>今日签到</b> · ${t}\n${body}`);
      } else if (text === '/expiring') {
        const items = expiringList(data);
        const body = items.length
          ? `共 ${items.length} 个服务临期：\n\n${expiringLines(items).join('\n')}`
          : '30 天内暂无临期服务';
        await send(`⏰ <b>临期服务</b> · ${t}\n${body}`);
      }
    }
    /* 写回前重读：这一分钟里用户可能改过数据，只合并轮询自己改的字段 */
    writeJSON(DATA_FILE, mergePollWrites(loadData(), data, snap));
  } catch (e) { console.error('[!] TG 命令轮询异常:', e.message); }
}
setInterval(pollBotCommands, 60e3).unref();

/* ---------- 死链检测：每 6 小时探一次，卡片上标疑似失效 ----------
   只认 HEAD 结果：2xx/3xx 正常；400/401/403/405/429/501 明显是防爬或不支持 HEAD，不冤枉它，算未知；
   其余 4xx/5xx、超时、DNS 失败算疑似失效。状态没变就不写文件，避免无意义刷数据。 */
function normLinkUrl(u) {
  u = String(u || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try { return new URL(u).toString(); } catch { return ''; }
}
async function probeLink(u) {
  const url = normLinkUrl(u);
  if (!url) return 'unknown';
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(8000) });
    if (res.status >= 200 && res.status < 400) return 'ok';
    if ([400, 401, 403, 405, 429, 501].includes(res.status)) return 'unknown';
    return 'dead';
  } catch { return 'dead'; }
}
async function checkLinks() {
  try {
    const data = loadData();
    const t = todayStr();
    const results = await Promise.all(data.services.map(async (s) => ({ id: s.id, st: await probeLink(s.url) })));
    /* 探活要等网络，期间用户可能改过数据：写回前重新读盘，只合并 linkStatus，
       绝不把探活开始时的整盘快照写回去盖掉别人的改动（删掉的服务跳过） */
    const fresh = loadData();
    let changed = false;
    for (const { id, st } of results) {
      const s = fresh.services.find((x) => x.id === id);
      if (s && s.linkStatus !== st) { s.linkStatus = st; s.linkCheckedAt = t; changed = true; }
    }
    if (changed) writeJSON(DATA_FILE, fresh);
    return {
      total: results.length,
      dead: results.filter((r) => r.st === 'dead').length,
      ok: results.filter((r) => r.st === 'ok').length,
      unknown: results.filter((r) => r.st === 'unknown').length,
      changed
    };
  } catch (e) { console.error('[!] 链接检测异常:', e.message); return null; }
}
setInterval(() => { checkLinks(); }, 6 * 3600e3).unref();
setTimeout(() => { checkLinks(); }, 30e3).unref(); // 启动 30 秒后先探一轮，卡片不用等 6 小时

/* ---------- 导出 Markdown 台账 ---------- */
const mdCell = (v) => String(v ?? '').replace(/\|/g, '/').replace(/\r?\n/g, ' ');
function ledgerMarkdown(data) {
  const titles = {
    fav: '★ 收藏',
    checkin: '📅 每日签到类',
    relay: '🔀 中转站 / API 站点',
    vps: '🖥️ VPS / 服务器',
    game: '🎮 游戏相关（游戏机 / 平台 / 订阅）',
    domain: '🌐 域名 / 其他订阅',
    idle: '🧟 已闲置 / 忘了干嘛的'
  };
  let md = `# 🗂️ 我的服务台账\n\n> 由「服务台」系统自动导出于 ${todayStr()}。请勿手改本文件——在系统里增删后点「导出台账」即可刷新。\n> 系统地址：http://127.0.0.1:${PORT}\n`;
  for (const c of categoriesOf(data)) {
    const list = data.services.filter((s) => s.category === c.id);
    md += `\n## ${titles[c.id] || `${c.icon} ${c.label}`}（${list.length}）\n\n`;
    if (!list.length) { md += '（暂无）\n'; continue; }
    md += '| 名称 | 网址/地址 | 账号 | 注册/购买 | 到期 | 签到 | 备注 |\n|---|---|---|---|---|---|---|\n';
    for (const s of list) {
      const ci = s.checkinFrequency === 'daily'
        ? (s.checkins.length ? `已签 ${s.checkins.length} 次` : '未签')
        : '—';
      md += `| ${mdCell(s.name)} | ${mdCell(s.url)} | ${mdCell(s.account)} | ${mdCell(s.registeredAt)} | ${mdCell(s.expiresAt)} | ${ci} | ${mdCell(s.notes)} |\n`;
    }
  }
  return md + '\n';
}

/* ---------- API ---------- */
async function handleAPI(req, res, pathname) {
  const send = (status, obj, headers) => sendJSON(req, res, status, obj, headers);

  /* 健康检查（监控/探活用，无需登录） */
  if (pathname === '/api/healthz' && req.method === 'GET') {
    return send(200, { ok: true, uptime: Math.round(process.uptime()) });
  }

  if (pathname === '/api/captcha' && req.method === 'GET') {
    return send(200, makeCaptcha());
  }

  if (pathname === '/api/login' && req.method === 'POST') {
    const ip = clientIp(req);
    if (loginThrottled(ip)) {
      console.warn(`[!] 登录过于频繁，已临时封禁：${ip}`);
      return send(429, { error: '尝试太频繁，请 10 分钟后再试' });
    }
    const body = await jsonBody(req);
    /* 先验验证码、再验密码：验证码不对时不碰密码，避免给爆破留口子 */
    if (!verifyCaptcha(body.captchaId, body.captcha)) {
      return send(400, { error: '验证码不对或已过期，请重新输入' });
    }
    const data = loadData();
    if (body.username !== data.username || !verifyPassword(body.password, data.passwordHash)) {
      return send(401, { error: '用户名或密码不对' });
    }
    const token = crypto.randomBytes(32).toString('hex');
    const sessions = loadSessions();
    sessions[token] = { created: Date.now() };
    saveSessions(sessions);
    /* 反代 + HTTPS 时给 Cookie 加 Secure */
    const secure = TRUST_PROXY && String(req.headers['x-forwarded-proto'] || '').includes('https');
    return send(200, { ok: true, username: data.username }, {
      'Set-Cookie': `session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_MS / 1000}${secure ? '; Secure' : ''}`
    });
  }

  if (pathname === '/api/public' && req.method === 'GET') {
    const data = loadData();
    const unlocked = syncAchievements(data);
    if (unlocked.length) writeJSON(DATA_FILE, data);
    const payload = metaPayload(data);
    payload.services = publicServices(data);
    return send(200, payload);
  }

  const auth = currentUser(req);
  if (!auth) return send(401, { error: '未登录' });

  /* ---------- 记事本：仅登录后可用，不进公开接口、不上落地页 ---------- */
  if (pathname === '/api/notes' && req.method === 'GET') {
    const data = loadData();
    return send(200, (data.notes || []).slice().sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')));
  }
  if (pathname === '/api/notes' && req.method === 'POST') {
    const data = loadData();
    const b = await jsonBody(req);
    const title = String(b.title || '').trim().slice(0, 100);
    const content = String(b.content || '').trim().slice(0, 20000);
    if (!title && !content) return send(400, { error: '标题和内容不能都空' });
    const now = cstDateTime();
    const note = { id: crypto.randomBytes(12).toString('hex'), title, content, createdAt: now, updatedAt: now };
    data.notes = data.notes || [];
    data.notes.unshift(note);
    writeJSON(DATA_FILE, data);
    return send(200, note);
  }
  if (pathname.startsWith('/api/notes/') && (req.method === 'PUT' || req.method === 'DELETE')) {
    const id = decodeURIComponent(pathname.slice('/api/notes/'.length));
    const data = loadData();
    const note = (data.notes || []).find((n) => n.id === id);
    if (!note) return send(404, { error: '找不到这条记事' });
    if (req.method === 'DELETE') {
      data.notes = data.notes.filter((n) => n.id !== id);
      writeJSON(DATA_FILE, data);
      return send(200, { ok: true });
    }
    const b = await jsonBody(req);
    const title = String(b.title || '').trim().slice(0, 100);
    const content = String(b.content || '').trim().slice(0, 20000);
    if (!title && !content) return send(400, { error: '标题和内容不能都空' });
    note.title = title; note.content = content; note.updatedAt = cstDateTime();
    writeJSON(DATA_FILE, data);
    return send(200, note);
  }

  if (pathname === '/api/me' && req.method === 'GET') {
    return send(200, { username: loadData().username });
  }
  if (pathname === '/api/logout' && req.method === 'POST') {
    delete auth.sessions[auth.token];
    saveSessions(auth.sessions);
    return send(200, { ok: true }, { 'Set-Cookie': 'session=; HttpOnly; Path=/; Max-Age=0' });
  }
  if (pathname === '/api/password' && req.method === 'POST') {
    const body = await jsonBody(req);
    const data = loadData();
    if (!verifyPassword(body.oldPassword, data.passwordHash)) return send(400, { error: '旧密码不对' });
    if (!body.newPassword || String(body.newPassword).length < 6) return send(400, { error: '新密码至少 6 位' });
    data.passwordHash = hashPassword(body.newPassword);
    data.passwordIsDefault = false;
    writeJSON(DATA_FILE, data);
    return send(200, { ok: true });
  }
  /* Telegram 通知设置：Token 永不返回给前端，留空表示不改 */
  if (pathname === '/api/notify' && req.method === 'GET') {
    const n = notifyCfg(loadData());
    return send(200, {
      configured: !!(n.token && n.chatId),
      chatId: n.chatId || '',
      expiring: n.expiring !== false,
      checkin: n.checkin !== false,
      pushHour: (n.pushHour === undefined ? 9 : n.pushHour),
      repeatHours: (n.repeatHours === undefined ? 0 : n.repeatHours),
      lastExpiring: n.lastExpiring || '',
      lastCheckin: n.lastCheckin || ''
    });
  }
  if (pathname === '/api/notify' && req.method === 'POST') {
    const body = await jsonBody(req);
    const data = loadData();
    const n = notifyCfg(data);
    if (typeof body.token === 'string' && body.token.trim()) n.token = body.token.trim().slice(0, 200);
    if (typeof body.chatId === 'string' && body.chatId.trim()) n.chatId = body.chatId.trim().slice(0, 64);
    if (body.expiring !== undefined) n.expiring = !!body.expiring;
    if (body.checkin !== undefined) n.checkin = !!body.checkin;
    if (body.pushHour !== undefined && body.pushHour !== '') {
      const h = Math.trunc(Number(body.pushHour));
      if (Number.isFinite(h)) n.pushHour = Math.min(23, Math.max(0, h));
    }
    if (body.repeatHours !== undefined && body.repeatHours !== '') {
      const rh = Math.trunc(Number(body.repeatHours));
      if (Number.isFinite(rh)) n.repeatHours = Math.min(24, Math.max(0, rh));
    }
    writeJSON(DATA_FILE, data);
    return send(200, { ok: true, configured: !!(n.token && n.chatId) });
  }
  if (pathname === '/api/notify/test' && req.method === 'POST') {
    const data = loadData();
    const n = notifyCfg(data);
    if (!n.token || !n.chatId) return send(400, { error: '还没设置 Token 或 Chat ID' });
    const t = todayStr();
    const cohort = checkinCohort(data, t);
    const done = cohort.filter((s) => (s.checkins || []).includes(t)).length;
    const items = expiringList(data);
    const todo = unsignedDaily(data, t);
    const expPreview = items.length
      ? `⏰ <b>临期预览</b>（${items.length} 个）：\n${expiringLines(items).join('\n')}`
      : '⏰ <b>临期预览</b>：30 天内暂无临期服务';
    const ckPreview = todo.length
      ? `⚡ <b>签到预览</b>（${todo.length} 个未签）：\n${checkinLines(todo).join('\n')}`
      : '⚡ <b>签到预览</b>：今日已全部签到';
    try {
      await tgSend(n.token, n.chatId,
        `✅ <b>服务台通知测试成功</b> · ${t}\n今日签到 ${done}/${cohort.length} · 30 天内临期 ${items.length} 个\n\n${expPreview}\n\n${ckPreview}\n\n上面就是每天早上会收到的提醒版式。${todo.length ? '（下面这个按钮是真的，点一下就签完了。）' : ''}`, todo.length ? CHECKIN_KB : undefined);
      return send(200, { ok: true });
    } catch (e) { return send(400, { error: `发送失败：${e.message}` }); }
  }
  /* 手动触发链接检测（登录后可用） */
  if (pathname === '/api/linkcheck' && req.method === 'POST') {
    const r = await checkLinks();
    if (!r) return send(400, { error: '检测失败' });
    return send(200, r);
  }
  /* 分类管理：系统分类不能删，删自定义分类会把旗下服务移到中转站 */
  if (pathname === '/api/categories' && req.method === 'POST') {
    const body = await jsonBody(req);
    const data = loadData();
    const cats = ensureCategories(data);
    const label = String(body.label || '').trim().slice(0, 20);
    if (!label) return send(400, { error: '分类名不能为空' });
    if (cats.some((c) => c.label.toLowerCase() === label.toLowerCase())) return send(400, { error: '已经有同名分类了' });
    const cat = { id: 'c' + crypto.randomBytes(4).toString('hex'), label, icon: cleanIcon(body.icon), cls: 't-custom' };
    cats.push(cat);
    writeJSON(DATA_FILE, data);
    return send(200, { ok: true, category: cat });
  }
  const cm = pathname.match(/^\/api\/categories\/([A-Za-z0-9_-]+)$/);
  if (cm && req.method === 'PUT') {
    const body = await jsonBody(req);
    const data = loadData();
    const cats = ensureCategories(data);
    const cat = cats.find((c) => c.id === cm[1]);
    if (!cat) return send(404, { error: '找不到该分类' });
    const label = String(body.label || '').trim().slice(0, 20);
    if (!label) return send(400, { error: '分类名不能为空' });
    if (cats.some((c) => c.id !== cat.id && c.label.toLowerCase() === label.toLowerCase())) return send(400, { error: '已经有同名分类了' });
    cat.label = label;
    if (body.icon !== undefined) cat.icon = cleanIcon(body.icon);
    writeJSON(DATA_FILE, data);
    return send(200, { ok: true, category: cat });
  }
  if (cm && req.method === 'DELETE') {
    if (BUILTIN_CATS.has(cm[1])) return send(400, { error: '系统分类不能删除' });
    const data = loadData();
    const cats = ensureCategories(data);
    const idx = cats.findIndex((c) => c.id === cm[1]);
    if (idx < 0) return send(404, { error: '找不到该分类' });
    /* 非空分类不让删：先把旗下服务编辑到其他分类，免得删完不知去向 */
    const used = data.services.filter((s) => s.category === cm[1]).length;
    if (used) return send(400, { error: `该分类下还有 ${used} 个服务，请先把它们编辑到其他分类后再删除` });
    cats.splice(idx, 1);
    writeJSON(DATA_FILE, data);
    return send(200, { ok: true });
  }
  /* 自动取 Chat ID：用户先给机器人发 /start，这里取最近一条消息的发送者 */
  if (pathname === '/api/notify/resolve' && req.method === 'POST') {
    const data = loadData();
    const n = notifyCfg(data);
    if (!n.token) return send(400, { error: '请先保存 Token' });
    try {
      const res = await fetch(tgApiUrl(n.token, 'getUpdates'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
      });
      const j = await res.json().catch(() => ({}));
      if (!j.ok) throw new Error(j.description || 'Telegram 返回错误');
      const updates = (j.result || []).filter((u) => u.message && u.message.chat && u.message.chat.id);
      if (!updates.length) return send(400, { error: '没找到消息，请先给机器人发一条 /start 再试' });
      n.chatId = String(updates[updates.length - 1].message.chat.id);
      writeJSON(DATA_FILE, data);
      return send(200, { ok: true, chatId: n.chatId });
    } catch (e) { return send(400, { error: `获取失败：${e.message}` }); }
  }
  if (pathname === '/api/export-md' && req.method === 'POST') {
    fs.writeFileSync(LEDGER_FILE, ledgerMarkdown(loadData()), 'utf8');
    return send(200, { ok: true, file: '服务台账.md' });
  }
  /* 一键备份：下载完整数据，但密码哈希和机器人 Token 绝不外带；
     恢复时这两项永远沿用当前值，旧版原始备份也能照常恢复 */
  if (pathname === '/api/backup' && req.method === 'GET') {
    const data = loadData();
    const out = { ...data };
    delete out.passwordHash;
    out.notify = { ...(data.notify || {}) };
    delete out.notify.token;
    const fname = `service-hub-backup-${todayStr()}.json`;
    res.writeHead(200, Object.assign({
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${fname}"`,
      'Cache-Control': 'no-store'
    }, SEC_HEADERS));
    return res.end(JSON.stringify(out, null, 2));
  }
  /* 恢复备份：先把当前数据自动存一份，再整体替换（账号密码和机器人 Token 永远不动） */
  if (pathname === '/api/backup' && req.method === 'POST') {
    const body = await jsonBody(req);
    const imp = body && body.data ? body.data : body;
    if (!imp || !Array.isArray(imp.services)) return send(400, { error: '备份文件不对：里面没有服务列表' });
    for (const s of imp.services) {
      if (!s || typeof s.id !== 'string' || typeof s.name !== 'string' || !s.name.trim()) {
        return send(400, { error: '备份文件不对：有服务缺名字或编号' });
      }
    }
    const data = loadData();
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      fs.writeFileSync(path.join(DATA_DIR, `backup-before-import-${stamp}.json`), JSON.stringify(data, null, 2));
      const olds = fs.readdirSync(DATA_DIR).filter((f) => f.startsWith('backup-before-import-')).sort();
      while (olds.length > 5) fs.unlinkSync(path.join(DATA_DIR, olds.shift()));
    } catch {}
    const cats = Array.isArray(imp.categories) && imp.categories.length
      ? imp.categories.filter((c) => c && typeof c.id === 'string' && typeof c.label === 'string' && c.label.trim())
      : categoriesOf(data);
    const catIds = new Set(cats.map((c) => c.id));
    const seen = new Set();
    data.services = imp.services.filter((s) => { if (seen.has(String(s.id))) return false; seen.add(String(s.id)); return true; }).map((s) => ({
      id: String(s.id),
      name: String(s.name).slice(0, 100),
      category: catIds.has(s.category) ? s.category : 'relay',
      url: String(s.url || '').slice(0, 500),
      account: String(s.account || '').slice(0, 500),
      secret: String(s.secret || '').slice(0, 500),
      price: String(s.price || '').slice(0, 500),
      notes: String(s.notes || '').slice(0, 500),
      registeredAt: String(s.registeredAt || ''),
      expiresAt: String(s.expiresAt || ''),
      checkinFrequency: s.checkinFrequency === 'daily' ? 'daily' : 'none',
      checkinEveryDays: clampInt(s.checkinEveryDays, 1, 365, 1),
      renewDays: clampInt(s.renewDays, 1, 3650, 365),
      favorite: !!s.favorite,
      checkins: Array.isArray(s.checkins) ? s.checkins.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)) : [],
      visits: Number(s.visits) || 0,
      sortOrder: Number(s.sortOrder) || 0,
      linkStatus: s.linkStatus
    }));
    data.categories = cats.map((c) => ({ id: c.id, label: String(c.label).slice(0, 20), icon: cleanIcon(c.icon), cls: c.cls || 't-custom' }));
    if (imp.history && typeof imp.history === 'object') data.history = imp.history;
    if (imp.achievements && typeof imp.achievements === 'object') data.achievements = imp.achievements;
    if (Number(imp.xp) >= 0) data.xp = Number(imp.xp);
    if (imp.flags && typeof imp.flags === 'object') data.flags = imp.flags;
    if (imp.notify && typeof imp.notify === 'object') {
      const n = notifyCfg(data);
      const keepToken = n.token;
      Object.assign(n, imp.notify);
      if (keepToken) n.token = keepToken; else delete n.token;
    }
    writeJSON(DATA_FILE, data);
    return send(200, { ok: true, services: data.services.length });
  }
  if (pathname === '/api/meta' && req.method === 'GET') {
    const data = loadData();
    const unlocked = syncAchievements(data);
    if (unlocked.length) writeJSON(DATA_FILE, data);
    return send(200, metaPayload(data));
  }

  if (pathname === '/api/services' && req.method === 'GET') {
    return send(200, loadData().services);
  }
  if (pathname === '/api/services' && req.method === 'POST') {
    const data = loadData();
    const f = pickFields(await jsonBody(req), null, categoriesOf(data).map((c) => c.id));
    if (!f.name) return send(400, { error: '名称必填' });
    const svc = Object.assign({
      id: crypto.randomBytes(12).toString('hex'),
      category: 'relay',
      url: '', account: '', secret: '', price: '', notes: '',
      registeredAt: todayStr(), expiresAt: '',
      checkinFrequency: 'none', checkinEveryDays: 1, renewDays: 365, checkins: [],
      visits: 0,
      sortOrder: Math.min(0, ...data.services.map((s) => s.sortOrder ?? 0)) - 1 // 新服务排最前
    }, f);
    data.services.push(svc);
    data.xp += 10; // 记录新服务 +10 热情值
    const unlocked = syncAchievements(data);
    writeJSON(DATA_FILE, data);
    return send(200, { ...svc, xpGained: 10, unlocked });
  }

  /* CSV 批量导入：一次导入多个服务（最多 500 行）；只新增、不覆盖、不加 XP */
  if (pathname === '/api/services/import' && req.method === 'POST') {
    const body = await jsonBody(req);
    const rows = Array.isArray(body.services) ? body.services : [];
    if (!rows.length) return send(400, { error: '没有可导入的服务' });
    if (rows.length > 500) return send(400, { error: '一次最多导入 500 个' });
    const data = loadData();
    const catIds = categoriesOf(data).map((c) => c.id);
    let maxOrder = data.services.reduce((m, s) => Math.max(m, s.sortOrder ?? 0), 0);
    let imported = 0;
    for (const r of rows) {
      const f = pickFields(r || {}, null, catIds);
      if (!f.name) continue;
      const svc = Object.assign({
        id: crypto.randomBytes(12).toString('hex'),
        category: 'relay',
        url: '', account: '', secret: '', price: '', notes: '',
        registeredAt: todayStr(), expiresAt: '',
        checkinFrequency: 'none', checkinEveryDays: 1, renewDays: 365, checkins: [],
        visits: 0,
        sortOrder: ++maxOrder
      }, f);
      data.services.push(svc);
      imported++;
    }
    if (imported) {
      syncAchievements(data);
      writeJSON(DATA_FILE, data);
    }
    return send(200, { ok: true, imported, skipped: rows.length - imported });
  }

  /* 卡片拖拽排序持久化 */
  if (pathname === '/api/reorder' && req.method === 'POST') {
    const body = await jsonBody(req);
    if (!Array.isArray(body.ids)) return send(400, { error: '参数错误' });
    const data = loadData();
    const pos = new Map(body.ids.map((x, i) => [String(x), i]));
    data.services.forEach((s) => { if (pos.has(s.id)) s.sortOrder = pos.get(s.id); });
    writeJSON(DATA_FILE, data);
    return send(200, { ok: true });
  }
  /* 一键全签：一次请求签完当天所有未签（原来前端逐个调，容易签一半断网） */
  if (pathname === '/api/checkins/all' && req.method === 'POST') {
    return send(200, checkinAllToday(loadData()));
  }
  /* 批量操作：一次改多个服务的分类，或一次删多个 */
  if (pathname === '/api/services/bulk' && req.method === 'POST') {
    const body = await jsonBody(req);
    const data = loadData();
    const ids = new Set((Array.isArray(body.ids) ? body.ids : []).map(String));
    if (!ids.size) return send(400, { error: '没有选中服务' });
    if (body.action === 'delete') {
      const before = data.services.length;
      data.services = data.services.filter((s) => !ids.has(s.id));
      writeJSON(DATA_FILE, data);
      return send(200, { ok: true, deleted: before - data.services.length });
    }
    if (body.action === 'category') {
      const catIds = categoriesOf(data).map((c) => c.id);
      const cat = catIds.includes(body.category) ? body.category : 'relay';
      let moved = 0;
      for (const s of data.services) {
        if (!ids.has(s.id)) continue;
        /* 和单个编辑同一条规则：新选进收藏分类的顺带点星 */
        if (cat === 'fav' && s.category !== 'fav') s.favorite = true;
        s.category = cat;
        moved++;
      }
      writeJSON(DATA_FILE, data);
      return send(200, { ok: true, moved });
    }
    return send(400, { error: '未知操作' });
  }

  const m = pathname.match(/^\/api\/services\/([0-9a-f]+)(\/checkin|\/uncheckin|\/visit|\/undo-renew|\/renew|\/move)?$/);
  if (m) {
    const data = loadData();
    const idx = data.services.findIndex((s) => s.id === m[1]);
    if (idx < 0) return send(404, { error: '找不到该服务' });
    const svc = data.services[idx];
    const t = todayStr();
    /* 访问计数：点「前往」/标题链接时打点 */
    if (req.method === 'POST' && m[2] === '/visit') {
      svc.visits = (svc.visits || 0) + 1;
      writeJSON(DATA_FILE, data);
      return send(200, { ok: true, visits: svc.visits });
    }
    if (req.method === 'POST' && m[2] === '/checkin') {
      let xpGained = doCheckin(data, svc, t);
      const { allDone, bonus } = allDoneBonus(data, t);
      xpGained += bonus;
      data.xp += xpGained;
      const unlocked = syncAchievements(data);
      writeJSON(DATA_FILE, data);
      return send(200, {
        ok: true, checkins: svc.checkins, xpGained, allDone,
        unlocked, xp: data.xp, level: levelOf(data.xp)
      });
    }
    if (req.method === 'POST' && m[2] === '/renew') {
      /* 按服务自己的续期周期顺延：未过期的从原到期日起续，已过期的从今天起续，免得续完还是过期；
         365 天沿用加一年（2 月 29 日 → 2 月 28 日），其他天数直接加天数 */
      const cur = svc.expiresAt && /^\d{4}-\d{2}-\d{2}$/.test(svc.expiresAt) ? svc.expiresAt : t;
      const base = cur < t ? t : cur;
      const days = renewEvery(svc);
      /* v51：续期前先快照旧的两个日期，撤回续期时一起恢复；续期把开始时间（注册/购买日期）
         也推到新周期起点（未过期的从原到期日起，已过期的从今天起），开始时间 + 续期周期 = 到期日，循环不断 */
      svc.prevRenew = { expiresAt: svc.expiresAt || '', registeredAt: svc.registeredAt || '' };
      delete svc.prevExpiresAt;
      svc.registeredAt = base;
      svc.expiresAt = days === 365 ? addYear(base) : addDays(base, days);
      writeJSON(DATA_FILE, data);
      return send(200, { ok: true, expiresAt: svc.expiresAt });
    }
    if (req.method === 'POST' && m[2] === '/undo-renew') {
      const snap = svc.prevRenew || (svc.prevExpiresAt ? { expiresAt: svc.prevExpiresAt, registeredAt: svc.registeredAt } : null);
      if (!snap) return send(400, { error: '没有可撤回的续期' });
      svc.expiresAt = snap.expiresAt || '';
      if (typeof snap.registeredAt === 'string') svc.registeredAt = snap.registeredAt;
      delete svc.prevRenew;
      delete svc.prevExpiresAt;
      writeJSON(DATA_FILE, data);
      return send(200, { ok: true, expiresAt: svc.expiresAt });
    }
    if (req.method === 'POST' && m[2] === '/move') {
      /* 卡片上移/下移：只在同分类内按 sortOrder 换位，和拖拽排序同一套顺序 */
      const body = await jsonBody(req);
      const dir = body.dir === 'down' ? 1 : -1;
      const group = data.services.filter((s) => s.category === svc.category).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
      const i = group.findIndex((s) => s.id === svc.id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= group.length) return send(200, { ok: true, moved: false });
      const tmp = group[i].sortOrder; group[i].sortOrder = group[j].sortOrder; group[j].sortOrder = tmp;
      writeJSON(DATA_FILE, data);
      return send(200, { ok: true, moved: true });
    }
    if (req.method === 'POST' && m[2] === '/uncheckin') {
      svc.checkins = svc.checkins.filter((d) => d !== t);
      if (data.history[t]) data.history[t].c = Math.max(0, (data.history[t].c || 1) - 1);
      writeJSON(DATA_FILE, data);
      return send(200, { ok: true, checkins: svc.checkins });
    }
    if (req.method === 'PUT' && !m[2]) {
      const body = await jsonBody(req);
      Object.assign(svc, pickFields(body, svc, categoriesOf(data).map((c) => c.id)));
      /* 手动改了到期日或开始时间，之前的续期快照就作废，免得撤回续期把手改的日期盖回去 */
      if (typeof body.expiresAt === 'string' || typeof body.registeredAt === 'string') { delete svc.prevRenew; delete svc.prevExpiresAt; }
      writeJSON(DATA_FILE, data);
      return send(200, svc);
    }
    if (req.method === 'DELETE' && !m[2]) {
      data.services.splice(idx, 1);
      writeJSON(DATA_FILE, data);
      return send(200, { ok: true });
    }
  }
  return send(404, { error: '接口不存在' });
}

/* ---------- 静态文件 ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.svg', '.json', '.txt', '.md', '.map']);
function serveStatic(req, res, pathname, versioned = false) {
  let p;
  try { p = decodeURIComponent(pathname); } catch {
    res.writeHead(400, SEC_HEADERS);
    return res.end('Bad Request');
  }
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  /* 防目录穿越：必须落在 public/ 内部 */
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, SEC_HEADERS);
    return res.end('Forbidden');
  }
  let st = null;
  try { st = fs.statSync(file); } catch {}
  if (!st || !st.isFile()) {
    res.writeHead(404, Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, SEC_HEADERS));
    return res.end('404 Not Found');
  }
  const ext = path.extname(file).toLowerCase();
  const etag = `W/"${st.size}-${Math.round(st.mtimeMs)}"`;
  const h = Object.assign({
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'ETag': etag,
    /* 带 ?v= 的静态资源（style.css/app.js）文件名即版本，改版就换 v，可放心长缓存；
       index.html 等不带 v 的仍每次 ETag 校验，保证更新即时生效 */
    'Cache-Control': versioned
      ? 'public, max-age=31536000, immutable'
      : 'no-cache'
  }, SEC_HEADERS);
  if (ext === '.html') h['Content-Security-Policy'] = CSP;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, h);
    return res.end();
  }
  if (req.method === 'HEAD') {
    res.writeHead(200, h);
    return res.end();
  }
  let body = fs.readFileSync(file);
  if (COMPRESSIBLE.has(ext)) body = maybeGzip(req, h, body);
  res.writeHead(200, h);
  res.end(body);
}

/* ---------- 启动 ---------- */
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;
    if (pathname.startsWith('/api/')) return await handleAPI(req, res, pathname);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJSON(req, res, 405, { error: 'Method Not Allowed' });
    }
    return serveStatic(req, res, pathname, url.searchParams.has('v'));
  } catch (e) {
    console.error('[!] 请求处理异常:', e);
    try { sendJSON(req, res, 500, { error: '服务器错误' }); } catch {}
  }
});
/* 防慢速攻击（Slowloris） */
server.requestTimeout = 30000;
server.headersTimeout = 15000;
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`[!] 端口 ${PORT} 被占用——服务台可能已经在运行，直接打开 http://127.0.0.1:${PORT} 即可。`);
    process.exit(1);
  }
  throw e;
});

/* 优雅退出：systemd stop / Ctrl+C 时先收完存量请求再退出 */
let shuttingDown = false;
function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[*] 收到 ${sig}，正在优雅退出…`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (e) => console.error('[!] 未处理的 Promise 异常:', e));

loadData();
server.listen(PORT, HOST, () => {
  console.log('============================================');
  console.log(`  ✅ 我的服务台已启动  http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}`);
  console.log(`  数据目录: ${DATA_DIR}`);
  console.log(`  反代模式: ${TRUST_PROXY ? '开（信任 X-Forwarded-*）' : '关（直连）'}`);
  console.log('  Ctrl+C 停止服务');
  console.log('============================================');
  if (process.env.NO_OPEN !== '1' && process.platform === 'win32') {
    exec(`start "" "http://127.0.0.1:${PORT}"`);
  }
});
