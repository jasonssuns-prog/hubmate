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
const tls = require('tls');
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
/* v65：归档分类 id 固定为 'archived'（图标 🗄️），各处按分类排除归档服务；
   归档是分类维度的：手动把分类改回去就恢复正常 */
const ARCHIVED_CAT_ID = 'archived';
const ARCHIVED_CAT = { id: 'archived', label: '已归档', icon: '🗄️', cls: 't-custom' };
function isArchived(s) { return !!s && s.category === ARCHIVED_CAT_ID; }
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
  "img-src 'self' data: https://www.google.com; connect-src 'self'; font-src 'self'; " +
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

/* ---------- v60：TOTP 二次验证（RFC 6238，6 位，30 秒一跳；前后各容一个时间窗，防手机时钟差） ---------- */
const TOTP_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buf) {
  let out = '', bits = 0, val = 0;
  for (const b of buf) {
    val = (val << 8) | b; bits += 8;
    while (bits >= 5) { out += TOTP_ALPHABET[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += TOTP_ALPHABET[(val << (5 - bits)) & 31];
  return out;
}
function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[^A-Z2-7]/g, '');
  const bytes = [];
  let bits = 0, val = 0;
  for (const ch of clean) {
    val = (val << 5) | TOTP_ALPHABET.indexOf(ch); bits += 5;
    if (bits >= 8) { bytes.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(bytes);
}
function totpCode(secret, step) {
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', key).update(buf).digest();
  const off = h[h.length - 1] & 0x0f;
  const code = ((h[off] & 0x7f) << 24) | ((h[off + 1] & 0xff) << 16) | ((h[off + 2] & 0xff) << 8) | (h[off + 3] & 0xff);
  return String(code % 1e6).padStart(6, '0');
}
function verifyTotp(secret, code) {
  if (!secret || !/^\d{6}$/.test(String(code || ''))) return false;
  const step = Math.floor(Date.now() / 30000);
  for (const s of [step - 1, step, step + 1]) if (totpCode(secret, s) === String(code)) return true;
  return false;
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
  return data.services.filter((s) => s.checkinFrequency === 'daily' && s.category !== 'idle' && !isArchived(s));
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
/* v67：meta 按用户取——用户名/是否默认密码/管理员身份走用户记录，其余走该用户的业务数据 */
function metaPayload(user, u) {
  const t = todayStr();
  const daily = dailyServices(u);
  const best = Math.max(0, ...u.services.map((s) => maxRun(s.checkins || [])));
  return {
    username: user.username,
    userId: user.id,
    isAdmin: !!user.isAdmin,
    xp: u.xp,
    level: levelOf(u.xp),
    passwordIsDefault: user.passwordIsDefault !== false,
    totpEnabled: !!u.totpEnabled,
    categories: categoriesOf(u).map(normCat),
    stats: {
      services: u.services.length,
      totalCheckins: u.services.reduce((n, s) => n + (s.checkins || []).length, 0),
      bestStreak: best,
      dailyTotal: daily.length,
      doneToday: daily.filter((s) => (s.checkins || []).includes(t)).length
    },
    achievements: ACH_DEFS.map((a) => ({ ...a, unlockedAt: u.achievements[a.id] || null })),
    history: u.history
  };
}
function publicServices(data) {
  return data.services.map((s) => ({
    id: s.id,
    name: s.name,
    category: s.category,
    url: s.url,
    icon: s.icon || '',
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
    notes: s.notes || '',
    linkStatus: s.linkStatus,
    tags: (Array.isArray(s.tags) ? s.tags : []).map((t) => String(t).trim().slice(0, 20)).filter(Boolean).slice(0, 10),
    uptime7: (() => {
      const hist = (Array.isArray(s.linkHistory) ? s.linkHistory : []).filter((h) => h && typeof h.t === 'number' && typeof h.ok === 'boolean');
      if (!hist.length) return null;
      const cutoff = Date.now() - 7 * 86400e3;
      const recent = hist.filter((h) => h.t >= cutoff);
      if (!recent.length) return null;
      return Math.round((recent.filter((h) => h.ok).length / recent.length) * 100);
    })()
  }));
}

/* ---------- v67：多用户——data.json 里 users 存账号，userData 按 userId 存各用户的业务数据 ----------
   第一个默认用户是管理员（isAdmin），只有他能建用户、生成邀请码；
   各用户只能看到自己的服务/笔记/账号库/签到/经验/分类/通知等，互相看不到；
   GitHub 备份和多服务器同步是整盘的（所有用户的数据都在里面），保持全局、管理员配 */
const USER_DATA_FIELDS = ['services', 'notes', 'xp', 'achievements', 'flags', 'history', 'categories', 'notify', 'totpSecret', 'totpEnabled', 'apiToken', 'loginHistory', 'sharedAccounts', 'monthlyReports', 'archivedLog'];
function defaultUserData() {
  return { services: [], notes: [], xp: 0, achievements: {}, flags: {}, history: {}, notify: {}, totpSecret: '', totpEnabled: false, apiToken: '', loginHistory: [], sharedAccounts: [], monthlyReports: [], archivedLog: [] };
}
function adminUser(data) {
  const users = Array.isArray(data.users) ? data.users : [];
  return users.find((x) => x && x.isAdmin) || users[0] || null;
}
function findUser(data, id) {
  return (Array.isArray(data.users) ? data.users : []).find((x) => x && x.id === id) || null;
}
function findUserByName(data, name) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return null;
  return (Array.isArray(data.users) ? data.users : []).find((x) => x && String(x.username || '').toLowerCase() === n) || null;
}
/* 取某用户的业务数据对象（没有就建一份空的）；调用方再 ensureMeta 补默认值 */
function userData(data, userId) {
  if (!data.userData || typeof data.userData !== 'object') data.userData = {};
  let u = data.userData[userId];
  if (!u || typeof u !== 'object') { u = defaultUserData(); data.userData[userId] = u; }
  return u;
}
/* 邀请码：HUB-XXXX-XXXX-XXXX，12 位字母数字（去掉易混的 0/O/1/I），一次用完 */
function makeInviteCode() {
  const abc = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 12; i++) s += abc[crypto.randomInt(abc.length)];
  return `HUB-${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}
/* 公开给前端的用户信息——绝不含密码哈希 */
function publicUser(data, user) {
  const u = userData(data, user.id);
  return { id: user.id, username: user.username, isAdmin: !!user.isAdmin, banned: !!user.banned, createdAt: user.createdAt || '', lastLoginAt: user.lastLoginAt || '', services: (u.services || []).length, xp: u.xp || 0 };
}

/* ---------- 数据 ---------- */
function loadData() {
  let data = readJSON(DATA_FILE, null);
  /* 全新安装：直接建新结构（管理员 jason + 两条示例服务） */
  if (!data || typeof data !== 'object' || (!Array.isArray(data.users) && !Array.isArray(data.services))) {
    const adminId = crypto.randomBytes(12).toString('hex');
    const u = defaultUserData();
    u.services = [
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
    ];
    data = {
      users: [{ id: adminId, username: 'jason', passwordHash: hashPassword('jason123'), passwordIsDefault: true, isAdmin: true, banned: false, createdAt: todayStr(), lastLoginAt: '' }],
      inviteCodes: [],
      userData: { [adminId]: u }
    };
    writeJSON(DATA_FILE, data);
    return data;
  }
  /* v67 一次性迁移：旧结构（顶层 username/services/……）→ users + userData；
     只做一次：顶层业务字段挪进第一个默认用户（管理员）的 userData，顶层只留全局配置 */
  if (!Array.isArray(data.users)) {
    const adminId = crypto.randomBytes(12).toString('hex');
    const u = defaultUserData();
    for (const k of USER_DATA_FIELDS) {
      if (data[k] !== undefined) { u[k] = data[k]; delete data[k]; }
    }
    data.users = [{ id: adminId, username: data.username || 'jason', passwordHash: data.passwordHash || hashPassword('jason123'), passwordIsDefault: data.passwordIsDefault !== false, isAdmin: true, banned: false, createdAt: todayStr(), lastLoginAt: '' }];
    delete data.username; delete data.passwordHash; delete data.passwordIsDefault;
    data.inviteCodes = [];
    data.userData = { [adminId]: u };
    writeJSON(DATA_FILE, data);
  }
  if (!Array.isArray(data.inviteCodes)) data.inviteCodes = [];
  if (!data.userData || typeof data.userData !== 'object') data.userData = {};
  /* 每位用户的元数据补齐 + 服务归一化（原来是顶层循环，现在按用户跑） */
  let ndirty = false;
  for (const user of (data.users || [])) {
    const u = userData(data, user.id);
    if (ensureMeta(u)) ndirty = true;
    if (!Array.isArray(u.sharedAccounts)) { u.sharedAccounts = []; ndirty = true; }
    if (!Array.isArray(u.monthlyReports)) { u.monthlyReports = []; ndirty = true; }
    if (!Array.isArray(u.loginHistory)) { u.loginHistory = []; ndirty = true; }
    if (!Array.isArray(u.archivedLog)) { u.archivedLog = []; ndirty = true; }
    const vault = vaultOf(u);
    (u.services || []).forEach((s, i) => {
      if (typeof s.sortOrder !== 'number') { s.sortOrder = i; ndirty = true; }
      if (typeof s.visits !== 'number') { s.visits = 0; ndirty = true; }
      const snap = JSON.stringify([s.accounts, s.account, s.secret]);
      normalizeAccounts(s, vault);
      if (JSON.stringify([s.accounts, s.account, s.secret]) !== snap) ndirty = true;
    });
  }
  if (ndirty) writeJSON(DATA_FILE, data);
  return data;
}
function loadSessions() { return readJSON(SESSIONS_FILE, {}); }
function saveSessions(sessions) {
  const cutoff = Date.now() - SESSION_MS;
  for (const k of Object.keys(sessions)) if (sessions[k].created < cutoff) delete sessions[k];
  writeJSON(SESSIONS_FILE, sessions);
}
/* v67：会话里存 userId；v67 之前登录的老会话没有 userId，默认归第一个默认用户（管理员），
   顺手补进会话文件里（只写一次），用户不用重新登录 */
function currentUser(req) {
  const token = parseCookies(req.headers.cookie).session;
  if (!token) return null;
  const sessions = loadSessions();
  const rec = sessions[token];
  if (!rec || Date.now() - rec.created > SESSION_MS) return null;
  if (!rec.userId) {
    const admin = adminUser(loadData());
    if (!admin) return null;
    rec.userId = admin.id;
    saveSessions(sessions);
  }
  return { token, sessions, userId: rec.userId };
}
/* v59：API 令牌（给 iOS 快捷指令用）——只放行签到那两个接口，别的一律不认；
   令牌放请求头 Authorization: Bearer <token> 或 ?token= 参数里；
   v67：令牌按用户配，返回它属于哪个用户（找不到返回 null） */
function isApiToken(req) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(\S+)$/i);
  let tok = m ? m[1] : '';
  if (!tok) {
    try { tok = new URL(req.url, 'http://x').searchParams.get('token') || ''; } catch { tok = ''; }
  }
  if (!tok) return null;
  const data = loadData();
  for (const [uid, u] of Object.entries(data.userData || {})) {
    if (u && u.apiToken && u.apiToken === tok) return uid;
  }
  return null;
}
function isTokenAllowedEndpoint(pathname, method) {
  if (method !== 'POST') return false;
  if (pathname === '/api/checkins/all') return true;
  return /^\/api\/services\/[0-9a-f]+\/checkin$/.test(pathname);
}
/* v60：自动签到配置——只适合没有人机验证的纯接口签到（带验证码的站签不了）；
   成功 = HTTP 2xx，且响应里包含 expect 指定的文字（没填就不查） */
function sanitizeAutoSignin(a) {
  if (!a || typeof a !== 'object') return null;
  const url = String(a.url || '').trim().slice(0, 500);
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const headers = {};
  if (a.headers && typeof a.headers === 'object') {
    for (const [k, v] of Object.entries(a.headers).slice(0, 10)) {
      const key = String(k).trim().slice(0, 100);
      if (!key) continue;
      headers[key] = String(v).slice(0, 500);
    }
  }
  return {
    enabled: !!a.enabled,
    url,
    method: String(a.method || 'POST').toUpperCase() === 'GET' ? 'GET' : 'POST',
    headers,
    body: String(a.body || '').slice(0, 2000),
    expect: String(a.expect || '').trim().slice(0, 200)
  };
}
function autoSigninOf(s) {
  if (!s || !s.autoSignin || typeof s.autoSignin !== 'object') return null;
  const cfg = sanitizeAutoSignin(s.autoSignin);
  if (!cfg || !cfg.enabled) return null;
  return cfg;
}
/* ---------- 多账号：一个服务可存多个账号（名字/账号/密码/备注），其中一个是默认 ---------- */
function sanitizeAccount(a) {
  if (!a || typeof a !== 'object') return null;
  const out = {
    id: String(a.id || crypto.randomBytes(6).toString('hex')).slice(0, 32),
    label: String(a.label || '').trim().slice(0, 30) || '账号',
    username: String(a.username || '').trim().slice(0, 200),
    password: String(a.password || '').slice(0, 500),
    notes: String(a.notes || '').trim().slice(0, 200),
    isDefault: !!a.isDefault,
    checkins: (Array.isArray(a.checkins) ? a.checkins : []).filter((d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)).slice(0, 1000).sort()
  };
  /* v65：链接共享账号库的账号（sharedId 指向库里那条）；改密日只记 YYYY-MM-DD */
  if (typeof a.sharedId === 'string' && a.sharedId.trim()) out.sharedId = a.sharedId.trim().slice(0, 32);
  if (typeof a.passwordChangedAt === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(a.passwordChangedAt)) out.passwordChangedAt = a.passwordChangedAt;
  return out;
}
/* 归一化：accounts 数组是唯一事实来源；account/secret 只做默认账号的镜像（兼容旧代码、CSV、台账）；
   传了 vault（共享账号库）时，链接账号的用户名/密码/备注以库为准（快照跟库同步），库里找不到就退回成本地账号 */
function normalizeAccounts(svc, vault) {
  if (!Array.isArray(svc.accounts)) svc.accounts = [];
  svc.accounts = svc.accounts.map(sanitizeAccount).filter(Boolean).slice(0, 20);
  if (Array.isArray(vault)) {
    for (const a of svc.accounts) {
      if (!a.sharedId) continue;
      const v = vault.find((x) => x.id === a.sharedId);
      if (!v) { delete a.sharedId; continue; }
      /* 链接账号以库为准的是用户名和密码（备注留在服务本地，是服务维度的） */
      a.username = v.username; a.password = v.password;
      if (v.passwordChangedAt) a.passwordChangedAt = v.passwordChangedAt;
    }
  }
  if (!svc.accounts.length && (svc.account || svc.secret)) {
    svc.accounts.push({ id: crypto.randomBytes(6).toString('hex'), label: '默认', username: String(svc.account || ''), password: String(svc.secret || ''), notes: '', isDefault: true, checkins: [] });
  }
  let def = svc.accounts.find((a) => a.isDefault);
  if (!def && svc.accounts.length) { svc.accounts[0].isDefault = true; def = svc.accounts[0]; }
  svc.accounts.forEach((a) => { if (a !== def) a.isDefault = false; });
  /* 旧数据迁移：服务级签到记录是单账号时代的；如果没有任何账号有签到记录，
     就把它算到默认账号头上（连签不断），只迁一次（迁完默认账号就有了记录，不会再跑） */
  if (svc.accounts.length && (svc.checkins || []).length && !svc.accounts.some((a) => (a.checkins || []).length)) {
    def.checkins = [...(svc.checkins || [])].sort();
  }
  svc.account = def ? def.username : '';
  svc.secret = def ? def.password : '';
  return svc;
}
/* ---------- v65：共享账号库——账号只存一份，服务里的账号可以链接它 ----------
   服务账号带 sharedId 时，用户名/密码/备注以库里为准；库里改密码，所有链接跟着变；
   库里删账号，链接它的服务账号自动变回本地副本（快照就是当时的账号密码，不丢数据） */
function vaultOf(data) {
  if (!Array.isArray(data.sharedAccounts)) data.sharedAccounts = [];
  return data.sharedAccounts;
}
function sanitizeVaultAccount(v) {
  if (!v || typeof v !== 'object') return null;
  const out = {
    id: String(v.id || crypto.randomBytes(6).toString('hex')).slice(0, 32),
    label: String(v.label || '').trim().slice(0, 30) || '账号库',
    username: String(v.username || '').trim().slice(0, 200),
    password: String(v.password || '').slice(0, 500),
    notes: String(v.notes || '').trim().slice(0, 200)
  };
  if (typeof v.passwordChangedAt === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.passwordChangedAt)) out.passwordChangedAt = v.passwordChangedAt;
  return out;
}
/* 链接账号的解析：返回以库为准的账号副本；库里找不到就返回 null（当成本地账号） */
function resolveVaultAccount(vault, a) {
  if (!a || !a.sharedId || !Array.isArray(vault)) return null;
  const v = vault.find((x) => x.id === a.sharedId);
  if (!v) return null;
  return { ...a, username: v.username, password: v.password, passwordChangedAt: v.passwordChangedAt || a.passwordChangedAt };
}
/* v62：自定义字段——每服务最多 10 个键值对，字段名 ≤20 字、值 ≤200 字，同名字段只留第一个 */
function sanitizeCustomFields(v) {
  if (!Array.isArray(v)) return [];
  const seen = new Set();
  const out = [];
  for (const f of v) {
    if (!f || typeof f !== 'object') continue;
    const k = String(f.k || '').trim().slice(0, 20);
    const val = String(f.v ?? '').trim().slice(0, 200);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push({ k, v: val });
    if (out.length >= 10) break;
  }
  return out;
}
function pickFields(b, existing, catIds, vault) {
  const out = {};
  if (typeof b.name === 'string') out.name = b.name.trim().slice(0, 100);
  if (b.category !== undefined) out.category = (catIds || []).includes(b.category) ? b.category : 'relay';
  if (b.checkinFrequency !== undefined) out.checkinFrequency = b.checkinFrequency === 'daily' ? 'daily' : 'none';
  if (b.checkinEveryDays !== undefined) out.checkinEveryDays = clampInt(b.checkinEveryDays, 1, 365, 1);
  if (b.renewDays !== undefined) out.renewDays = clampInt(b.renewDays, 1, 3650, 365);
  if (b.favorite !== undefined) out.favorite = !!b.favorite;
  if (b.abnormal !== undefined) out.abnormal = !!b.abnormal;
  /* v68：自定义图标——data URL（前端已裁成 96×96 JPEG），只认 data:image/ 开头，最多 20000 字；传 null/'' 表示清掉 */
  if (b.icon !== undefined) {
    if (b.icon === null || b.icon === '') out.icon = '';
    else if (typeof b.icon === 'string' && b.icon.startsWith('data:image/')) out.icon = b.icon.slice(0, 20000);
  }
  /* v62：自定义字段——编辑页里加行/删行；只接受干净的键值对数组 */
  if (b.customFields !== undefined) out.customFields = sanitizeCustomFields(b.customFields);
  /* v60：多标签——逗号分隔也行，数组也行；最多 10 个，每个最多 20 字，去重去空 */
  if (b.tags !== undefined) {
    const raw = Array.isArray(b.tags) ? b.tags : String(b.tags || '').split(/[,，、\s]+/);
    const seen = new Set();
    out.tags = raw.map((t) => String(t).trim().slice(0, 20)).filter((t) => t && !seen.has(t) && seen.add(t)).slice(0, 10);
  }
  /* v60：自动签到配置——编辑页里配，没配或 URL 不合法就不存；传 null 表示清掉（网址清空了） */
  if (b.autoSignin !== undefined) {
    if (b.autoSignin === null) { out.autoSignin = null; }
    else {
      const cfg = sanitizeAutoSignin(b.autoSignin);
      if (cfg) out.autoSignin = cfg;
      else if (b.autoSignin && typeof b.autoSignin === 'object' && !b.autoSignin.url) out.autoSignin = null;
    }
  }
  /* 星标和分类互不干涉，只在一种情况下顺带点星：这次请求把分类“新选进”收藏
     （新建就是收藏分类，或原来不是收藏分类、这次改成了收藏分类），这样分类选收藏的
     服务会归拢进收藏栏。只改星标的请求、以及本来就是收藏分类的编辑，都尊重请求里的
     星标值，绝不强制改回、也绝不改分类 */
  if (b.category === 'fav' && (!existing || existing.category !== 'fav')) out.favorite = true;
  /* 多账号：传了 accounts 数组就用它（默认账号同步到 account/secret）；只传了旧式
     account/secret 就改默认账号（没有就新建一个）。account/secret 不再单独走下面的循环。
     弹窗编辑只发账号信息不发签到记录：按 id 沿用旧的签到记录，别清掉 */
  if (Array.isArray(b.accounts)) {
    const existingById = new Map((Array.isArray(existing?.accounts) ? existing.accounts : []).map((a) => [String(a.id || ''), a]));
    out.accounts = b.accounts.map((a) => {
      const s = sanitizeAccount(a);
      if (!s) return null;
      if ((!a.checkins || !a.checkins.length) && existingById.has(s.id)) {
        const old = existingById.get(s.id);
        if (Array.isArray(old.checkins)) s.checkins = old.checkins.filter((d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)).slice(0, 1000).sort();
      }
      /* v65：链接账号以库为准——客户端传来的用户名/密码不认，只认库里那条；
         库里没有这个 id 就退回成本地账号（快照就是传来的值，不丢数据） */
      if (s.sharedId && Array.isArray(vault)) {
        const v = vault.find((x) => x.id === s.sharedId);
        if (v) {
          s.username = v.username; s.password = v.password;
          if (v.passwordChangedAt) s.passwordChangedAt = v.passwordChangedAt;
        } else delete s.sharedId;
      }
      /* v65：改密日——本地账号密码变了（或新账号）就记今天；没变就沿用旧的；链接账号跟库走 */
      if (!s.sharedId) {
        const old = existingById.get(s.id);
        if (!old || old.password !== s.password) s.passwordChangedAt = todayStr();
        else if (old.passwordChangedAt) s.passwordChangedAt = old.passwordChangedAt;
      }
      return s;
    }).filter(Boolean).slice(0, 20);
    const def = out.accounts.find((a) => a.isDefault) || out.accounts[0];
    out.account = def ? def.username : '';
    out.secret = def ? def.password : '';
  } else if (b.account !== undefined || b.secret !== undefined) {
    const base = Array.isArray(existing?.accounts) ? existing.accounts.map(sanitizeAccount).filter(Boolean) : [];
    const acc = base.find((a) => a.isDefault) || base[0];
    const username = typeof b.account === 'string' ? b.account.trim().slice(0, 200) : (acc ? acc.username : '');
    const password = typeof b.secret === 'string' ? b.secret.slice(0, 500) : (acc ? acc.password : '');
    if (acc) {
      /* v65：旧式单账号改密码也记改密日 */
      if (!acc.sharedId && acc.password !== password) acc.passwordChangedAt = todayStr();
      acc.username = username; acc.password = password;
      out.accounts = base;
    } else {
      out.accounts = [{ id: crypto.randomBytes(6).toString('hex'), label: '默认', username, password, notes: '', isDefault: true, passwordChangedAt: password ? todayStr() : undefined }];
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
   Token、Chat ID 等其他设置绝不参与合并，免得把用户刚保存的新设置盖回去；
   v67：freshU 是该用户在盘上最新的业务数据对象 */
function mergeNotifyWrites(freshU, n, prev) {
  const fn = notifyCfg(freshU);
  for (const k of ['lastExpiring', 'lastCheckin', 'lastCheckinRepeatAt']) {
    if (n[k] !== undefined && n[k] !== prev[k]) fn[k] = n[k];
  }
  return freshU;
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
/* v62：多渠道通知——Telegram 之外的三个渠道。HTML 文案要先剥标签再发纯文本渠道 */
function stripHtmlTags(s) {
  return String(s ?? '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}
async function sendWebhook(url, title, text) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, text, time: cstDateTime(), source: 'hubmate' }),
    signal: AbortSignal.timeout(10000)
  });
  if (!res.ok) throw new Error(`Webhook 返回 ${res.status}`);
}
async function sendBark(key, title, body) {
  const url = `https://api.day.app/${encodeURIComponent(key)}/${encodeURIComponent(title)}/${encodeURIComponent(body)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Bark 返回 ${res.status}`);
}
async function sendServerChan(key, title, desp) {
  const res = await fetch(`https://sctapi.ftqq.com/${encodeURIComponent(key)}.send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `title=${encodeURIComponent(title)}&desp=${encodeURIComponent(desp)}`,
    signal: AbortSignal.timeout(10000)
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || (j.code !== undefined && j.code !== 0)) throw new Error(j.message || `Server酱返回 ${res.status}`);
}
/* v62：一次提醒发到所有配好的渠道；返回每个渠道 ok/skip/error，至少一个成功算整体成功 */
async function sendMultiChannel(n, title, htmlText, tgMarkup) {
  const plain = stripHtmlTags(htmlText);
  const results = {};
  const run = async (name, fn) => {
    try { await fn(); results[name] = 'ok'; }
    catch (e) { results[name] = 'error: ' + (e.message || '发送失败'); console.error(`[!] ${name} 推送失败:`, e.message); }
  };
  if (n.token && n.chatId) await run('telegram', () => tgSend(n.token, n.chatId, htmlText, tgMarkup));
  else results.telegram = 'skip';
  if (n.webhookUrl) await run('webhook', () => sendWebhook(n.webhookUrl, title, plain));
  else results.webhook = 'skip';
  if (n.barkKey) await run('bark', () => sendBark(n.barkKey, title, plain));
  else results.bark = 'skip';
  if (n.serverChanKey) await run('serverchan', () => sendServerChan(n.serverChanKey, title, plain));
  else results.serverchan = 'skip';
  const ok = Object.values(results).some((v) => v === 'ok');
  return { ok, results };
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
   v53：标记异常的服务也不计入（不挡全勤、不进提醒），只在面板里红显；
   v57：今天已签 = 全部账号都签了今天（serviceDoneToday），不是服务级 checkins 里有今天 */
function checkinCohort(data, t) {
  return dailyServices(data).filter((s) => !s.abnormal && (checkinDue(s, t) || serviceDoneToday(s, t)));
}
/* v57：账号级签到。一个服务有多个账号时，只有全部账号都签了今天，这个服务才算“签完”。
   服务级 checkins 仍是“签完”的记录（连签/历史/全勤都按它算），账号级 checkins 只记每个账号的签到。 */
function accountCheckins(a) { return Array.isArray(a.checkins) ? a.checkins : []; }
function serviceAccounts(s) { return Array.isArray(s.accounts) ? s.accounts : []; }
/* 服务今天是否签完：有账号 → 全部账号都签了今天；没账号 → 服务级 checkins 有今天 */
function serviceDoneToday(s, t) {
  const accs = serviceAccounts(s);
  if (!accs.length) return (s.checkins || []).includes(t);
  return accs.every((a) => accountCheckins(a).includes(t));
}
/* 服务今天的签到进度：{done, total}；没账号时 total=1（服务本身算一个单位） */
function serviceProgress(s, t) {
  const accs = serviceAccounts(s);
  if (!accs.length) return { done: (s.checkins || []).includes(t) ? 1 : 0, total: 1 };
  return { done: accs.filter((a) => accountCheckins(a).includes(t)).length, total: accs.length };
}
/* 签一个账号：把今天记到该账号头上；如果这下全部账号都签了，就把今天记到服务级 checkins（算签完，给分） */
function doCheckinAccount(data, svc, acc, t) {
  acc.checkins = accountCheckins(acc);
  if (acc.checkins.includes(t)) return 0;
  acc.checkins.push(t);
  acc.checkins.sort();
  if (!serviceDoneToday(svc, t)) return 0; // 还没全签完，不给分、不记服务级
  return doCheckin(data, svc, t); // 全签完了，走服务级签到（记服务级 + 给分）
}
/* 撤一个账号：把今天从该账号头上拿掉；如果服务原来是签完的，这下就不算签完了，把今天从服务级记录里也拿掉 */
function doUncheckinAccount(data, svc, acc, t) {
  acc.checkins = accountCheckins(acc).filter((d) => d !== t);
  if ((svc.checkins || []).includes(t) && !serviceDoneToday(svc, t)) {
    svc.checkins = svc.checkins.filter((d) => d !== t);
    if (data.history[t]) data.history[t].c = Math.max(0, (data.history[t].c || 1) - 1);
  }
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
    .filter((s) => s.expiresAt && daysUntilSrv(s.expiresAt) <= 30 && !isArchived(s))
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
/* 全勤奖励：今日 cohort 全部签完且今天还没领过才给；不到期的服务不挡全勤；
   v57：签完 = 全部账号都签了今天（serviceDoneToday） */
function allDoneBonus(data, t) {
  const cohort = checkinCohort(data, t);
  const allDone = cohort.length > 0 && cohort.every((s) => serviceDoneToday(s, t));
  data.history[t] = data.history[t] || { c: 0 };
  if (allDone && !data.history[t].all) {
    data.history[t].all = true;
    return { allDone, bonus: 10 };
  }
  return { allDone, bonus: 0 };
}
/* 批量签到：把当天所有未签的每日服务一次签完，只写一次盘；
   v57：一键全签把每个服务的全部账号都签了（没账号的走服务级签到） */
function checkinAllTodayNoWrite(data) {
  const t = todayStr();
  const todo = unsignedDaily(data, t);
  let xpGained = 0;
  let accountsSigned = 0;
  for (const svc of todo) {
    const accs = serviceAccounts(svc);
    if (accs.length) {
      for (const a of accs) {
        if (!accountCheckins(a).includes(t)) accountsSigned++;
        xpGained += doCheckinAccount(data, svc, a, t);
      }
    } else {
      accountsSigned++;
      xpGained += doCheckin(data, svc, t);
    }
  }
  const { allDone, bonus } = allDoneBonus(data, t);
  xpGained += bonus;
  data.xp = (data.xp || 0) + xpGained;
  const unlocked = syncAchievements(data);
  return { signed: todo.length, accountsSigned, xpGained, allDone, unlocked, xp: data.xp, level: levelOf(data.xp) };
}
function checkinAllToday(data, userId) {
  const u = userData(data, userId);
  ensureMeta(u);
  const r = checkinAllTodayNoWrite(u);
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
  const t = todayStr();
  const lines = todo.slice(0, 20).map((s) => {
    const p = serviceProgress(s, t);
    const suffix = p.total > 1 ? `（已签 ${p.done}/${p.total}）` : '';
    return `• <b>${escHtml(s.name)}</b>${suffix}`;
  });
  if (todo.length > 20) lines.push(`…等共 ${todo.length} 个`);
  return lines;
}
/* 每小时检查一次；北京时间 9 点后才发（默认，设置里可改），避开半夜与日期错位。
   每天每种最多发一次：没事可推时也记下日期，不空转；发送失败不记日期，下小时重试。
   注意：绝不在启动时立即发——每次部署都会重启服务，启动即发等于部署就骚扰一次。
   v67：通知按用户配，定时任务按用户循环跑各自的提醒 */
async function runNotifyChecks() {
  try {
    /* v65：到期自动归档（每天一次）+ 月度报告（每月 1 号）——不依赖通知渠道，没配 Telegram 也照常跑；
       先跑它们，再读盘做提醒，这样提醒用的数据已经是归档/生成后的最新状态 */
    archiveExpiredIfDue();
    await monthlyReportIfDue();
    const data = loadData();
    for (const user of (data.users || [])) {
      const u = userData(data, user.id);
      ensureMeta(u);
      await runNotifyChecksForUser(user, u);
    }
  } catch (e) { console.error('[!] TG 定时检查异常:', e.message); }
}
async function runNotifyChecksForUser(user, u) {
  try {
    const n = notifyCfg(u);
    /* v62：任一渠道配好了就跑，不再只认 Telegram */
    if (!(n.token && n.chatId) && !n.webhookUrl && !n.barkKey && !n.serverChanKey) return;
    /* 记下本轮开始时的日期字段：写回时只合并本轮改过的，盘上更新的以盘上为准 */
    const prevNotify = { lastExpiring: n.lastExpiring, lastCheckin: n.lastCheckin, lastCheckinRepeatAt: n.lastCheckinRepeatAt };
    const pushHour = (n.pushHour === undefined ? 9 : n.pushHour);
    if (cstHour() < pushHour) return;
    const t = todayStr();
    let dirty = false;
    /* v62：多渠道发一次；至少一个渠道成功才算发出去（失败不记日期，下小时重试） */
    const tryPush = async (title, htmlText, tgMarkup) => {
      try {
        const r = await sendMultiChannel(n, title, htmlText, tgMarkup);
        if (!r.ok) console.error('[!] 多渠道推送全部失败');
        return r.ok;
      } catch (e) { console.error('[!] 多渠道推送异常:', e.message); return false; }
    };
    if (n.expiring !== false && n.lastExpiring !== t) {
      const items = expiringList(u);
      let ok = true;
      if (items.length) {
        ok = await tryPush(`服务台临期提醒 · ${t}`,
          `⏰ <b>服务台临期提醒</b> · ${t}\n共 ${items.length} 个服务临期：\n\n${expiringLines(items).join('\n')}`);
      }
      if (ok) { n.lastExpiring = t; dirty = true; }
    }
    if (n.checkin !== false && n.lastCheckin !== t) {
      const todo = unsignedDaily(u, t);
      let ok = true;
      if (todo.length) {
        /* v65：密码轮换提醒——每天 17:00 的签到提醒里加一句（有 N 个账号密码超 90 天没换） */
        const stale = stalePasswordAccounts(u);
        const rotLine = stale.length ? `\n\n🔑 另有 ${stale.length} 个账号密码超过 90 天没换，建议轮换一下。` : '';
        ok = await tryPush(`服务台签到提醒 · ${t}`,
          `⚡ <b>服务台签到提醒</b> · ${t}\n今日还有 ${todo.length} 个站未签到：\n\n${checkinLines(todo).join('\n')}${rotLine}\n\n👉 点下面按钮直接签完，别断了连签。`, CHECKIN_KB);
      }
      if (ok) { n.lastCheckin = t; n.lastCheckinRepeatAt = Date.now(); dirty = true; }
    }
    /* 签到重复提醒：固定提醒发完后，每隔 repeatHours 小时再查一次还有没有未签；
       只在固定时间到 23 点之间推，夜里不打扰；签完了自然停；锚点就是上面固定提醒的时间。 */
    if (n.checkin !== false && n.repeatHours > 0 && n.lastCheckin === t) {
      const todo = unsignedDaily(u, t);
      const h = cstHour();
      const last = n.lastCheckinRepeatAt || 0;
      if (todo.length && h >= pushHour && h < 23 && Date.now() - last >= n.repeatHours * 3600e3) {
        const okR = await tryPush(`服务台签到提醒（复查）· ${t}`,
          `⚡ <b>服务台签到提醒（复查）</b> · ${t}\n今日还有 ${todo.length} 个站未签到：\n\n${checkinLines(todo).join('\n')}\n\n👉 点下面按钮直接签完，别断了连签。`, CHECKIN_KB);
        if (okR) { n.lastCheckinRepeatAt = Date.now(); dirty = true; }
      }
    }
    /* 写回前重读：这一小时里用户可能改过数据，只合并提醒自己改的日期字段 */
    if (dirty) {
      const fresh = loadData();
      const fu = userData(fresh, user.id);
      mergeNotifyWrites(fu, n, prevNotify);
      writeJSON(DATA_FILE, fresh);
    }
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
/* v67：机器人回话按用户跑——各用户用自己的 Token/Chat ID，tgSeen 各记各的 */
async function pollBotCommands() {
  try {
    const data = loadData();
    for (const user of (data.users || [])) {
      const u = userData(data, user.id);
      ensureMeta(u);
      await pollBotCommandsForUser(user, u);
    }
  } catch (e) { console.error('[!] TG 命令轮询异常:', e.message); }
}
async function pollBotCommandsForUser(user, u) {
  try {
    const n = notifyCfg(u);
    if (!n.token || !n.chatId) return;
    /* 快照在先：后面网络往返期间用户可能改数据，写回时只合并轮询自己改的字段 */
    const snap = snapshotPollState(u);
    const res = await fetch(tgApiUrl(n.token, 'getUpdates'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
    });
    const j = await res.json().catch(() => ({}));
    if (!j.ok || !Array.isArray(j.result)) return;
    if (n.tgSeen === undefined) {
      n.tgSeen = j.result.reduce((m, x) => Math.max(m, x.update_id || 0), 0);
      const fresh = loadData();
      mergePollWrites(userData(fresh, user.id), u, snap);
      writeJSON(DATA_FILE, fresh);
      return;
    }
    const fresh = j.result.filter((x) => (x.update_id || 0) > n.tgSeen);
    if (!fresh.length) return;
    const t = todayStr();
    for (const x of fresh) {
      n.tgSeen = Math.max(n.tgSeen, x.update_id || 0);
      /* 按钮回调：提醒消息下的“全部签到”被点了。用不写盘版批量签到，只改内存里的
         u 对象，最后统一做合并写回——签到结果不会丢，用户的同期改动也不会被盖掉 */
      const cb = x.callback_query;
      if (cb) {
        if (String(cb.from && cb.from.id) !== String(n.chatId)) continue;
        if (cb.data === 'checkin_all') {
          const r = checkinAllTodayNoWrite(u);
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
      const msg = x.message;
      if (!msg || String(msg.chat && msg.chat.id) !== String(n.chatId)) continue;
      const text = String(msg.text || '').trim();
      const send = (txt) => tgSend(n.token, n.chatId, txt).catch(() => {});
      if (text === '/start' || text === '/help') {
        await send(`🤖 <b>服务台机器人</b>\n/today 今日签到情况\n/expiring 临期服务列表`);
      } else if (text === '/today') {
        const cohort = checkinCohort(u, t);
        const done = cohort.filter((s) => (s.checkins || []).includes(t)).length;
        const todo = unsignedDaily(u, t);
        const body = todo.length
          ? `今日签到 ${done}/${cohort.length}，还有 ${todo.length} 个未签：\n\n${checkinLines(todo).join('\n')}`
          : `今日签到 ${done}/${cohort.length}，已全部签完 ✓`;
        if (todo.length) await tgSend(n.token, n.chatId, `⚡ <b>今日签到</b> · ${t}\n${body}`, CHECKIN_KB).catch(() => {});
        else await send(`⚡ <b>今日签到</b> · ${t}\n${body}`);
      } else if (text === '/expiring') {
        const items = expiringList(u);
        const body = items.length
          ? `共 ${items.length} 个服务临期：\n\n${expiringLines(items).join('\n')}`
          : '30 天内暂无临期服务';
        await send(`⏰ <b>临期服务</b> · ${t}\n${body}`);
      }
    }
    /* 写回前重读：这一分钟里用户可能改过数据，只合并轮询自己改的字段 */
    const fresh2 = loadData();
    mergePollWrites(userData(fresh2, user.id), u, snap);
    writeJSON(DATA_FILE, fresh2);
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
/* ---------- v65：纯函数 + 每日/每月任务（月度报告、月度可用性、密码轮换、到期自动归档、SSL 证书） ---------- */
/* 密码轮换——超过 90 天没换密码的账号（有改密日才算，没记的按“未知”不算）；链接账号跟库里的改密日 */
function stalePasswordAccounts(data) {
  const vault = vaultOf(data);
  const d = cstNow();
  d.setUTCDate(d.getUTCDate() - 90);
  const cutoff = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  const out = [];
  for (const s of data.services) {
    for (const a of serviceAccounts(s)) {
      const acc = resolveVaultAccount(vault, a) || a;
      const ch = acc.passwordChangedAt;
      if (!ch || typeof ch !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(ch)) continue;
      if (ch < cutoff) out.push({ service: s.name, serviceId: s.id, accountId: a.id, label: a.label || '', username: acc.username || '', changedAt: ch });
    }
  }
  return out.sort((a, b) => a.changedAt.localeCompare(b.changedAt));
}
/* 月度可用性——按 linkHistory 算每个服务当月的在线率；当月没探测记录的 rate=null（无数据）；
   月份边界按北京时间算（UTC 月初往前推 8 小时） */
function monthlyUptime(data, ym) {
  const [y, m] = ym.split('-').map(Number);
  const start = Date.UTC(y, m - 1, 1) - 8 * 3600e3;
  const end = Date.UTC(y, m, 1) - 8 * 3600e3;
  return data.services.map((s) => {
    const hist = (Array.isArray(s.linkHistory) ? s.linkHistory : []).filter((h) => h && typeof h.t === 'number' && h.t >= start && h.t < end && typeof h.ok === 'boolean');
    if (!hist.length) return { id: s.id, name: s.name, rate: null, probes: 0 };
    const ok = hist.filter((h) => h.ok).length;
    return { id: s.id, name: s.name, rate: Math.round((ok / hist.length) * 100), probes: hist.length };
  });
}
/* 月度报告——纯函数（data 是当月 1 号那天的数据，ym 是上个月 'YYYY-MM'）；
   签到天数/总次数/签到攒的经验（每天首次 +5、全勤 +10，都记在 history 里）、最常签到的服务、
   新增服务数（createdAt 为准，老服务没有 createdAt 就按注册/购买日期算）、本月到期数、
   本月自动归档数、本月在线率最低的 3 个服务 */
function buildMonthlyReport(data, ym) {
  const hist = data.history || {};
  let days = 0, totalCk = 0, xp = 0;
  for (const [d, h] of Object.entries(hist)) {
    if (!d.startsWith(ym + '-')) continue;
    if ((h.c || 0) > 0) days++;
    totalCk += (h.c || 0);
    xp += (h.x || 0) + (h.all ? 10 : 0);
  }
  let top = '', topN = 0, added = 0, expiring = 0;
  for (const s of data.services) {
    const n = (s.checkins || []).filter((d) => d.startsWith(ym + '-')).length;
    if (n > topN) { topN = n; top = s.name; }
    const created = (typeof s.createdAt === 'string' && s.createdAt) || s.registeredAt || '';
    if (created.startsWith(ym + '-')) added++;
    if (typeof s.expiresAt === 'string' && s.expiresAt.startsWith(ym + '-')) expiring++;
  }
  const up = monthlyUptime(data, ym);
  const lowestUptime = up.filter((u) => u.rate !== null).sort((a, b) => a.rate - b.rate).slice(0, 3)
    .map((u) => ({ name: u.name, rate: u.rate, probes: u.probes }));
  const archived = (Array.isArray(data.archivedLog) ? data.archivedLog : []).filter((a) => typeof a.at === 'string' && a.at.startsWith(ym + '-')).length;
  return { ym, days, totalCk, xp, top, topN, added, expiring, archived, lowestUptime };
}
function monthlyReportText(rep) {
  const lines = [
    `📊 <b>服务台月度报告 · ${rep.ym}</b>`,
    `签到 ${rep.days} 天 · 共 ${rep.totalCk} 次 · 攒了 ${rep.xp}⚡`,
    rep.top ? `最常签到：${escHtml(rep.top)}（${rep.topN} 次）` : '最常签到：—',
    `新增服务 ${rep.added} 个 · 本月到期 ${rep.expiring} 个 · 自动归档 ${rep.archived} 个`,
  ];
  if (rep.lowestUptime && rep.lowestUptime.length) {
    lines.push(`本月在线率最低：${rep.lowestUptime.map((u) => `${escHtml(u.name)} ${u.rate}%`).join('、')}`);
  }
  return lines.join('\n');
}
/* 每月 1 号生成上月报告并推一次；没配通知渠道也照常生成存盘（只留最近 12 条），下次 1 号前不重复；
   v67：按用户各生成各的（各记各的 flags.lastMonthlyReport） */
async function monthlyReportIfDue() {
  try {
    const data = loadData();
    const t = todayStr();
    if (Number(t.split('-')[2]) !== 1) return;
    const [cy, cm] = t.split('-').map(Number);
    const prevYm = cm === 1 ? `${cy - 1}-12` : `${cy}-${String(cm - 1).padStart(2, '0')}`;
    let changed = false;
    for (const user of (data.users || [])) {
      const u = userData(data, user.id);
      ensureMeta(u);
      u.flags = u.flags || {};
      if (u.flags.lastMonthlyReport === prevYm) continue;
      const rep = buildMonthlyReport(u, prevYm);
      u.monthlyReports = (Array.isArray(u.monthlyReports) ? u.monthlyReports : []).filter((r) => r.ym !== prevYm);
      u.monthlyReports.push(rep);
      if (u.monthlyReports.length > 12) u.monthlyReports = u.monthlyReports.slice(-12);
      u.flags.lastMonthlyReport = prevYm;
      changed = true;
      const n = notifyCfg(u);
      if ((n.token && n.chatId) || n.webhookUrl || n.barkKey || n.serverChanKey) {
        await sendMultiChannel(n, `服务台月度报告 · ${prevYm}`, monthlyReportText(rep)).catch(() => {});
      }
      console.log(`[monthly-report] ${user.username} 已生成 ${prevYm} 月度报告`);
    }
    if (changed) writeJSON(DATA_FILE, data);
  } catch (e) { console.error('[!] 月度报告异常:', e.message); }
}
/* 到期自动归档——到期超 30 天没续的服务，分类改成“已归档”；
   归档的服务不进签到队列/临期提醒（dailyServices 和 expiringList 都按分类排除）；
   已闲置的不动（已经在边上了）；用户手动把分类改回去就恢复正常。
   归档记录记在 archivedLog 里（只留最近 50 条），不往服务备注里写 */
function archiveExpired(data, t) {
  const todo = [];
  for (const s of data.services) {
    if (isArchived(s) || s.category === 'idle') continue;
    if (!s.expiresAt || !/^\d{4}-\d{2}-\d{2}$/.test(s.expiresAt)) continue;
    if (daysUntilSrv(s.expiresAt) < -30) todo.push(s);
  }
  if (!todo.length) return [];
  const cats = ensureCategories(data);
  if (!cats.some((c) => c.id === ARCHIVED_CAT_ID)) cats.push({ ...ARCHIVED_CAT });
  const done = todo.map((s) => { s.category = ARCHIVED_CAT_ID; return { id: s.id, name: s.name, at: t }; });
  data.archivedLog = (Array.isArray(data.archivedLog) ? data.archivedLog : []).concat(done).slice(-50);
  return done;
}
/* 每天跑一次（放在每小时的提醒检查里）；没配通知渠道也照常归档；
   v67：按用户各跑各的（各记各的 flags.lastArchiveCheck） */
function archiveExpiredIfDue() {
  try {
    const data = loadData();
    const t = todayStr();
    let changed = false;
    for (const user of (data.users || [])) {
      const u = userData(data, user.id);
      ensureMeta(u);
      u.flags = u.flags || {};
      if (u.flags.lastArchiveCheck === t) continue;
      const done = archiveExpired(u, t);
      u.flags.lastArchiveCheck = t;
      changed = true;
      if (done.length) console.log(`[archive] ${user.username} 自动归档 ${done.length} 个过期服务`);
    }
    if (changed) writeJSON(DATA_FILE, data);
  } catch (e) { console.error('[!] 自动归档异常:', e.message); }
}
/* SSL 证书到期——对 https 的站取证书到期日（10 秒超时，失败就跳过，不影响死链检测） */
function getCertExpiry(hostname) {
  return new Promise((resolve) => {
    try {
      const socket = tls.connect({ host: hostname, port: 443, servername: hostname, timeout: 10000 });
      const done = (v) => { try { socket.destroy(); } catch {} resolve(v); };
      socket.once('error', () => done(null));
      socket.once('timeout', () => done(null));
      socket.once('secureConnect', () => {
        try {
          const cert = socket.getPeerCertificate();
          const exp = cert && cert.valid_to ? new Date(cert.valid_to) : null;
          if (!exp || Number.isNaN(exp.getTime())) return done(null);
          const d = new Date(exp.getTime() + 8 * 3600e3);
          done(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`);
        } catch { done(null); }
      });
    } catch { resolve(null); }
  });
}

/* v67：死链检测按用户跑——各用户的服务各探各的，合并结果一起返回 */
async function checkLinks() {
  try {
    const data = loadData();
    const total = { total: 0, dead: 0, ok: 0, unknown: 0, certs: 0, changed: false };
    for (const user of (data.users || [])) {
      const u = userData(data, user.id);
      ensureMeta(u);
      const r = await checkLinksForUser(user, u);
      if (!r) continue;
      total.total += r.total; total.dead += r.dead; total.ok += r.ok;
      total.unknown += r.unknown; total.certs += r.certs;
      if (r.changed) total.changed = true;
    }
    return total;
  } catch (e) { console.error('[!] 链接检测异常:', e.message); return null; }
}
async function checkLinksForUser(user, u) {
  try {
    const t = todayStr();
    const now = Date.now();
    const results = await Promise.all((u.services || []).map(async (s) => {
      const st = await probeLink(s.url);
      /* v65：https 的站顺手取证书到期日（失败就跳过，不影响死链结论） */
      let cert = null;
      const url = normLinkUrl(s.url);
      if (url.startsWith('https://')) {
        try { cert = await getCertExpiry(new URL(url).hostname); } catch { cert = null; }
      }
      return { id: s.id, st, cert };
    }));
    /* 探活要等网络，期间用户可能改过数据：写回前重新读盘，只合并 linkStatus 和 linkHistory，
       绝不把探活开始时的整盘快照写回去盖掉别人的改动（删掉的服务跳过）；
       v59：每次探活都记一笔（ok=通，dead=不通，unknown 不记——结论不明不算），只留最近 120 条（约 30 天） */
    const fresh = loadData();
    const fu = userData(fresh, user.id);
    let changed = false;
    for (const { id, st, cert } of results) {
      const s = fu.services.find((x) => x.id === id);
      if (!s) continue;
      if (s.linkStatus !== st) { s.linkStatus = st; s.linkCheckedAt = t; changed = true; }
      if (st === 'ok' || st === 'dead') {
        s.linkHistory = (Array.isArray(s.linkHistory) ? s.linkHistory : []).filter((h) => h && typeof h.t === 'number');
        s.linkHistory.push({ t: now, ok: st === 'ok' });
        if (s.linkHistory.length > 120) s.linkHistory = s.linkHistory.slice(-120);
        changed = true;
      }
      /* v65：证书到期日——取到了才记；到期日变了（或第一次记）才写盘，免得每 6 小时无意义刷数据 */
      if (cert && (s.certExpiresAt !== cert || !s.certCheckedAt)) {
        s.certExpiresAt = cert;
        s.certCheckedAt = t;
        changed = true;
      }
    }
    if (changed) writeJSON(DATA_FILE, fresh);
    return {
      total: results.length,
      dead: results.filter((r) => r.st === 'dead').length,
      ok: results.filter((r) => r.st === 'ok').length,
      unknown: results.filter((r) => r.st === 'unknown').length,
      certs: results.filter((r) => r.cert).length,
      changed
    };
  } catch (e) { console.error('[!] 链接检测异常:', e.message); return null; }
}
setInterval(() => { checkLinks(); }, 6 * 3600e3).unref();
setTimeout(() => { checkLinks(); }, 30e3).unref(); // 启动 30 秒后先探一轮，卡片不用等 6 小时

/* ---------- v60：自动签到——只对配了接口的服务发一次请求（带人机验证的站发了也签不上，
   所以只认 2xx + 响应里有 expect 文字才算签到成功；失败不记签到，照常 Telegram 提醒你手动签） ---------- */
async function tryAutoSignin(svc, cfg) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(cfg.url, {
      method: cfg.method,
      headers: cfg.headers,
      body: cfg.method === 'POST' && cfg.body ? cfg.body : undefined,
      signal: ctrl.signal,
      redirect: 'follow'
    });
    const text = await res.text().catch(() => '');
    const ok = res.status >= 200 && res.status < 300 && (!cfg.expect || text.includes(cfg.expect));
    return { ok, status: res.status, note: ok ? '' : (res.status >= 200 && res.status < 300 ? `响应里没找到“${cfg.expect}”` : `HTTP ${res.status}`) };
  } catch (e) {
    return { ok: false, status: 0, note: e.name === 'AbortError' ? '请求超时（15 秒）' : (e.message || '请求失败') };
  } finally { clearTimeout(to); }
}
async function runAutoSignins() {
  try {
    const data = loadData();
    const t = todayStr();
    const results = [];
    let changed = false;
    /* v67：自动签到按用户跑——各用户的服务各签各的 */
    for (const user of (data.users || [])) {
      const u = userData(data, user.id);
      ensureMeta(u);
      const due = checkinCohort(u, t);
      for (const svc of due) {
        const cfg = autoSigninOf(svc);
        if (!cfg) continue;
        if (serviceDoneToday(svc, t)) continue; // 今天已经签过了，不重复发
        const r = await tryAutoSignin(svc, cfg);
        svc.autoSigninLast = { at: cstDateTime(), ok: r.ok, status: r.status, note: r.note || '' };
        changed = true;
        if (r.ok) {
          doCheckin(u, svc, t);
          results.push({ id: svc.id, name: svc.name, ok: true });
        } else {
          results.push({ id: svc.id, name: svc.name, ok: false, note: r.note });
        }
      }
    }
    if (changed) writeJSON(DATA_FILE, data);
    if (results.length) console.log(`[auto-signin] ${results.filter((r) => r.ok).length}/${results.length} 成功`);
    return results;
  } catch (e) { console.error('[!] 自动签到异常:', e.message); return null; }
}
setInterval(() => { runAutoSignins(); }, 3600e3).unref();
setTimeout(() => { runAutoSignins(); }, 60e3).unref(); // 启动 1 分钟后先跑一轮

/* ---------- v60：GitHub 自动备份——每天把去掉敏感字段的数据推到一个私有仓库的单个文件里
   （hubmate-backup.json），Git 历史就是备份历史；数据没变就不推，免得刷屏 ---------- */
/* v67：单个用户的业务数据脱敏——API 令牌、二次验证密钥、通知渠道的密钥、自动签到请求头都不带出去 */
function strippedUserData(u) {
  const cu = { ...(u || {}) };
  delete cu.apiToken;
  delete cu.totpSecret;
  cu.services = (u.services || []).map((s) => {
    if (!s.autoSignin) return s;
    return { ...s, autoSignin: { ...s.autoSignin, headers: {} } };
  });
  cu.notify = { ...(u.notify || {}) };
  delete cu.notify.token;
  delete cu.notify.webhookUrl;
  delete cu.notify.barkKey;
  delete cu.notify.serverChanKey;
  return cu;
}
/* v67：整盘备份脱敏——所有用户的密码哈希都不带（恢复时用户账号不动），
   每位用户的业务数据各脱各的敏；GitHub 备份和手动下载都走这里 */
function strippedBackupData(data) {
  const out = { ...data };
  delete out.syncToken;
  /* 旧结构残留的顶层敏感字段（以防万一）也清掉 */
  delete out.passwordHash;
  delete out.apiToken;
  delete out.totpSecret;
  delete out.services;
  delete out.notify;
  out.users = (Array.isArray(data.users) ? data.users : []).map((x) => {
    const { passwordHash, ...rest } = x || {};
    return rest;
  });
  out.userData = {};
  for (const [uid, u] of Object.entries(data.userData || {})) {
    out.userData[uid] = strippedUserData(u);
  }
  out.githubBackup = { ...(data.githubBackup || {}) };
  delete out.githubBackup.token;
  return out;
}
async function pushGithubBackup() {
  try {
    const data = loadData();
    const gb = data.githubBackup || {};
    if (!gb.token || !gb.repo || !/^[^/\s]+\/[^/\s]+$/.test(gb.repo)) return null;
    const content = JSON.stringify(strippedBackupData(data), null, 2);
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    if (gb.lastHash === hash) return { ok: true, skipped: true };
    const branch = gb.branch || 'main';
    const [owner, repo] = gb.repo.split('/');
    const apiBase = `https://api.github.com/repos/${owner}/${repo}/contents/hubmate-backup.json`;
    const headers = { 'Authorization': `Bearer ${gb.token}`, 'Accept': 'application/vnd.github+json', 'User-Agent': 'hubmate' };
    let sha = null;
    try {
      const cur = await fetch(`${apiBase}?ref=${encodeURIComponent(branch)}`, { headers });
      if (cur.ok) { const j = await cur.json(); sha = j.sha || null; }
    } catch {}
    const res = await fetch(apiBase, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `hubmate backup ${todayStr()}`,
        content: Buffer.from(content).toString('base64'),
        branch,
        ...(sha ? { sha } : {})
      })
    });
    const ok = res.ok;
    const note = ok ? '' : `GitHub 返回 HTTP ${res.status}`;
    const fresh = loadData();
    fresh.githubBackup = { ...(fresh.githubBackup || {}), lastAt: cstDateTime(), lastOk: ok, lastNote: note, ...(ok ? { lastHash: hash } : {}) };
    writeJSON(DATA_FILE, fresh);
    console.log(`[github-backup] ${ok ? '成功' : '失败 ' + note}`);
    return { ok, note };
  } catch (e) { console.error('[!] GitHub 备份异常:', e.message); return { ok: false, note: e.message }; }
}
setInterval(() => { pushGithubBackup(); }, 24 * 3600e3).unref();
setTimeout(() => { pushGithubBackup(); }, 120e3).unref(); // 启动 2 分钟后跑一轮（数据没变就不推）

/* ---------- v61：多服务器同步——对等同步（last-write-wins，单人用够安全） ----------
   每台服务器配同一个同步口令（syncToken）和对方的地址（syncPeers）；
   启动时和每 5 分钟跟对方比一次：谁的数据文件更新（mtime 更大）就赢，
   赢的那份整盘同步过去；内容一样（hash 相同）就不动。掉线的服务器启动后
   自动从对方拉最新数据。注意：别在同一秒内往两台服务器上写东西（会丢一份），
   平时只用一台写，另一台就是热备。同步口令能读写整盘数据，千万别外泄。 */
function dataMtime() {
  try { return fs.statSync(DATA_FILE).mtimeMs; } catch { return 0; }
}
function dataHash(data) {
  /* 同步用的内容哈希：去掉各服务器自己的同步配置（口令/对方地址/上次同步），
     只比用户数据本身——不然两台服务器的对方地址永远不同，hash 永远对不上，会来回推 */
  const { syncToken, syncPeers, syncLast, ...rest } = data || {};
  return crypto.createHash('sha256').update(JSON.stringify(rest)).digest('hex');
}
function syncTokenOk(req, body) {
  const data = loadData();
  const tok = data.syncToken || '';
  if (!tok) return false;
  let got = '';
  try { got = new URL(req.url, 'http://x').searchParams.get('token') || ''; } catch {}
  if (!got && body && typeof body.token === 'string') got = body.token;
  if (!got) {
    const h = req.headers.authorization || '';
    const m = h.match(/^Bearer\s+(\S+)$/i);
    if (m) got = m[1];
  }
  return got === tok;
}
async function syncWithPeers() {
  try {
    const data = loadData();
    const peers = (Array.isArray(data.syncPeers) ? data.syncPeers : []).map((u) => String(u).trim()).filter((u) => /^https?:\/\//i.test(u));
    const tok = data.syncToken || '';
    if (!tok || !peers.length) return null;
    const localMtime = dataMtime();
    const localHash = dataHash(data);
    let pulled = 0, pushed = 0;
    for (const peer of peers) {
      try {
        const base = peer.replace(/\/+$/, '');
        const stRes = await fetch(`${base}/api/sync/status?token=${encodeURIComponent(tok)}`, { signal: AbortSignal.timeout(10000) });
        if (!stRes.ok) continue;
        const st = await stRes.json();
        if (!st || typeof st.mtime !== 'number' || !st.hash) continue;
        if (st.hash === localHash) continue;
        if (st.mtime > localMtime + 1000) {
          /* 对方更新：拉过来整盘替换（先自动备份当前数据，保留最近 5 份） */
          const pullRes = await fetch(`${base}/api/sync/pull?token=${encodeURIComponent(tok)}`, { signal: AbortSignal.timeout(30000) });
          if (!pullRes.ok) continue;
          const imp = await pullRes.json();
          /* v67：同步的是整盘新结构（users + userData），旧结构不认 */
          if (!imp || !imp.data || !Array.isArray(imp.data.users)) continue;
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          try {
            fs.writeFileSync(path.join(DATA_DIR, `sync-before-import-${stamp}.json`), JSON.stringify(data, null, 2));
            const olds = fs.readdirSync(DATA_DIR).filter((f) => f.startsWith('sync-before-import-')).sort();
            while (olds.length > 5) fs.unlinkSync(path.join(DATA_DIR, olds.shift()));
          } catch {}
          const keepToken = data.syncToken, keepPeers = data.syncPeers;
          const next = imp.data;
          next.syncToken = keepToken; next.syncPeers = keepPeers;
          writeJSON(DATA_FILE, next);
          pulled++;
          console.log(`[sync] 从 ${base} 拉取了新数据`);
        } else if (localMtime > st.mtime + 1000) {
          /* 本地更新：推过去 */
          const pushRes = await fetch(`${base}/api/sync/push`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: tok, data, mtime: localMtime, hash: localHash }),
            signal: AbortSignal.timeout(30000)
          });
          if (pushRes.ok) { const j = await pushRes.json().catch(() => ({})); if (j.applied) pushed++; }
        }
      } catch (e) { console.error(`[sync] ${peer} 同步失败:`, e.message); }
    }
    if (pulled || pushed) {
      const fresh = loadData();
      fresh.syncLast = { at: cstDateTime(), pulled, pushed };
      writeJSON(DATA_FILE, fresh);
    }
    return { pulled, pushed };
  } catch (e) { console.error('[!] 多服务器同步异常:', e.message); return null; }
}
setInterval(() => { syncWithPeers(); }, 5 * 60e3).unref();
setTimeout(() => { syncWithPeers(); }, 30e3).unref(); // 启动 30 秒后先同步一轮（掉线回来自动追平）
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

/* ---------- v67：备份恢复（按用户归属）——把一份用户业务数据（新格式的 userData 条目，
   或旧格式的整盘顶层对象）恢复进指定用户；用户账号（users/inviteCodes）永远不动；
   通知渠道的密钥永远沿用当前值，不被备份盖掉 */
function restoreUserData(data, userId, imp) {
  const u = userData(data, userId);
  ensureMeta(u);
  const cats = Array.isArray(imp.categories) && imp.categories.length
    ? imp.categories.filter((c) => c && typeof c.id === 'string' && typeof c.label === 'string' && c.label.trim())
    : categoriesOf(u);
  const catIds = new Set(cats.map((c) => c.id));
  const seen = new Set();
  u.services = imp.services.filter((s) => { if (seen.has(String(s.id))) return false; seen.add(String(s.id)); return true; }).map((s) => ({
    id: String(s.id),
    name: String(s.name).slice(0, 100),
    category: catIds.has(s.category) ? s.category : 'relay',
    url: String(s.url || '').slice(0, 500),
    icon: (typeof s.icon === 'string' && s.icon.startsWith('data:image/')) ? s.icon.slice(0, 20000) : undefined,
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
    abnormal: !!s.abnormal,
    accounts: (Array.isArray(s.accounts) ? s.accounts : []).map(sanitizeAccount).filter(Boolean).slice(0, 20),
    checkins: Array.isArray(s.checkins) ? s.checkins.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)) : [],
    visits: Number(s.visits) || 0,
    sortOrder: Number(s.sortOrder) || 0,
    linkStatus: s.linkStatus,
    linkHistory: (Array.isArray(s.linkHistory) ? s.linkHistory : []).filter((h) => h && typeof h.t === 'number' && typeof h.ok === 'boolean').slice(-120),
    renewHistory: (Array.isArray(s.renewHistory) ? s.renewHistory : []).filter((h) => h && /^\d{4}-\d{2}-\d{2}$/.test(h.at || '') && typeof h.from === 'string' && typeof h.to === 'string').slice(-20),
    tags: (Array.isArray(s.tags) ? s.tags : []).map((t) => String(t).trim().slice(0, 20)).filter(Boolean).slice(0, 10),
    customFields: sanitizeCustomFields(s.customFields),
    autoSignin: sanitizeAutoSignin(s.autoSignin),
    autoSigninLast: (s.autoSigninLast && typeof s.autoSigninLast === 'object') ? { at: String(s.autoSigninLast.at || '').slice(0, 30), ok: !!s.autoSigninLast.ok, status: Number(s.autoSigninLast.status) || 0, note: String(s.autoSigninLast.note || '').slice(0, 200) } : undefined,
    /* v65：证书到期日、建站日期也随备份恢复 */
    certExpiresAt: /^\d{4}-\d{2}-\d{2}$/.test(s.certExpiresAt || '') ? s.certExpiresAt : undefined,
    certCheckedAt: /^\d{4}-\d{2}-\d{2}$/.test(s.certCheckedAt || '') ? s.certCheckedAt : undefined,
    createdAt: /^\d{4}-\d{2}-\d{2}$/.test(s.createdAt || '') ? s.createdAt : undefined
  }));
  /* v65：先恢复共享账号库，再归一化账号——链接账号要按库解析（库里没有就退回成本地副本） */
  if (Array.isArray(imp.sharedAccounts)) {
    u.sharedAccounts = imp.sharedAccounts.map(sanitizeVaultAccount).filter(Boolean).slice(0, 200);
  }
  /* v62：恢复后归一化账号——默认账号的镜像（account/secret）跟恢复回来的 accounts 走，
     不然旧备份里只有镜像、没有 accounts 数组的服务会丢账号 */
  u.services.forEach((s) => normalizeAccounts(s, vaultOf(u)));
  u.categories = cats.map((c) => ({ id: c.id, label: String(c.label).slice(0, 20), icon: cleanIcon(c.icon), cls: c.cls || 't-custom' }));
  if (imp.history && typeof imp.history === 'object') u.history = imp.history;
  if (imp.achievements && typeof imp.achievements === 'object') u.achievements = imp.achievements;
  if (Number(imp.xp) >= 0) u.xp = Number(imp.xp);
  if (imp.flags && typeof imp.flags === 'object') u.flags = imp.flags;
  /* v65：月度报告、登录历史、归档日志也随备份恢复（都是用户自己的数据，不含密钥） */
  if (Array.isArray(imp.monthlyReports)) u.monthlyReports = imp.monthlyReports.filter((r) => r && typeof r.ym === 'string').slice(-12);
  if (Array.isArray(imp.loginHistory)) u.loginHistory = imp.loginHistory.filter((h) => h && typeof h.at === 'string').slice(-50);
  if (Array.isArray(imp.archivedLog)) u.archivedLog = imp.archivedLog.filter((a) => a && typeof a.at === 'string').slice(-50);
  if (imp.notify && typeof imp.notify === 'object') {
    const n = notifyCfg(u);
    /* v62：Token、Webhook 地址、Bark Key、Server酱 Key 永远沿用当前值，不被备份盖掉 */
    const keep = { token: n.token, webhookUrl: n.webhookUrl, barkKey: n.barkKey, serverChanKey: n.serverChanKey };
    Object.assign(n, imp.notify);
    for (const k of ['token', 'webhookUrl', 'barkKey', 'serverChanKey']) {
      if (keep[k]) n[k] = keep[k]; else delete n[k];
    }
  }
  return u.services.length;
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
    const user = findUserByName(data, body.username);
    /* v67：先验密码再查封禁——不让没密码的人探出账号存不存在、封没封禁 */
    if (!user || !verifyPassword(body.password, user.passwordHash)) {
      return send(401, { error: '用户名或密码不对' });
    }
    if (user.banned) return send(403, { error: '账号已被封禁，请联系管理员' });
    const u = userData(data, user.id);
    ensureMeta(u);
    /* v60：开了二次验证的，密码对了还要验 6 位动态码；没填就告诉前端要填（密码已验过才到这一步） */
    if (u.totpEnabled && u.totpSecret) {
      if (!body.totp) return send(401, { error: 'need_totp' });
      if (!verifyTotp(u.totpSecret, body.totp)) return send(401, { error: '二次验证失败' });
    }
    const token = crypto.randomBytes(32).toString('hex');
    const sessions = loadSessions();
    sessions[token] = { created: Date.now(), userId: user.id };
    saveSessions(sessions);
    /* v65：登录历史——每次成功登录记一条（时间、IP、UA），只留最近 50 条；
       本次 IP 和上次不同、且配了 Telegram 时发一次异地登录提醒（不拦登录，提醒失败也不报错） */
    const prevLogin = (Array.isArray(u.loginHistory) ? u.loginHistory : []).slice(-1)[0];
    u.loginHistory = (Array.isArray(u.loginHistory) ? u.loginHistory : []).concat([{ at: cstDateTime(), ip, ua: String(req.headers['user-agent'] || '').slice(0, 300) }]).slice(-50);
    user.lastLoginAt = cstDateTime();
    writeJSON(DATA_FILE, data);
    if (prevLogin && prevLogin.ip && prevLogin.ip !== ip) {
      const n = notifyCfg(u);
      if (n.token && n.chatId) {
        tgSend(n.token, n.chatId, `🔐 <b>服务台异地登录提醒</b>\n你的账号在新 IP ${escHtml(ip)} 登录（${cstDateTime()}）。\n如果不是你本人，请立即改密码。`).catch(() => {});
      }
    }
    /* 反代 + HTTPS 时给 Cookie 加 Secure */
    const secure = TRUST_PROXY && String(req.headers['x-forwarded-proto'] || '').includes('https');
    return send(200, { ok: true, username: user.username, isAdmin: !!user.isAdmin }, {
      'Set-Cookie': `session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_MS / 1000}${secure ? '; Secure' : ''}`
    });
  }

  /* v67：注册——必须凭邀请码（第一个默认用户除外，他建站时就有了）；
     邀请码一次用完，注册成功即消耗；用户名全站唯一 */
  if (pathname === '/api/register' && req.method === 'POST') {
    const ip = clientIp(req);
    if (loginThrottled(ip)) {
      return send(429, { error: '尝试太频繁，请 10 分钟后再试' });
    }
    const body = await jsonBody(req);
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const code = String(body.inviteCode || '').trim().toUpperCase();
    if (!username || username.length > 20 || /\s/.test(username)) return send(400, { error: '用户名填 1–20 个字符，不能含空格' });
    if (!password || password.length < 6) return send(400, { error: '密码至少 6 位' });
    if (!code) return send(400, { error: '邀请码必填，没有就找管理员要一个' });
    const data = loadData();
    if (findUserByName(data, username)) return send(400, { error: '这个用户名已经被注册了' });
    const inv = (data.inviteCodes || []).find((c) => c && String(c.code || '').toUpperCase() === code);
    if (!inv) return send(400, { error: '邀请码不对' });
    if (inv.usedBy) return send(400, { error: '这个邀请码已经被用过了' });
    const user = { id: crypto.randomBytes(12).toString('hex'), username, passwordHash: hashPassword(password), passwordIsDefault: false, isAdmin: false, banned: false, createdAt: cstDateTime(), lastLoginAt: '' };
    data.users.push(user);
    userData(data, user.id); // 建一份空的业务数据
    inv.usedBy = username;
    inv.usedAt = cstDateTime();
    writeJSON(DATA_FILE, data);
    return send(200, { ok: true, username });
  }

  if (pathname === '/api/public' && req.method === 'GET') {
    const data = loadData();
    /* v67：公开落地页只显示第一个默认用户（管理员）的公开服务，和以前一样 */
    const admin = adminUser(data);
    const u = admin ? userData(data, admin.id) : defaultUserData();
    ensureMeta(u);
    const unlocked = syncAchievements(u);
    if (unlocked.length) writeJSON(DATA_FILE, data);
    const payload = metaPayload(admin || { username: 'jason', passwordIsDefault: false, isAdmin: true }, u);
    payload.services = publicServices(u);
    return send(200, payload);
  }

  /* ---------- 到期日历订阅：公开的 .ics（只有名字+到期日，和公开接口里的一样，不含账号密码） ----------
     iPhone 日历订阅后自动显示所有到期日，到期前 3 天和 1 天各提醒一次；服务续期后改了日期，
     日历下次抓取会自动更新（UID 是服务 id，稳定不变） */
  if (pathname === '/api/calendar.ics' && req.method === 'GET') {
    const data = loadData();
    /* v67：日历订阅只含第一个默认用户（管理员）的服务 */
    const admin = adminUser(data);
    const u = admin ? userData(data, admin.id) : defaultUserData();
    const escICS = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//HubMate//Expiry Calendar//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:HubMate 服务到期日'];
    for (const s of u.services) {
      if (!s.expiresAt || !/^\d{4}-\d{2}-\d{2}$/.test(s.expiresAt)) continue;
      lines.push('BEGIN:VEVENT');
      lines.push('UID:' + s.id + '@hubmate');
      lines.push('DTSTAMP:' + stamp);
      lines.push('DTSTART;VALUE=DATE:' + s.expiresAt.replace(/-/g, ''));
      lines.push('SUMMARY:' + escICS('服务到期：' + s.name));
      lines.push('DESCRIPTION:' + escICS(`注册 ${s.registeredAt || '—'}，续期周期 ${s.renewDays ?? 365} 天${s.url ? '，' + s.url : ''}`));
      lines.push('BEGIN:VALARM', 'TRIGGER:-P3D', 'ACTION:DISPLAY', 'DESCRIPTION:' + escICS('服务到期提醒：' + s.name), 'END:VALARM');
      lines.push('BEGIN:VALARM', 'TRIGGER:-P1D', 'ACTION:DISPLAY', 'DESCRIPTION:' + escICS('服务到期提醒：' + s.name), 'END:VALARM');
      lines.push('END:VEVENT');
    }
    lines.push('END:VCALENDAR');
    const buf = Buffer.from(lines.join('\r\n'), 'utf8');
    res.writeHead(200, Object.assign({ 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'no-store' }, SEC_HEADERS));
    res.end(buf);
    return;
  }

  /* ---------- v61：多服务器同步的对端接口——用同步口令认证，不走登录会话 ----------
     口令能读写整盘数据，务必只配在自己的服务器之间，别外泄 */
  if (pathname === '/api/sync/status' && req.method === 'GET') {
    if (!syncTokenOk(req, null)) return send(401, { error: '同步口令不对' });
    const data = loadData();
    /* v67：服务总数按所有用户加起来算 */
    const totalServices = Object.values(data.userData || {}).reduce((n, u) => n + ((u && u.services) || []).length, 0);
    return send(200, { ok: true, mtime: dataMtime(), hash: dataHash(data), services: totalServices });
  }
  if (pathname === '/api/sync/pull' && req.method === 'GET') {
    if (!syncTokenOk(req, null)) return send(401, { error: '同步口令不对' });
    const data = loadData();
    return send(200, { ok: true, mtime: dataMtime(), hash: dataHash(data), data });
  }
  if (pathname === '/api/sync/push' && req.method === 'POST') {
    const body = await jsonBody(req);
    if (!syncTokenOk(req, body)) return send(401, { error: '同步口令不对' });
    /* v67：同步的是整盘新结构（users + userData），旧结构不认 */
    if (!body.data || !Array.isArray(body.data.users)) return send(400, { error: '同步数据不对' });
    const data = loadData();
    const localMtime = dataMtime();
    const localHash = dataHash(data);
    if (body.hash && body.hash === localHash) return send(200, { ok: true, applied: false });
    if (typeof body.mtime === 'number' && body.mtime <= localMtime + 1000) return send(200, { ok: true, applied: false });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    try {
      fs.writeFileSync(path.join(DATA_DIR, `sync-before-import-${stamp}.json`), JSON.stringify(data, null, 2));
      const olds = fs.readdirSync(DATA_DIR).filter((f) => f.startsWith('sync-before-import-')).sort();
      while (olds.length > 5) fs.unlinkSync(path.join(DATA_DIR, olds.shift()));
    } catch {}
    const keepToken = data.syncToken, keepPeers = data.syncPeers;
    const next = body.data;
    next.syncToken = keepToken; next.syncPeers = keepPeers;
    next.syncLast = { at: cstDateTime(), pulled: 1, pushed: 0 };
    writeJSON(DATA_FILE, next);
    return send(200, { ok: true, applied: true });
  }

  /* ---------- v62：浏览器扩展按域名取账号——登录会话或 API 令牌都认；
     只返回和这个域名匹配的服务的账号（精确域名或子域名），别的服务一律不返回 */
  if (pathname === '/api/accounts/by-domain' && req.method === 'GET') {
    const cu = currentUser(req);
    const tu = !cu ? isApiToken(req) : null;
    if (!cu && !tu) return send(401, { error: '未登录' });
    const raw = new URL(req.url, 'http://x').searchParams.get('domain') || '';
    const dom = raw.trim().toLowerCase().replace(/^www\./, '').replace(/:\d+$/, '');
    if (!dom || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(dom)) return send(400, { error: '域名不对' });
    const data = loadData();
    /* v67：只返回当前登录用户自己的服务里的账号 */
    const me0 = findUser(data, cu ? cu.userId : tu);
    if (!me0 || me0.banned) return send(401, { error: '未登录' });
    const u = userData(data, me0.id);
    const out = [];
    for (const s of u.services) {
      let host = '';
      try { host = new URL(/^https?:\/\//i.test(s.url || '') ? s.url : 'https://' + (s.url || '')).hostname.toLowerCase().replace(/^www\./, ''); } catch { continue; }
      if (!host || !(host === dom || host.endsWith('.' + dom))) continue;
      for (const a of serviceAccounts(s)) {
        /* v65：链接账号返回库里的用户名/密码（以库为准） */
        const acc = resolveVaultAccount(vaultOf(u), a) || a;
        out.push({ serviceId: s.id, serviceName: s.name, label: a.label || '', username: acc.username || '', password: acc.password || '', url: s.url || '' });
      }
      if (out.length >= 20) break;
    }
    return send(200, { ok: true, domain: dom, accounts: out.slice(0, 20) });
  }

  const auth = currentUser(req);
  /* v59：API 令牌只放行签到接口（没登录也能用令牌签到），别的接口仍要登录；
     v67：令牌属于哪个用户，签到就签谁的服务 */
  const apiUserId = !auth ? isApiToken(req) : null;
  const tokenAllowed = !!apiUserId && isTokenAllowedEndpoint(pathname, req.method);
  if (!auth && !tokenAllowed) return send(401, { error: '未登录' });
  const meId = auth ? auth.userId : apiUserId;
  /* v67：封禁的用户（会话或 API 令牌）一律拒绝 */
  {
    const chk = findUser(loadData(), meId);
    if (!chk) return send(401, { error: '未登录' });
    if (chk.banned) return send(403, { error: '账号已被封禁，请联系管理员' });
  }

  /* v67：改自己的用户名——要输当前密码确认，全站唯一；改名后邀请码里的 usedBy 跟着改 */
  if (pathname === '/api/account/rename' && req.method === 'POST') {
    const body = await jsonBody(req);
    const data = loadData();
    const me = findUser(data, meId); const u = userData(data, meId); ensureMeta(u);
    const newName = String(body.username || '').trim();
    if (!newName || newName.length > 20 || /\s/.test(newName)) return send(400, { error: '用户名填 1–20 个字符，不能含空格' });
    if (!verifyPassword(body.password, me.passwordHash)) return send(401, { error: '密码不对' });
    const dup = findUserByName(data, newName);
    if (dup && dup.id !== me.id) return send(400, { error: '这个用户名已经被注册了' });
    if (dup && dup.id === me.id) return send(200, { ok: true, username: me.username });
    const old = me.username;
    me.username = newName;
    for (const c of (data.inviteCodes || [])) if (c.usedBy === old) c.usedBy = newName;
    writeJSON(DATA_FILE, data);
    return send(200, { ok: true, username: newName });
  }

  /* ---------- v67：用户管理 + 邀请码——只有第一个默认用户（管理员）能用 ----------
     管理员能看/建/改名/重置密码/封禁/删用户，但看不到也改不了任何用户的服务、笔记、
     账号等业务数据；用户管理接口只返回账号信息 */
  const requireAdmin = () => {
    const data = loadData();
    const me = findUser(data, meId);
    if (!me || !me.isAdmin) return null;
    return { data, me };
  };
  if (pathname === '/api/admin/users' && req.method === 'GET') {
    const a = requireAdmin();
    if (!a) return send(403, { error: '只有管理员能用这个功能' });
    return send(200, { ok: true, users: (a.data.users || []).map((x) => publicUser(a.data, x)) });
  }
  if (pathname === '/api/admin/users' && req.method === 'POST') {
    const a = requireAdmin();
    if (!a) return send(403, { error: '只有管理员能用这个功能' });
    const body = await jsonBody(req);
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    if (!username || username.length > 20 || /\s/.test(username)) return send(400, { error: '用户名填 1–20 个字符，不能含空格' });
    if (!password || password.length < 6) return send(400, { error: '密码至少 6 位' });
    if (findUserByName(a.data, username)) return send(400, { error: '这个用户名已经被注册了' });
    const user = { id: crypto.randomBytes(12).toString('hex'), username, passwordHash: hashPassword(password), passwordIsDefault: true, isAdmin: false, banned: false, createdAt: cstDateTime(), lastLoginAt: '' };
    a.data.users.push(user);
    userData(a.data, user.id);
    writeJSON(DATA_FILE, a.data);
    return send(200, { ok: true, user: publicUser(a.data, user) });
  }
  const au = pathname.match(/^\/api\/admin\/users\/([0-9a-f]+)(\/(reset-password|ban))?$/);
  if (au && (req.method === 'PUT' || req.method === 'POST' || req.method === 'DELETE')) {
    const a = requireAdmin();
    if (!a) return send(403, { error: '只有管理员能用这个功能' });
    const target = findUser(a.data, au[1]);
    if (!target) return send(404, { error: '找不到该用户' });
    if (req.method === 'PUT' && !au[2]) {
      /* 改别人的用户名 */
      const body = await jsonBody(req);
      const newName = String(body.username || '').trim();
      if (!newName || newName.length > 20 || /\s/.test(newName)) return send(400, { error: '用户名填 1–20 个字符，不能含空格' });
      const dup = findUserByName(a.data, newName);
      if (dup && dup.id !== target.id) return send(400, { error: '这个用户名已经被注册了' });
      const old = target.username;
      target.username = newName;
      for (const c of (a.data.inviteCodes || [])) if (c.usedBy === old) c.usedBy = newName;
      writeJSON(DATA_FILE, a.data);
      return send(200, { ok: true, user: publicUser(a.data, target) });
    }
    if (req.method === 'POST' && au[2] === '/reset-password') {
      /* 重置密码：管理员填了就用填的，没填就随机生成一个并只返回这一次；
         重置后该用户是默认密码状态，下次登录会提示改密码 */
      const body = await jsonBody(req);
      let pw = String(body.password || '');
      if (pw && pw.length < 6) return send(400, { error: '密码至少 6 位' });
      if (!pw) {
        const abc = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
        pw = '';
        for (let i = 0; i < 12; i++) pw += abc[crypto.randomInt(abc.length)];
      }
      target.passwordHash = hashPassword(pw);
      target.passwordIsDefault = true;
      writeJSON(DATA_FILE, a.data);
      return send(200, { ok: true, password: pw });
    }
    if (req.method === 'POST' && au[2] === '/ban') {
      const body = await jsonBody(req);
      if (target.id === a.me.id) return send(400, { error: '不能封禁自己' });
      if (target.isAdmin) return send(400, { error: '不能封禁管理员' });
      target.banned = !!body.banned;
      writeJSON(DATA_FILE, a.data);
      return send(200, { ok: true, user: publicUser(a.data, target) });
    }
    if (req.method === 'DELETE' && !au[2]) {
      if (target.id === a.me.id) return send(400, { error: '不能删除自己' });
      if (target.isAdmin) return send(400, { error: '不能删除管理员' });
      a.data.users = a.data.users.filter((x) => x.id !== target.id);
      if (a.data.userData) delete a.data.userData[target.id];
      writeJSON(DATA_FILE, a.data);
      return send(200, { ok: true });
    }
  }
  if (pathname === '/api/admin/invite-codes' && req.method === 'GET') {
    const a = requireAdmin();
    if (!a) return send(403, { error: '只有管理员能用这个功能' });
    const list = (a.data.inviteCodes || []).slice().sort((x, y) => String(y.createdAt || '').localeCompare(String(x.createdAt || '')));
    return send(200, { ok: true, codes: list });
  }
  if (pathname === '/api/admin/invite-codes' && req.method === 'POST') {
    const a = requireAdmin();
    if (!a) return send(403, { error: '只有管理员能用这个功能' });
    const used = new Set((a.data.inviteCodes || []).map((c) => c.code));
    let code = '';
    do { code = makeInviteCode(); } while (used.has(code));
    const inv = { code, createdAt: cstDateTime(), usedBy: null, usedAt: '' };
    a.data.inviteCodes = a.data.inviteCodes || [];
    a.data.inviteCodes.push(inv);
    writeJSON(DATA_FILE, a.data);
    return send(200, { ok: true, code: inv });
  }
  const ic = pathname.match(/^\/api\/admin\/invite-codes\/(HUB-[A-Za-z0-9-]+)$/);
  if (ic && req.method === 'DELETE') {
    const a = requireAdmin();
    if (!a) return send(403, { error: '只有管理员能用这个功能' });
    const idx = (a.data.inviteCodes || []).findIndex((c) => c.code === ic[1]);
    if (idx < 0) return send(404, { error: '找不到这个邀请码' });
    if (a.data.inviteCodes[idx].usedBy) return send(400, { error: '已使用过的邀请码不用作废' });
    a.data.inviteCodes.splice(idx, 1);
    writeJSON(DATA_FILE, a.data);
    return send(200, { ok: true });
  }

  /* v59：API 令牌管理——生成/作废都要登录；令牌只在生成那一刻返回一次，平时只告诉你有没有 */
  if (pathname === '/api/api-token/status' && req.method === 'GET') {
    const data = loadData();
    const me = findUser(data, meId); const u = userData(data, meId); ensureMeta(u);
    return send(200, { hasToken: !!u.apiToken });
  }
  /* v65：共享账号库——账号只存一份；服务账号带 sharedId 就是链接它（以库为准）；
     库里改密码，所有链接跟着变；库里删账号，链接的服务账号自动变回本地副本。
     密码只在登录后返回（和服务账号同口径），公开接口里永远没有库里的密码 */
  if (pathname === '/api/vault' && req.method === 'GET') {
    const data = loadData();
    const me = findUser(data, meId); const u = userData(data, meId); ensureMeta(u);
    const vault = vaultOf(u);
    const counts = {};
    for (const s of u.services) for (const a of serviceAccounts(s)) if (a.sharedId) counts[a.sharedId] = (counts[a.sharedId] || 0) + 1;
    return send(200, { ok: true, accounts: vault.map((v) => ({ ...v, linked: counts[v.id] || 0 })) });
  }
  if (pathname === '/api/vault' && req.method === 'POST') {
    const body = await jsonBody(req);
    const data = loadData();
    const me = findUser(data, meId); const u = userData(data, meId); ensureMeta(u);
    const vault = vaultOf(u);
    const v = sanitizeVaultAccount(body);
    if (!v || !v.username) return send(400, { error: '账号不能为空' });
    v.id = crypto.randomBytes(6).toString('hex');
    if (v.password) v.passwordChangedAt = todayStr();
    vault.push(v);
    writeJSON(DATA_FILE, data);
    return send(200, { ok: true, account: v });
  }
  const vm = pathname.match(/^\/api\/vault\/([A-Za-z0-9_-]+)$/);
  if (vm && req.method === 'PUT') {
    const body = await jsonBody(req);
    const data = loadData();
    const me = findUser(data, meId); const u = userData(data, meId); ensureMeta(u);
    const vault = vaultOf(u);
    const v = vault.find((x) => x.id === vm[1]);
    if (!v) return send(404, { error: '找不到该账号' });
    const next = sanitizeVaultAccount({ ...v, ...body, id: v.id });
    if (!next || !next.username) return send(400, { error: '账号不能为空' });
    /* 密码变了就记今天为改密日；没变就沿用旧的 */
    if (next.password !== v.password) next.passwordChangedAt = todayStr();
    else if (v.passwordChangedAt) next.passwordChangedAt = v.passwordChangedAt;
    Object.assign(v, next);
    /* 库里改了，所有链接它的服务账号快照跟着同步（读时也以库为准，这里是双保险） */
    for (const s of u.services) {
      for (const a of serviceAccounts(s)) {
        if (a.sharedId === v.id) { a.username = v.username; a.password = v.password; if (v.passwordChangedAt) a.passwordChangedAt = v.passwordChangedAt; }
      }
      normalizeAccounts(s, vault);
    }
    writeJSON(DATA_FILE, data);
    return send(200, { ok: true, account: v });
  }
  if (vm && req.method === 'DELETE') {
    const data = loadData();
    const me = findUser(data, meId); const u = userData(data, meId); ensureMeta(u);
    const vault = vaultOf(u);
    const idx = vault.findIndex((x) => x.id === vm[1]);
    if (idx < 0) return send(404, { error: '找不到该账号' });
    const v = vault[idx];
    /* 删库账号：链接它的服务账号变回本地副本（快照就是库里的账号密码，不丢数据） */
    for (const s of u.services) {
      for (const a of serviceAccounts(s)) {
        if (a.sharedId === v.id) { delete a.sharedId; a.username = v.username; a.password = v.password; if (v.passwordChangedAt) a.passwordChangedAt = v.passwordChangedAt; }
      }
      normalizeAccounts(s, vault);
    }
    vault.splice(idx, 1);
    writeJSON(DATA_FILE, data);
    return send(200, { ok: true });
  }
  /* v65：最近登录——列出最近 10 条登录记录（时间、IP、UA 原文，设备由前端按 UA 粗取） */
  if (pathname === '/api/login-history' && req.method === 'GET') {
    const data = loadData();
    const me = findUser(data, meId); const u = userData(data, meId); ensureMeta(u);
    const list = (Array.isArray(u.loginHistory) ? u.loginHistory : []).slice(-10).reverse();
    return send(200, { ok: true, logins: list });
  }
  /* v65：月度报告——存在 monthlyReports 里（每月一条，只留最近 12 条）；
     每月 1 号自动生成上月报告并推 Telegram；这里可以手动生成/查看最近 6 条 */
  if (pathname === '/api/monthly-reports' && req.method === 'GET') {
    const data = loadData();
    const me = findUser(data, meId); const u = userData(data, meId); ensureMeta(u);
    const list = (Array.isArray(u.monthlyReports) ? u.monthlyReports : []).slice().sort((a, b) => String(b.ym).localeCompare(String(a.ym))).slice(0, 6);
    return send(200, { ok: true, reports: list });
  }
  if (pathname === '/api/monthly-report/generate' && req.method === 'POST') {
    const body = await jsonBody(req);
    const data = loadData();
    const me = findUser(data, meId); const u = userData(data, meId); ensureMeta(u);
    let ym = String(body.ym || '').trim();
    if (!/^\d{4}-\d{2}$/.test(ym)) {
      const t = todayStr();
      const [cy, cm] = t.split('-').map(Number);
      ym = cm === 1 ? `${cy - 1}-12` : `${cy}-${String(cm - 1).padStart(2, '0')}`;
    }
    const rep = buildMonthlyReport(u, ym);
    u.monthlyReports = (Array.isArray(u.monthlyReports) ? u.monthlyReports : []).filter((r) => r.ym !== ym);
    u.monthlyReports.push(rep);
    if (u.monthlyReports.length > 12) u.monthlyReports = u.monthlyReports.slice(-12);
    writeJSON(DATA_FILE, data);
    return send(200, { ok: true, report: rep });
  }
  if (pathname === '/api/api-token' && req.method === 'POST') {
    const data = loadData();
    const me = findUser(data, meId); const u = userData(data, meId); ensureMeta(u);
    u.apiToken = crypto.randomBytes(24).toString('hex');
    writeJSON(DATA_FILE, data);
    return send(200, { ok: true, token: u.apiToken });
  }
  if (pathname === '/api/api-token/revoke' && req.method === 'POST') {
    const data = loadData();
    const me = findUser(data, meId); const u = userData(data, meId); ensureMeta(u);
    delete u.apiToken;
    writeJSON(DATA_FILE, data);
    return send(200, { ok: true });
  }
  /* v60：GitHub 自动备份——配好 Token 和私有仓库后，每天自动把数据推过去；手动也能立即推 */
  if (pathname === '/api/github-backup/status' && req.method === 'GET') {
    const data = loadData();
    const me = findUser(data, meId); const u = userData(data, meId); ensureMeta(u);
    const gb = data.githubBackup || {};
    return send(200, { configured: !!(gb.token && gb.repo), repo: gb.repo || '', branch: gb.branch || 'main', lastAt: gb.lastAt || '', lastOk: !!gb.lastOk, lastNote: gb.lastNote || '' });
  }
  if (pathname === '/api/github-backup/save' && req.method === 'POST') {
    const body = await jsonBody(req);
    const data = loadData();
    const me = findUser(data, meId); const u = userData(data, meId); ensureMeta(u);
    const gb = data.githubBackup || {};
    const token = String(body.token || '').trim();
    const repo = String(body.repo || '').trim();
    if (repo && !/^[^/\s]+\/[^/\s]+$/.test(repo)) return send(400, { error: '仓库格式不对，填“用户名/仓库名”，比如 jasonssuns-prog/hubmate-data' });
    if (token) gb.token = token;
    if (repo) gb.repo = repo;
    gb.branch = String(body.branch || 'main').trim() || 'main';
    data.githubBackup = gb;
    writeJSON(DATA_FILE, data);
    return send(200, { ok: true, configured: !!(gb.token && gb.repo) });
  }
  if (pathname === '/api/github-backup/run' && req.method === 'POST') {
    const r = await pushGithubBackup();
    if (!r) return send(400, { error: '还没配好 Token 或仓库' });
    if (r.skipped) return send(200, { ok: true, skipped: true, note: '数据没变，不用推' });
    if (!r.ok) return send(400, { error: r.note || '备份失败' });
    return send(200, { ok: true });
  }
  /* v61：多服务器同步的设置——口令只在生成那一刻返回一次；对方地址一行一个；
     同步口令能读写整盘数据，只配在自己的服务器之间，别外泄 */
  if (pathname === '/api/sync/config' && req.method === 'GET') {
    const data = loadData();
    const me = findUser(data, meId); const u = userData(data, meId); ensureMeta(u);
    const last = data.syncLast || {};
    return send(200, { configured: !!(data.syncToken && (data.syncPeers || []).length), hasToken: !!data.syncToken, peers: data.syncPeers || [], lastAt: last.at || '', lastPulled: last.pulled || 0, lastPushed: last.pushed || 0 });
  }
  if (pathname === '/api/sync/token' && req.method === 'POST') {
    const data = loadData();
    const me = findUser(data, meId); const u = userData(data, meId); ensureMeta(u);
    data.syncToken = crypto.randomBytes(32).toString('hex');
    writeJSON(DATA_FILE, data);
    return send(200, { ok: true, token: data.syncToken });
  }
  if (pathname === '/api/sync/config' && req.method === 'POST') {
    const body = await jsonBody(req);
    const data = loadData();
    const me = findUser(data, meId); const u = userData(data, meId); ensureMeta(u);
    const token = String(body.token || '').trim();
    if (token) data.syncToken = token;
    const peers = (Array.isArray(body.peers) ? body.peers : String(body.peers || '').split('\n')).map((u) => String(u).trim()).filter((u) => /^https?:\/\//i.test(u)).slice(0, 5);
    data.syncPeers = peers;
    writeJSON(DATA_FILE, data);
    return send(200, { ok: true, configured: !!(data.syncToken && peers.length) });
  }
  if (pathname === '/api/sync/run' && req.method === 'POST') {
    const r = await syncWithPeers();
    if (!r) return send(400, { error: '还没配好同步口令或对方地址' });
    return send(200, { ok: true, pulled: r.pulled, pushed: r.pushed });
  }
  if (pathname === '/api/totp/status' && req.method === 'GET') {
    const data = loadData();
    const me = findUser(data, meId); const u = userData(data, meId); ensureMeta(u);
    return send(200, { enabled: !!u.totpEnabled });
  }
  if (pathname === '/api/totp/setup' && req.method === 'POST') {
    const data = loadData();
    const me = findUser(data, meId); const u = userData(data, meId); ensureMeta(u);
    u.totpSecret = base32Encode(crypto.randomBytes(20));
    u.totpEnabled = false;
    writeJSON(DATA_FILE, data);
    const label = encodeURIComponent(`hubmate:${me.username || 'user'}`);
    const otpauth = `otpauth://totp/${label}?secret=${u.totpSecret}&issuer=hubmate&algorithm=SHA1&digits=6&period=30`;
    return send(200, { ok: true, secret: u.totpSecret, otpauth });
  }
  if (pathname === '/api/totp/enable' && req.method === 'POST') {
    const body = await jsonBody(req);
    const data = loadData();
    const me = findUser(data, meId); const u = userData(data, meId); ensureMeta(u);
    if (!u.totpSecret) return send(400, { error: '先点“生成密钥”' });
    if (!verifyTotp(u.totpSecret, body.code)) return send(401, { error: '动态码不对，请对一下手机时间' });
    u.totpEnabled = true;
    writeJSON(DATA_FILE, data);
    return send(200, { ok: true });
  }
  if (pathname === '/api/totp/disable' && req.method === 'POST') {
    const body = await jsonBody(req);
    const data = loadData();
    const me = findUser(data, meId); const u = userData(data, meId); ensureMeta(u);
    if (!verifyPassword(body.password, me.passwordHash)) return send(401, { error: '密码不对' });
    if (u.totpEnabled && !verifyTotp(u.totpSecret, body.code)) return send(401, { error: '动态码不对' });
    delete u.totpSecret;
    u.totpEnabled = false;
    writeJSON(DATA_FILE, data);
    return send(200, { ok: true });
  }

  /* ---------- 记事本：仅登录后可用，不进公开接口、不上落地页 ---------- */
  if (pathname === '/api/notes' && req.method === 'GET') {
    const data = loadData();
    const me = findUser(data, meId); const u = userData(data, meId); ensureMeta(u);
    return send(200, (u.notes || []).slice().sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')));
  }
  if (pathname === '/api/notes' && req.method === 'POST') {
    const data = loadData();
    const me = findUser(data, meId); const u = userData(data, meId); ensureMeta(u);
    const b = await jsonBody(req);
    const title = String(b.title || '').trim().slice(0, 100);
    const content = String(b.content || '').trim().slice(0, 20000);
    if (!title && !content) return send(400, { error: '标题和内容不能都空' });
    const now = cstDateTime();
    const note = { id: crypto.randomBytes(12).toString('hex'), title, content, createdAt: now, updatedAt: now };
    u.notes = u.notes || [];
    u.notes.unshift(note);
    writeJSON(DATA_FILE, data);
    return send(200, note);
  }
  if (pathname.startsWith('/api/notes/') && (req.method === 'PUT' || req.method === 'DELETE')) {
    const id = decodeURIComponent(pathname.slice('/api/notes/'.length));
    const data = loadData();
    const me = findUser(data, meId); const u = userData(data, meId); ensureMeta(u);
    const note = (u.notes || []).find((n) => n.id === id);
    if (!note) return send(404, { error: '找不到这条记事' });
    if (req.method === 'DELETE') {
      u.notes = u.notes.filter((n) => n.id !== id);
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
    const data = loadData();
    const me = findUser(data, meId);
    return send(200, { username: me.username, isAdmin: !!me.isAdmin });
  }
  if (pathname === '/api/logout' && req.method === 'POST') {
    delete auth.sessions[auth.token];
    saveSessions(auth.sessions);
    return send(200, { ok: true }, { 'Set-Cookie': 'session=; HttpOnly; Path=/; Max-Age=0' });
  }
  if (pathname === '/api/password' && req.method === 'POST') {
    const body = await jsonBody(req);
    const data = loadData();
    const me = findUser(data, meId); const u = userData(data, meId); ensureMeta(u);
    if (!verifyPassword(body.oldPassword, me.passwordHash)) return send(400, { error: '旧密码不对' });
    if (!body.newPassword || String(body.newPassword).length < 6) return send(400, { error: '新密码至少 6 位' });
    me.passwordHash = hashPassword(body.newPassword);
    me.passwordIsDefault = false;
    writeJSON(DATA_FILE, data);
    return send(200, { ok: true });
  }
  /* Telegram 通知设置：Token 永不返回给前端，留空表示不改；
     v62：Webhook 地址、Bark Key、Server酱 Key 也一样，只返回配没配，不返回原值 */
  if (pathname === '/api/notify' && req.method === 'GET') {
    const data = loadData();
    const u = userData(data, meId);
    const n = notifyCfg(u);
    return send(200, {
      configured: !!(n.token && n.chatId),
      chatId: n.chatId || '',
      expiring: n.expiring !== false,
      checkin: n.checkin !== false,
      pushHour: (n.pushHour === undefined ? 9 : n.pushHour),
      repeatHours: (n.repeatHours === undefined ? 0 : n.repeatHours),
      webhookConfigured: !!n.webhookUrl,
      barkConfigured: !!n.barkKey,
      serverChanConfigured: !!n.serverChanKey,
      lastExpiring: n.lastExpiring || '',
      lastCheckin: n.lastCheckin || ''
    });
  }
  if (pathname === '/api/notify' && req.method === 'POST') {
    const body = await jsonBody(req);
    const data = loadData();
    const me = findUser(data, meId); const u = userData(data, meId); ensureMeta(u);
    const n = notifyCfg(u);
    if (typeof body.token === 'string' && body.token.trim()) n.token = body.token.trim().slice(0, 200);
    if (typeof body.chatId === 'string' && body.chatId.trim()) n.chatId = body.chatId.trim().slice(0, 64);
    /* v62：三个新渠道——和 Token 同口径：填了就保存，留空表示不改 */
    if (typeof body.webhookUrl === 'string' && body.webhookUrl.trim()) {
      const u = body.webhookUrl.trim().slice(0, 500);
      if (!/^https?:\/\//i.test(u)) return send(400, { error: 'Webhook 地址要是 http(s) 开头' });
      n.webhookUrl = u;
    }
    if (typeof body.barkKey === 'string' && body.barkKey.trim()) n.barkKey = body.barkKey.trim().slice(0, 200);
    if (typeof body.serverChanKey === 'string' && body.serverChanKey.trim()) n.serverChanKey = body.serverChanKey.trim().slice(0, 200);
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
    const me = findUser(data, meId); const u = userData(data, meId); ensureMeta(u);
    const n = notifyCfg(u);
    const hasAny = (n.token && n.chatId) || n.webhookUrl || n.barkKey || n.serverChanKey;
    if (!hasAny) return send(400, { error: '还没设置任何通知渠道（Telegram / Webhook / Bark / Server酱）' });
    const t = todayStr();
    const cohort = checkinCohort(u, t);
    const done = cohort.filter((s) => (s.checkins || []).includes(t)).length;
    const items = expiringList(u);
    const todo = unsignedDaily(u, t);
    const expPreview = items.length
      ? `⏰ <b>临期预览</b>（${items.length} 个）：\n${expiringLines(items).join('\n')}`
      : '⏰ <b>临期预览</b>：30 天内暂无临期服务';
    const ckPreview = todo.length
      ? `⚡ <b>签到预览</b>（${todo.length} 个未签）：\n${checkinLines(todo).join('\n')}`
      : '⚡ <b>签到预览</b>：今日已全部签到';
    const html = `✅ <b>服务台通知测试成功</b> · ${t}\n今日签到 ${done}/${cohort.length} · 30 天内临期 ${items.length} 个\n\n${expPreview}\n\n${ckPreview}\n\n上面就是每天早上会收到的提醒版式。${todo.length ? '（Telegram 下面这个按钮是真的，点一下就签完了。）' : ''}`;
    const r = await sendMultiChannel(n, `服务台通知测试 · ${t}`, html, todo.length ? CHECKIN_KB : undefined);
    if (!r.ok) return send(400, { error: '全部渠道都发送失败', channels: r.results });
    return send(200, { ok: true, channels: r.results });
  }
  /* 手动触发链接检测（登录后可用） */
  if (pathname === '/api/linkcheck' && req.method === 'POST') {
    const r = await checkLinks();
    if (!r) return send(400, { error: '检测失败' });
    return send(200, r);
  }
  /* v60：自动签到——手动立即跑一轮（只跑今天到期且没签过的）；测试只发请求不记签到 */
  if (pathname === '/api/auto-signin/run' && req.method === 'POST') {
    const r = await runAutoSignins();
    if (!r) return send(400, { error: '自动签到失败' });
    return send(200, { ok: true, results: r });
  }
  if (pathname === '/api/auto-signin/test' && req.method === 'POST') {
    const body = await jsonBody(req);
    const cfg = sanitizeAutoSignin(body.autoSignin || body);
    if (!cfg) return send(400, { error: '自动签到没配好：网址要是 http(s) 开头' });
    const r = await tryAutoSignin(null, cfg);
    return send(200, { ok: r.ok, status: r.status, note: r.note || '' });
  }
  /* 分类管理：系统分类不能删，删自定义分类会把旗下服务移到中转站 */
  if (pathname === '/api/categories' && req.method === 'POST') {
    const body = await jsonBody(req);
    const data = loadData();
    const me = findUser(data, meId); const u = userData(data, meId); ensureMeta(u);
    const cats = ensureCategories(u);
    const label = String(body.label || '').trim().slice(0, 20);
    if (!label) return send(400, { error: '分类名不能为空' });
    /* v65：“已归档”是系统保留的归档分类名，不能自己新建 */
    if (label === '已归档') return send(400, { error: '“已归档”是系统保留的归档分类名' });
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
    const me = findUser(data, meId); const u = userData(data, meId); ensureMeta(u);
    const cats = ensureCategories(u);
    const cat = cats.find((c) => c.id === cm[1]);
    if (!cat) return send(404, { error: '找不到该分类' });
    const label = String(body.label || '').trim().slice(0, 20);
    if (!label) return send(400, { error: '分类名不能为空' });
    if (cats.some((c) => c.id !== cat.id && c.label.toLowerCase() === label.toLowerCase())) return send(400, { error: '已经有同名分类了' });
    /* v65：“已归档”是系统保留的归档分类名，别的分类不能改成这个名字 */
    if (label === '已归档' && cat.id !== ARCHIVED_CAT_ID) return send(400, { error: '“已归档”是系统保留的归档分类名' });
    cat.label = label;
    if (body.icon !== undefined) cat.icon = cleanIcon(body.icon);
    writeJSON(DATA_FILE, data);
    return send(200, { ok: true, category: cat });
  }
  if (cm && req.method === 'DELETE') {
    /* v65：归档分类也是系统分类，不能删（删了归档的服务就没地方去了） */
    if (BUILTIN_CATS.has(cm[1]) || cm[1] === ARCHIVED_CAT_ID) return send(400, { error: '系统分类不能删除' });
    const data = loadData();
    const me = findUser(data, meId); const u = userData(data, meId); ensureMeta(u);
    const cats = ensureCategories(u);
    const idx = cats.findIndex((c) => c.id === cm[1]);
    if (idx < 0) return send(404, { error: '找不到该分类' });
    /* 非空分类不让删：先把旗下服务编辑到其他分类，免得删完不知去向 */
    const used = u.services.filter((s) => s.category === cm[1]).length;
    if (used) return send(400, { error: `该分类下还有 ${used} 个服务，请先把它们编辑到其他分类后再删除` });
    cats.splice(idx, 1);
    writeJSON(DATA_FILE, data);
    return send(200, { ok: true });
  }
  /* 自动取 Chat ID：用户先给机器人发 /start，这里取最近一条消息的发送者 */
  if (pathname === '/api/notify/resolve' && req.method === 'POST') {
    const data = loadData();
    const me = findUser(data, meId); const u = userData(data, meId); ensureMeta(u);
    const n = notifyCfg(u);
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
    const data = loadData();
    fs.writeFileSync(LEDGER_FILE, ledgerMarkdown(userData(data, meId)), 'utf8');
    return send(200, { ok: true, file: '服务台账.md' });
  }
  /* 一键备份：下载完整数据，但密码哈希和机器人 Token 绝不外带；
     恢复时这两项永远沿用当前值，旧版原始备份也能照常恢复；
     v67：管理员下整盘（所有用户），普通用户只下自己的数据 */
  if (pathname === '/api/backup' && req.method === 'GET') {
    const data = loadData();
    const me = findUser(data, meId); const u = userData(data, meId); ensureMeta(u);
    let out;
    if (me.isAdmin) {
      out = strippedBackupData(data);
    } else {
      out = {
        users: [{ id: me.id, username: me.username, isAdmin: false, banned: !!me.banned, createdAt: me.createdAt || '' }],
        userData: { [me.id]: strippedUserData(u) }
      };
    }
    const fname = `service-hub-backup-${todayStr()}.json`;
    res.writeHead(200, Object.assign({
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${fname}"`,
      'Cache-Control': 'no-store'
    }, SEC_HEADERS));
    return res.end(JSON.stringify(out, null, 2));
  }
  /* 恢复备份：先把当前数据自动存一份，再整体替换（账号密码和机器人 Token 永远不动）；
     v67：按用户归属恢复——管理员恢复整盘时各用户的数据各回各家（只恢复已存在的用户，
     删掉的用户不复活）；普通用户只恢复自己的那份；旧格式备份（顶层就是服务列表）
     当成当前用户的数据恢复 */
  if (pathname === '/api/backup' && req.method === 'POST') {
    const body = await jsonBody(req);
    const imp = body && body.data ? body.data : body;
    const data = loadData();
    const me = findUser(data, meId); const u = userData(data, meId); ensureMeta(u);
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      fs.writeFileSync(path.join(DATA_DIR, `backup-before-import-${stamp}.json`), JSON.stringify(data, null, 2));
      const olds = fs.readdirSync(DATA_DIR).filter((f) => f.startsWith('backup-before-import-')).sort();
      while (olds.length > 5) fs.unlinkSync(path.join(DATA_DIR, olds.shift()));
    } catch {}
    const validServices = (arr) => Array.isArray(arr) && arr.every((s) => s && typeof s.id === 'string' && typeof s.name === 'string' && s.name.trim());
    if (imp && imp.userData && typeof imp.userData === 'object') {
      /* 新格式：按用户归属恢复 */
      const targets = [];
      if (me.isAdmin) {
        for (const [uid, ud] of Object.entries(imp.userData)) {
          if (findUser(data, uid) && validServices(ud && ud.services)) targets.push([uid, ud]);
        }
      } else if (imp.userData[me.id] && validServices(imp.userData[me.id].services)) {
        targets.push([me.id, imp.userData[me.id]]);
      } else {
        /* 跨服务器恢复：文件里只有一个人时，就当是当前用户自己的备份 */
        const entries = Object.entries(imp.userData);
        if (entries.length === 1 && validServices(entries[0][1] && entries[0][1].services)) targets.push([me.id, entries[0][1]]);
      }
      if (!targets.length) return send(400, { error: '备份文件不对：里面没有你的数据' });
      for (const [uid, ud] of targets) restoreUserData(data, uid, ud);
      writeJSON(DATA_FILE, data);
      return send(200, { ok: true, services: userData(data, meId).services.length, restoredUsers: targets.length });
    }
    if (!imp || !Array.isArray(imp.services)) return send(400, { error: '备份文件不对：里面没有服务列表' });
    if (!validServices(imp.services)) return send(400, { error: '备份文件不对：有服务缺名字或编号' });
    restoreUserData(data, me.id, imp);
    writeJSON(DATA_FILE, data);
    return send(200, { ok: true, services: userData(data, meId).services.length });
  }
  if (pathname === '/api/meta' && req.method === 'GET') {
    const data = loadData();
    const me = findUser(data, meId); const u = userData(data, meId); ensureMeta(u);
    const unlocked = syncAchievements(u);
    if (unlocked.length) writeJSON(DATA_FILE, data);
    return send(200, metaPayload(me, u));
  }

  if (pathname === '/api/services' && req.method === 'GET') {
    const data = loadData();
    return send(200, userData(data, meId).services);
  }
  if (pathname === '/api/services' && req.method === 'POST') {
    const data = loadData();
    const me = findUser(data, meId); const u = userData(data, meId); ensureMeta(u);
    const f = pickFields(await jsonBody(req), null, categoriesOf(u).map((c) => c.id), vaultOf(u));
    if (!f.name) return send(400, { error: '名称必填' });
    const svc = Object.assign({
      id: crypto.randomBytes(12).toString('hex'),
      category: 'relay',
      url: '', account: '', secret: '', price: '', notes: '',
      registeredAt: todayStr(), expiresAt: '',
      /* v65：建站日期（月度报告里“新增服务数”按它算；续期改 registeredAt 时它不动） */
      createdAt: todayStr(),
      checkinFrequency: 'none', checkinEveryDays: 1, renewDays: 365, checkins: [],
      visits: 0,
      sortOrder: Math.min(0, ...u.services.map((s) => s.sortOrder ?? 0)) - 1 // 新服务排最前
    }, f);
    u.services.push(svc);
    u.xp += 10; // 记录新服务 +10 热情值
    const unlocked = syncAchievements(u);
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
    const me = findUser(data, meId); const u = userData(data, meId); ensureMeta(u);
    const catIds = categoriesOf(u).map((c) => c.id);
    let maxOrder = u.services.reduce((m, s) => Math.max(m, s.sortOrder ?? 0), 0);
    let imported = 0;
    for (const r of rows) {
      const f = pickFields(r || {}, null, catIds, vaultOf(u));
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
      u.services.push(svc);
      imported++;
    }
    if (imported) {
      syncAchievements(u);
      writeJSON(DATA_FILE, data);
    }
    return send(200, { ok: true, imported, skipped: rows.length - imported });
  }

  /* v62：书签导入——和 CSV 导入同一套新增逻辑，但同 URL 已存在就跳过（不重复建） */
  if (pathname === '/api/services/import-bookmarks' && req.method === 'POST') {
    const body = await jsonBody(req);
    const rows = Array.isArray(body.services) ? body.services : [];
    if (!rows.length) return send(400, { error: '没有可导入的书签' });
    if (rows.length > 500) return send(400, { error: '一次最多导入 500 个' });
    const normUrl = (u) => String(u || '').trim().toLowerCase().replace(/\/+$/, '');
    const data = loadData();
    const me = findUser(data, meId); const u = userData(data, meId); ensureMeta(u);
    const catIds = categoriesOf(u).map((c) => c.id);
    const seenUrls = new Set(u.services.map((s) => normUrl(s.url)).filter(Boolean));
    let maxOrder = u.services.reduce((m, s) => Math.max(m, s.sortOrder ?? 0), 0);
    let imported = 0, dupes = 0;
    for (const r of rows) {
      const f = pickFields(r || {}, null, catIds, vaultOf(u));
      if (!f.name) continue;
      const nu = normUrl(f.url);
      if (nu && seenUrls.has(nu)) { dupes++; continue; }
      const svc = Object.assign({
        id: crypto.randomBytes(12).toString('hex'),
        category: 'relay',
        url: '', account: '', secret: '', price: '', notes: '',
        registeredAt: todayStr(), expiresAt: '',
        checkinFrequency: 'none', checkinEveryDays: 1, renewDays: 365, checkins: [],
        visits: 0,
        sortOrder: ++maxOrder
      }, f);
      u.services.push(svc);
      if (nu) seenUrls.add(nu);
      imported++;
    }
    if (imported) {
      syncAchievements(u);
      writeJSON(DATA_FILE, data);
    }
    return send(200, { ok: true, imported, skipped: rows.length - imported - dupes, dupes });
  }

  /* v62：账号 CSV 导入——按服务名匹配已有服务（找不到的跳过并上报），同服务同账号已存在就跳过；
     只追加账号，不改服务其他字段；新账号默认不是默认账号，除非该服务原来一个账号都没有 */
  if (pathname === '/api/services/import-accounts' && req.method === 'POST') {
    const body = await jsonBody(req);
    const rows = Array.isArray(body.accounts) ? body.accounts : [];
    if (!rows.length) return send(400, { error: '没有可导入的账号' });
    if (rows.length > 500) return send(400, { error: '一次最多导入 500 个' });
    const data = loadData();
    const me = findUser(data, meId); const u = userData(data, meId); ensureMeta(u);
    const byName = new Map();
    for (const s of u.services) {
      const key = String(s.name || '').trim().toLowerCase();
      if (key && !byName.has(key)) byName.set(key, s);
    }
    let imported = 0, dupes = 0, missingRows = 0;
    const missing = [];
    const missingSeen = new Set();
    for (const r of rows) {
      if (!r || typeof r !== 'object') continue;
      const svcName = String(r.service || '').trim();
      const svc = svcName ? byName.get(svcName.toLowerCase()) : null;
      if (!svc) {
        missingRows++;
        if (svcName && !missingSeen.has(svcName)) { missingSeen.add(svcName); missing.push(svcName); }
        continue;
      }
      const acc = sanitizeAccount({
        label: r.label, username: r.username, password: r.password, notes: r.notes
      });
      if (!acc || !acc.username) continue;
      /* v65：新导入的账号，改密日记今天（密码是新录入的） */
      if (acc.password) acc.passwordChangedAt = todayStr();
      normalizeAccounts(svc, vaultOf(u));
      if (svc.accounts.some((a) => String(a.username || '').trim().toLowerCase() === acc.username.toLowerCase())) { dupes++; continue; }
      acc.isDefault = svc.accounts.length === 0;
      svc.accounts.push(acc);
      normalizeAccounts(svc, vaultOf(u));
      imported++;
    }
    if (imported) writeJSON(DATA_FILE, data);
    return send(200, { ok: true, imported, skipped: rows.length - imported - dupes - missingRows, dupes, missing });
  }
  if (pathname === '/api/reorder' && req.method === 'POST') {
    const body = await jsonBody(req);
    if (!Array.isArray(body.ids)) return send(400, { error: '参数错误' });
    const data = loadData();
    const me = findUser(data, meId); const u = userData(data, meId); ensureMeta(u);
    const pos = new Map(body.ids.map((x, i) => [String(x), i]));
    u.services.forEach((s) => { if (pos.has(s.id)) s.sortOrder = pos.get(s.id); });
    writeJSON(DATA_FILE, data);
    return send(200, { ok: true });
  }
  /* 一键全签：一次请求签完当天所有未签（原来前端逐个调，容易签一半断网） */
  if (pathname === '/api/checkins/all' && req.method === 'POST') {
    return send(200, checkinAllToday(loadData(), meId));
  }
  /* 批量操作：一次改多个服务的分类，或一次删多个 */
  if (pathname === '/api/services/bulk' && req.method === 'POST') {
    const body = await jsonBody(req);
    const data = loadData();
    const me = findUser(data, meId); const u = userData(data, meId); ensureMeta(u);
    const ids = new Set((Array.isArray(body.ids) ? body.ids : []).map(String));
    if (!ids.size) return send(400, { error: '没有选中服务' });
    if (body.action === 'delete') {
      const before = u.services.length;
      u.services = u.services.filter((s) => !ids.has(s.id));
      writeJSON(DATA_FILE, data);
      return send(200, { ok: true, deleted: before - u.services.length });
    }
    if (body.action === 'category') {
      const catIds = categoriesOf(u).map((c) => c.id);
      const cat = catIds.includes(body.category) ? body.category : 'relay';
      let moved = 0;
      for (const s of u.services) {
        if (!ids.has(s.id)) continue;
        /* 和单个编辑同一条规则：新选进收藏分类的顺带点星 */
        if (cat === 'fav' && s.category !== 'fav') s.favorite = true;
        s.category = cat;
        moved++;
      }
      writeJSON(DATA_FILE, data);
      return send(200, { ok: true, moved });
    }
    if (body.action === 'edit') {
      /* v59：批量编辑——只改传了的字段（空着不动），签到间隔 1–365 天，续期周期 1–3650 天 */
      const every = (body.checkinEveryDays === '' || body.checkinEveryDays == null) ? null : clampInt(body.checkinEveryDays, 1, 365, null);
      const renew = (body.renewDays === '' || body.renewDays == null) ? null : clampInt(body.renewDays, 1, 3650, null);
      if (every === null && renew === null) return send(400, { error: '没填要改的内容' });
      let updated = 0;
      for (const s of u.services) {
        if (!ids.has(s.id)) continue;
        if (every !== null) s.checkinEveryDays = every;
        if (renew !== null) s.renewDays = renew;
        updated++;
      }
      writeJSON(DATA_FILE, data);
      return send(200, { ok: true, updated });
    }
    return send(400, { error: '未知操作' });
  }

  const m = pathname.match(/^\/api\/services\/([0-9a-f]+)(\/checkin|\/uncheckin|\/checkin-account|\/uncheckin-account|\/visit|\/undo-renew|\/renew|\/move|\/duplicate)?$/);
  if (m) {
    const data = loadData();
    const me = findUser(data, meId); const u = userData(data, meId); ensureMeta(u);
    const idx = u.services.findIndex((s) => s.id === m[1]);
    if (idx < 0) return send(404, { error: '找不到该服务' });
    const svc = u.services[idx];
    const t = todayStr();
    /* 访问计数：点「前往」/标题链接时打点 */
    if (req.method === 'POST' && m[2] === '/visit') {
      svc.visits = (svc.visits || 0) + 1;
      writeJSON(DATA_FILE, data);
      return send(200, { ok: true, visits: svc.visits });
    }
    if (req.method === 'POST' && m[2] === '/checkin') {
      /* v57：有账号的服务，一次把还没签的账号全签了；没账号的走服务级签到（和原来一样） */
      let xpGained = 0;
      const accs = serviceAccounts(svc);
      if (accs.length) {
        for (const a of accs) xpGained += doCheckinAccount(u, svc, a, t);
      } else {
        xpGained = doCheckin(u, svc, t);
      }
      const { allDone, bonus } = allDoneBonus(u, t);
      xpGained += bonus;
      u.xp += xpGained;
      const unlocked = syncAchievements(u);
      writeJSON(DATA_FILE, data);
      return send(200, {
        ok: true, checkins: svc.checkins, accounts: svc.accounts, xpGained, allDone,
        unlocked, xp: u.xp, level: levelOf(u.xp)
      });
    }
    if (req.method === 'POST' && m[2] === '/checkin-account') {
      /* v57：只签一个账号；签完这个账号后如果全部账号都签了，服务才算签完（给分） */
      const body = await jsonBody(req);
      const acc = serviceAccounts(svc).find((a) => a.id === String(body.accountId || ''));
      if (!acc) return send(404, { error: '找不到该账号' });
      let xpGained = doCheckinAccount(u, svc, acc, t);
      const { allDone, bonus } = allDoneBonus(u, t);
      xpGained += bonus;
      u.xp += xpGained;
      const unlocked = syncAchievements(u);
      writeJSON(DATA_FILE, data);
      return send(200, {
        ok: true, checkins: svc.checkins, accounts: svc.accounts, xpGained, allDone,
        unlocked, xp: u.xp, level: levelOf(u.xp)
      });
    }
    if (req.method === 'POST' && m[2] === '/uncheckin-account') {
      /* v57：只撤一个账号；服务原来是签完的，这下就不算签完了 */
      const body = await jsonBody(req);
      const acc = serviceAccounts(svc).find((a) => a.id === String(body.accountId || ''));
      if (!acc) return send(404, { error: '找不到该账号' });
      doUncheckinAccount(u, svc, acc, t);
      writeJSON(DATA_FILE, data);
      return send(200, { ok: true, checkins: svc.checkins, accounts: svc.accounts });
    }
    if (req.method === 'POST' && m[2] === '/renew') {
      /* v66：续期一律从今天起算——新到期日 = 今天 + 续期周期，提前续期不保留剩余天数
         （原来是未过期的从原到期日起续，提前 15 天续 20 天周期会变成 35 天后到期，不对）；
         365 天沿用加一年（2 月 29 日 → 2 月 28 日），其他天数直接加天数 */
      const base = t;
      const days = renewEvery(svc);
      /* v51：续期前先快照旧的两个日期，撤回续期时一起恢复；续期把开始时间（注册/购买日期）
         也推到今天（新周期从今天开始），开始时间 + 续期周期 = 到期日，循环不断 */
      svc.prevRenew = { expiresAt: svc.expiresAt || '', registeredAt: svc.registeredAt || '' };
      delete svc.prevExpiresAt;
      /* v59：续期记录——每次续期记一笔（哪天续的、从哪天续到哪天），只留最近 20 条；
         撤回续期时把对应的那条也拿掉（那次续期等于没发生） */
      svc.renewHistory = (Array.isArray(svc.renewHistory) ? svc.renewHistory : []).filter((h) => h && /^\d{4}-\d{2}-\d{2}$/.test(h.at || ''));
      const newExpires = days === 365 ? addYear(base) : addDays(base, days);
      svc.renewHistory.push({ at: t, from: svc.expiresAt || '', to: newExpires });
      if (svc.renewHistory.length > 20) svc.renewHistory = svc.renewHistory.slice(-20);
      svc.registeredAt = base;
      svc.expiresAt = newExpires;
      writeJSON(DATA_FILE, data);
      return send(200, { ok: true, expiresAt: svc.expiresAt });
    }
    if (req.method === 'POST' && m[2] === '/undo-renew') {
      const snap = svc.prevRenew || (svc.prevExpiresAt ? { expiresAt: svc.prevExpiresAt, registeredAt: svc.registeredAt } : null);
      if (!snap) return send(400, { error: '没有可撤回的续期' });
      /* v59：撤回续期时，把记录里对应那次续期（to 等于当前到期日的那条）拿掉 */
      if (Array.isArray(svc.renewHistory) && svc.renewHistory.length) {
        const last = svc.renewHistory[svc.renewHistory.length - 1];
        if (last && last.to === svc.expiresAt) svc.renewHistory.pop();
      }
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
      const group = u.services.filter((s) => s.category === svc.category).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
      const i = group.findIndex((s) => s.id === svc.id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= group.length) return send(200, { ok: true, moved: false });
      const tmp = group[i].sortOrder; group[i].sortOrder = group[j].sortOrder; group[j].sortOrder = tmp;
      writeJSON(DATA_FILE, data);
      return send(200, { ok: true, moved: true });
    }
    if (req.method === 'POST' && m[2] === '/duplicate') {
      /* v59：复制服务——新编号、名字后加“副本”、排在同分类最后；签到记录/访问/续期历史
         不带过去（新服务从零开始），账号带过去（新编号，签到记录清掉），改完再调 */
      const maxOrder = u.services.filter((s) => s.category === svc.category).reduce((n, s) => Math.max(n, s.sortOrder ?? 0), 0);
      const copy = {
        ...svc,
        id: crypto.randomBytes(6).toString('hex'),
        name: (svc.name || '服务').slice(0, 96) + ' 副本',
        checkins: [],
        visits: 0,
        sortOrder: maxOrder + 1,
        linkStatus: undefined,
        linkCheckedAt: undefined,
        /* v65：副本是新服务——建站日期记今天，探测历史不清零会把原服务的在线率带过来 */
        createdAt: todayStr(),
        linkHistory: [],
        renewHistory: [],
        prevRenew: undefined,
        prevExpiresAt: undefined,
        accounts: (Array.isArray(svc.accounts) ? svc.accounts : []).map((a) => ({ ...sanitizeAccount(a), id: crypto.randomBytes(6).toString('hex'), checkins: [] }))
      };
      copy.account = copy.accounts.find((a) => a.isDefault)?.username || '';
      copy.secret = copy.accounts.find((a) => a.isDefault)?.password || '';
      u.services.push(copy);
      writeJSON(DATA_FILE, data);
      return send(200, copy);
    }
    if (req.method === 'POST' && m[2] === '/uncheckin') {
      /* v57：多账号的服务，撤回就是把今天从所有账号和服务级记录里都拿掉；没账号的和原来一样 */
      const accs = serviceAccounts(svc);
      if (accs.length) {
        for (const a of accs) a.checkins = accountCheckins(a).filter((d) => d !== t);
      }
      svc.checkins = svc.checkins.filter((d) => d !== t);
      if (u.history[t]) u.history[t].c = Math.max(0, (u.history[t].c || 1) - 1);
      writeJSON(DATA_FILE, data);
      return send(200, { ok: true, checkins: svc.checkins, accounts: svc.accounts });
    }
    if (req.method === 'PUT' && !m[2]) {
      const body = await jsonBody(req);
      Object.assign(svc, pickFields(body, svc, categoriesOf(u).map((c) => c.id), vaultOf(u)));
      /* 手动改了到期日或开始时间，之前的续期快照就作废，免得撤回续期把手改的日期盖回去 */
      if (typeof body.expiresAt === 'string' || typeof body.registeredAt === 'string') { delete svc.prevRenew; delete svc.prevExpiresAt; }
      writeJSON(DATA_FILE, data);
      return send(200, svc);
    }
    if (req.method === 'DELETE' && !m[2]) {
      u.services.splice(idx, 1);
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
