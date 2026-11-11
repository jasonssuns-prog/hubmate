/* HubMate —— Workers 原生版（dev 分支）
   入口：src/worker.js（fetch + scheduled），配 wrangler.toml + D1 使用。
   由 Node 版 server.js 移植：业务逻辑（签到/XP/到期/记事本/Telegram/自动签到/
   GitHub 备份/TOTP/多账号）原样保留，只换掉三样东西：
   1) 数据层：data.json → D1（meta 键值表 + services 每服务一行 JSON + notes /
      sessions / captchas / login_throttle / backups 表，见 migrations/0001_init.sql）
   2) 定时任务：setInterval → Cron Triggers（scheduled handler 按 cron 分发）
   3) 密码：Node scrypt → Web Crypto PBKDF2-SHA256（见 hashPassword 的注释）。
      免费套餐每请求只有 10ms CPU，同步 scrypt（约 50–100ms）会直接报 Error 1102，
      所以密码必须走异步 Web Crypto；旧版 scrypt 密码哈希无法在 Workers 里验，
      迁移后登录密码会重置为默认 jason123，首次登录后请立即改密码。
   4) v61 多服务器同步：Workers 是全球一份部署，不需要，整段去掉。
   其余：静态资源走 Workers Static Assets（public/），?v= 版本号机制保留；
   登录验证码仍是服务端 SVG（纯字符串拼接）；TOTP 用 Web Crypto HMAC-SHA1。
   零运行时依赖（wrangler 只是本地开发工具）。 */
import { randomBytes, createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';

const SESSION_MS = 30 * 86400 * 1000;

/* DDL：和 migrations/0001_init.sql、0002_multiuser.sql 同一份，Worker 首次收到请求时
   自动执行（CREATE TABLE IF NOT EXISTS，幂等），一键部署后不用手动建表也能用。
   改表结构时三边一起改。v67 多用户：users / invite_codes 两张新表，
   services / notes / sessions 各加 userId 列（ensureSchema 里按 PRAGMA 幂等补列）。 */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS services (id TEXT PRIMARY KEY, data TEXT NOT NULL, userId TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', content TEXT NOT NULL DEFAULT '', createdAt TEXT NOT NULL DEFAULT '', updatedAt TEXT NOT NULL DEFAULT '', userId TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, created INTEGER NOT NULL, userId TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS captchas (id TEXT PRIMARY KEY, code TEXT NOT NULL, expiresAt INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS login_throttle (ip TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0, resetAt INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS backups (id INTEGER PRIMARY KEY AUTOINCREMENT, createdAt TEXT NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, passwordHash TEXT NOT NULL, passwordIsDefault INTEGER NOT NULL DEFAULT 1, isAdmin INTEGER NOT NULL DEFAULT 0, banned INTEGER NOT NULL DEFAULT 0, createdAt TEXT NOT NULL DEFAULT '', lastLoginAt TEXT NOT NULL DEFAULT '', totpSecret TEXT NOT NULL DEFAULT '', totpEnabled INTEGER NOT NULL DEFAULT 0, apiToken TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS invite_codes (code TEXT PRIMARY KEY, createdAt TEXT NOT NULL DEFAULT '', usedBy TEXT NOT NULL DEFAULT '', usedAt TEXT NOT NULL DEFAULT '');
`;
let schemaPromise = null;
function ensureSchema(db) {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await db.exec(SCHEMA_SQL);
      /* v67：给旧库补 userId 列。新库建表时已带 userId，旧库走 ALTER。
         不用 PRAGMA table_info 查列是否存在：线上 D1 对 PRAGMA 内省有限制，
         查列失败会让整个 ensureSchema 抛错，进而 /api/captcha 等全部 500，
         而前端原来还把这个失败静默吞掉，登录框就只剩一个空白验证码框。
         改成直接 ALTER、只忽略“列已存在”的报错，其它错误继续往上抛。 */
      for (const table of ['services', 'notes', 'sessions']) {
        try {
          await db.exec(`ALTER TABLE ${table} ADD COLUMN userId TEXT NOT NULL DEFAULT ''`);
        } catch (e) {
          if (!/duplicate column/i.test(e && e.message ? e.message : '')) throw e;
        }
      }
    })().catch((e) => { schemaPromise = null; throw e; });
  }
  return schemaPromise;
}

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
/* v65：已归档分类（自动归档时按需新建，图标 🗄️） */
const ARCHIVED_CAT = { id: 'archived', label: '已归档', icon: '🗄️', cls: 't-custom' };
function isArchived(s) { return s && s.category === ARCHIVED_CAT.id; }
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
function safeJSON(s, fallback) {
  try { const v = JSON.parse(s); return v === undefined ? fallback : v; } catch { return fallback; }
}
function hex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function unhex(s) {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function jsonResponse(status, obj, extraHeaders) {
  const h = Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  }, SEC_HEADERS, extraHeaders || {});
  return new Response(JSON.stringify(obj), { status, headers: h });
}
function clientIp(request) {
  return request.headers.get('cf-connecting-ip') || '?';
}

/* ---------- 密码：Web Crypto PBKDF2-SHA256（10 万次迭代，异步，不占 CPU 预算） ----------
   格式 pbkdf2:<salt hex>:<hash hex>。Node 版的 scrypt 格式（salt:hash）在这里
   故意不验：scryptSync 是同步 CPU 运算，免费套餐 10ms 上限装不下，验了会报 Error 1102。
   所以从 Node 版迁移过来时密码会重置为默认 jason123，首次登录后立即改密码。 */
const PBKDF2_ITER = 100000;
async function hashPassword(pw) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(pw)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: PBKDF2_ITER, hash: 'SHA-256' }, key, 256);
  return `pbkdf2:${hex(salt)}:${hex(bits)}`;
}
async function verifyPassword(pw, stored) {
  try {
    const parts = String(stored).split(':');
    if (parts.length !== 3 || parts[0] !== 'pbkdf2') return false;
    const salt = unhex(parts[1]);
    const want = unhex(parts[2]);
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(pw)), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: PBKDF2_ITER, hash: 'SHA-256' }, key, 256);
    const got = new Uint8Array(bits);
    if (got.length !== want.length) return false;
    let diff = 0;
    for (let i = 0; i < got.length; i++) diff |= got[i] ^ want[i];
    return diff === 0;
  } catch { return false; }
}

/* ---------- TOTP 二次验证（RFC 6238，Web Crypto HMAC-SHA1，异步） ---------- */
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
  return new Uint8Array(bytes);
}
async function totpCode(secret, step) {
  const key = await crypto.subtle.importKey('raw', base32Decode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const msg = new Uint8Array(8);
  new DataView(msg.buffer).setBigUint64(0, BigInt(step));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  const off = sig[sig.length - 1] & 0x0f;
  const code = ((sig[off] & 0x7f) << 24) | ((sig[off + 1] & 0xff) << 16) | ((sig[off + 2] & 0xff) << 8) | (sig[off + 3] & 0xff);
  return String(code % 1e6).padStart(6, '0');
}
async function verifyTotp(secret, code) {
  if (!secret || !/^\d{6}$/.test(String(code || ''))) return false;
  const step = Math.floor(Date.now() / 30000);
  for (const s of [step - 1, step, step + 1]) {
    if ((await totpCode(secret, s)) === String(code)) return true;
  }
  return false;
}

/* ---------- 登录图形验证码（D1 存答案，一次性，5 分钟过期） ---------- */
async function makeCaptcha(db) {
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
  const id = randomBytes(12).toString('hex');
  await db.prepare('INSERT INTO captchas (id, code, expiresAt) VALUES (?, ?, ?)')
    .bind(id, code, Date.now() + 5 * 60e3).run();
  await db.prepare('DELETE FROM captchas WHERE expiresAt < ?').bind(Date.now()).run();
  return { id, svg };
}
async function verifyCaptcha(db, id, answer) {
  if (!id || !answer) return false;
  const row = await db.prepare('SELECT code, expiresAt FROM captchas WHERE id = ?').bind(id).first();
  await db.prepare('DELETE FROM captchas WHERE id = ?').bind(id).run();
  if (!row || Date.now() > row.expiresAt) return false;
  return String(answer).trim().toUpperCase() === row.code;
}

/* ---------- 登录防爆破：每 IP 10 分钟最多 10 次（D1 存计数） ---------- */
async function loginThrottled(db, ip) {
  const now = Date.now();
  const row = await db.prepare('SELECT count, resetAt FROM login_throttle WHERE ip = ?').bind(ip).first();
  let count = 1, resetAt = now + 10 * 60e3;
  if (row && now <= row.resetAt) { count = row.count + 1; resetAt = row.resetAt; }
  await db.prepare('INSERT OR REPLACE INTO login_throttle (ip, count, resetAt) VALUES (?, ?, ?)')
    .bind(ip, count, resetAt).run();
  return count > 10;
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
  /* v65：已归档的服务不计入签到队列（和 idle 一样排除） */
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
function metaPayload(data) {
  const t = todayStr();
  const daily = dailyServices(data);
  const best = Math.max(0, ...data.services.map((s) => maxRun(s.checkins || [])));
  return {
    username: data.username,
    /* v67：多用户——前端靠 isAdmin 决定显不显“用户管理”和“邀请码”面板 */
    isAdmin: !!data.isAdmin,
    xp: data.xp,
    level: levelOf(data.xp),
    passwordIsDefault: data.passwordIsDefault !== false,
    totpEnabled: !!data.totpEnabled,
    categories: categoriesOf(data).map(normCat),
    stats: {
      services: data.services.length,
      totalCheckins: data.services.reduce((n, s) => n + (s.checkins || []).length, 0),
      bestStreak: best,
      dailyTotal: daily.length,
      doneToday: daily.filter((s) => (s.checkins || []).includes(t)).length
    },
    achievements: ACH_DEFS.map((a) => ({ ...a, unlockedAt: data.achievements[a.id] || null })),
    history: data.history,
    /* v65：月度报告（最近 6 个月，给数据中心面板用） */
    monthlyReports: (Array.isArray(data.monthlyReports) ? data.monthlyReports : []).slice(-6)
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

/* ---------- 数据层：D1（v67 多用户） ---------- */
/* per-user 配置存在 meta 表里，键名前缀 u:<userId>:（xp / achievements / flags /
   history / categories / notify / sharedAccounts / monthlyReports /
   archivedLog / loginHistory）。账号字段（用户名/密码哈希/TOTP/API 令牌）存在
   users 表里。GitHub 备份配置是全局的（只有管理员配），仍用不带前缀的
   githubBackup 键。业务表 services / notes / sessions 各有一列 userId 隔离。 */
const USER_META_KEYS = ['xp', 'achievements', 'flags', 'history', 'categories', 'notify', 'sharedAccounts', 'monthlyReports', 'archivedLog', 'loginHistory'];
function userMetaKey(uid, key) { return `u:${uid}:${key}`; }

/* ---------- 用户 ---------- */
/* 对外只返回账号信息（用户名/是否管理员/是否封禁/注册时间/最后登录），绝不返回
   密码哈希、TOTP 密钥、API 令牌和任何业务数据 */
function publicUser(u) {
  if (!u) return null;
  return { id: u.id, username: u.username, passwordIsDefault: !!u.passwordIsDefault, isAdmin: !!u.isAdmin, banned: !!u.banned, createdAt: u.createdAt || '', lastLoginAt: u.lastLoginAt || '' };
}
async function getUserById(db, id) {
  if (!id) return null;
  return await db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
}
async function getUserByUsername(db, username) {
  if (!username) return null;
  return await db.prepare('SELECT * FROM users WHERE username = ?').bind(username).first();
}
async function listUsers(db) {
  const r = await db.prepare('SELECT * FROM users ORDER BY createdAt ASC, id ASC').all();
  return r.results || [];
}
/* 第一个管理员（注册时间最早的 isAdmin 用户）：公开落地页和日历订阅用他的数据 */
async function getAdminUser(db) {
  return await db.prepare('SELECT * FROM users WHERE isAdmin = 1 ORDER BY createdAt ASC, id ASC LIMIT 1').first();
}
/* 用户名规则：2–32 位，字母/数字/中文/下划线，中间可带空格、点、连字符，
   首尾必须是字母/数字/中文/下划线 */
function validUsername(name) {
  const s = String(name || '').trim();
  if (s.length < 2 || s.length > 32) return false;
  if (!/^[A-Za-z0-9_\u4e00-\u9fa5]/.test(s)) return false;
  if (!/[A-Za-z0-9_\u4e00-\u9fa5]$/.test(s)) return false;
  return /^[A-Za-z0-9_\u4e00-\u9fa5 .-]+$/.test(s);
}
/* 邀请码：HUB-XXXX-XXXX-XXXX，12 位无歧义字符（去掉 I/O/0/1），随机生成 */
function genInviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 12; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return `HUB-${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}
/* 删一个用户及其全部数据（服务、记事、会话、per-user 配置）。调用前先确认
   不是删自己；invite_codes 里被他用过的码留着当历史（usedBy 只剩 id）。 */
async function deleteUserData(db, userId) {
  const uid = String(userId);
  await db.prepare('DELETE FROM sessions WHERE userId = ?').bind(uid).run();
  await db.prepare('DELETE FROM services WHERE userId = ?').bind(uid).run();
  await db.prepare('DELETE FROM notes WHERE userId = ?').bind(uid).run();
  await db.prepare('DELETE FROM meta WHERE key LIKE ?').bind(`u:${uid}:%`).run();
  await db.prepare('DELETE FROM users WHERE id = ?').bind(uid).run();
}

/* ---------- 旧库迁移（只跑一次） ---------- */
/* users 表还是空的，说明是 v67 之前的库：有两种情况——
   (1) 旧版单用户库（meta 里有 username）：把唯一的那个用户升成管理员，
       全部业务数据归他，per-user 配置键改名 u:<id>:<key>，旧的账号键删掉；
   (2) 全新安装（meta 里也没有 username）：建默认管理员 jason/jason123 +
       两条示例数据（和 Node 版首次启动一模一样）。
   旧库迁移用 db.batch 一次提交（原子操作，失败整体回滚，不留半截状态）。 */
let usersPromise = null;
function ensureUsers(db) {
  if (!usersPromise) {
    usersPromise = migrateUsersIfNeeded(db).catch((e) => { usersPromise = null; throw e; });
  }
  return usersPromise;
}
async function migrateUsersIfNeeded(db) {
  await ensureSchema(db);
  const row = await db.prepare('SELECT COUNT(*) AS n FROM users').first();
  if (row && row.n > 0) return;
  const metaRows = await db.prepare('SELECT key, value FROM meta').all();
  const meta = {};
  for (const r of (metaRows.results || [])) meta[r.key] = r.value;
  if (meta.username) {
    const adminId = randomBytes(6).toString('hex');
    const stmts = [
      db.prepare('INSERT INTO users (id, username, passwordHash, passwordIsDefault, isAdmin, banned, createdAt, lastLoginAt, totpSecret, totpEnabled, apiToken) VALUES (?, ?, ?, ?, 1, 0, ?, ?, ?, ?, ?)')
        .bind(adminId, String(meta.username), String(meta.passwordHash || ''), meta.passwordIsDefault ? (JSON.parse(meta.passwordIsDefault) ? 1 : 0) : 1, cstDateTime(), '', String(meta.totpSecret || ''), meta.totpEnabled ? (JSON.parse(meta.totpEnabled) ? 1 : 0) : 0, String(meta.apiToken || '')),
      db.prepare('UPDATE services SET userId = ?').bind(adminId),
      db.prepare('UPDATE notes SET userId = ?').bind(adminId)
    ];
    for (const k of USER_META_KEYS) {
      if (meta[k] !== undefined) {
        stmts.push(db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').bind(userMetaKey(adminId, k), meta[k]));
        stmts.push(db.prepare('DELETE FROM meta WHERE key = ?').bind(k));
      }
    }
    for (const k of ['username', 'passwordHash', 'passwordIsDefault', 'totpSecret', 'totpEnabled', 'apiToken']) {
      stmts.push(db.prepare('DELETE FROM meta WHERE key = ?').bind(k));
    }
    await db.batch(stmts);
    console.log(`[multiuser] 旧版单用户数据已迁移：${meta.username} 升为管理员`);
    return;
  }
  /* 全新安装 */
  const adminId = randomBytes(6).toString('hex');
  await db.prepare('INSERT INTO users (id, username, passwordHash, passwordIsDefault, isAdmin, banned, createdAt, lastLoginAt, totpSecret, totpEnabled, apiToken) VALUES (?, ?, ?, 1, 1, 0, ?, ?, ?, 0, ?)')
    .bind(adminId, 'jason', await hashPassword('jason123'), cstDateTime(), '', '', '').run();
  const data = await defaultData(adminId);
  await saveData(db, data);
}

/* loadData：从 D1 拼出和 Node 版 data.json 一模一样的 data 对象，但只含
   userId 这一个用户的数据（服务、记事、配置全按 userId 隔离）。
   userId 不传或用户不存在时，公开接口用第一个管理员的数据。
   读：users 表 1 条 + meta（该用户的前缀键 + 全局 githubBackup）+
   services / notes（按 userId 过滤）。 */
async function loadData(db, userId) {
  await ensureSchema(db);
  await ensureUsers(db);
  let user = userId ? await getUserById(db, userId) : null;
  if (!user) {
    user = await getAdminUser(db);
    if (!user) throw new Error('no admin user');
  }
  const uid = user.id;
  const metaRows = await db.prepare('SELECT key, value FROM meta WHERE key LIKE ?').bind(`u:${uid}:%`).all();
  const meta = {};
  for (const r of (metaRows.results || [])) meta[r.key.slice(uid.length + 3)] = r.value;
  const gbRow = await db.prepare("SELECT value FROM meta WHERE key = 'githubBackup'").first();
  const svcRows = await db.prepare('SELECT data FROM services WHERE userId = ?').bind(uid).all();
  const services = (svcRows.results || []).map((r) => JSON.parse(r.data));
  const noteRows = await db.prepare('SELECT id, title, content, createdAt, updatedAt FROM notes WHERE userId = ? ORDER BY updatedAt DESC').bind(uid).all();
  const notes = (noteRows.results || []).map((r) => ({ id: r.id, title: r.title, content: r.content, createdAt: r.createdAt, updatedAt: r.updatedAt }));
  const data = {
    userId: uid,
    username: user.username,
    passwordHash: user.passwordHash || '',
    passwordIsDefault: !!user.passwordIsDefault,
    isAdmin: !!user.isAdmin,
    banned: !!user.banned,
    createdAt: user.createdAt || '',
    lastLoginAt: user.lastLoginAt || '',
    xp: Number(meta.xp || 0),
    apiToken: user.apiToken || undefined,
    totpSecret: user.totpSecret || undefined,
    totpEnabled: !!user.totpEnabled,
    achievements: safeJSON(meta.achievements, {}),
    flags: safeJSON(meta.flags, {}),
    history: safeJSON(meta.history, {}),
    categories: safeJSON(meta.categories, null),
    notify: safeJSON(meta.notify, {}),
    githubBackup: gbRow ? safeJSON(gbRow.value, {}) : {},
    /* v65：共享账号库、月度报告、归档记录、登录历史（都是 per-user 的 meta 键） */
    sharedAccounts: safeJSON(meta.sharedAccounts, []),
    monthlyReports: safeJSON(meta.monthlyReports, []),
    archivedLog: safeJSON(meta.archivedLog, []),
    loginHistory: safeJSON(meta.loginHistory, []),
    services,
    notes
  };
  let dirty = ensureMeta(data);
  /* v65：读时把共享账号库解析进服务账号（库为准），解析结果有变就写回快照 */
  const vaultSnap = JSON.stringify(data.services.map((s) => s.accounts || []));
  resolveVaultAccounts(data);
  if (JSON.stringify(data.services.map((s) => s.accounts || [])) !== vaultSnap) dirty = true;
  data.services.forEach((s, i) => {
    if (typeof s.sortOrder !== 'number') { s.sortOrder = i; dirty = true; }
    if (typeof s.visits !== 'number') { s.visits = 0; dirty = true; }
    const snap = JSON.stringify([s.accounts, s.account, s.secret]);
    normalizeAccounts(s);
    if (JSON.stringify([s.accounts, s.account, s.secret]) !== snap) dirty = true;
  });
  if (dirty) await saveData(db, data);
  return data;
}
/* GitHub 备份用：整份数据（所有用户 + 全局配置）。备份文件里不含任何密码哈希，
   见 strippedBackupDataV2。 */
async function loadAllData(db) {
  await ensureSchema(db);
  await ensureUsers(db);
  const users = await listUsers(db);
  const userData = {};
  for (const u of users) userData[u.id] = await loadData(db, u.id);
  const gbRow = await db.prepare("SELECT value FROM meta WHERE key = 'githubBackup'").first();
  return { users, userData, githubBackup: gbRow ? safeJSON(gbRow.value, {}) : {} };
}
async function defaultData(adminId) {
  return {
    userId: adminId,
    username: 'jason',
    passwordHash: await hashPassword('jason123'),
    passwordIsDefault: true,
    isAdmin: true,
    banned: false,
    createdAt: cstDateTime(),
    lastLoginAt: '',
    xp: 0,
    achievements: {},
    flags: {},
    history: {},
    services: [
      {
        id: 'aa0000000001',
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
        checkins: ['2026-10-25', '2026-10-26'],
        visits: 0,
        sortOrder: 0
      },
      {
        id: 'aa0000000002',
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
        checkins: [],
        visits: 0,
        sortOrder: 1
      }
    ],
    notes: []
  };
}
/* saveData：把这一个用户的数据写回 D1（只动他自己的行，别人的不动）。
   账号字段只更新用户自己能改的那些（用户名/密码哈希/TOTP/API 令牌/最后登录），
   isAdmin / banned / createdAt 由管理员接口直接改表，不在这里动，免得并发
   写回把管理员的操作覆盖掉。GitHub 备份是全局配置，只有管理员保存时才写回。
   免费套餐每请求最多 50 条查询：meta 1 条、services 每 30 行 1 条（3 列 × 30 =
   90 个绑定参数）、notes 每 16 行 1 条（6 列 × 16 = 96 个），再加清理语句；
   56 个服务一共约 7 条语句。 */
function chunkedInsertOrReplace(table, cols, rows, perStmt) {
  const stmts = [];
  for (let i = 0; i < rows.length; i += perStmt) {
    const part = rows.slice(i, i + perStmt);
    const placeholders = part.map(() => `(${cols.map(() => '?').join(',')})`).join(',');
    stmts.push({
      sql: `INSERT OR REPLACE INTO ${table} (${cols.join(',')}) VALUES ${placeholders}`,
      args: part.flat()
    });
  }
  return stmts;
}
async function saveData(db, data) {
  const uid = data.userId;
  if (!uid) throw new Error('saveData: 缺 userId');
  await db.prepare('UPDATE users SET username = ?, passwordHash = ?, passwordIsDefault = ?, totpSecret = ?, totpEnabled = ?, apiToken = ?, lastLoginAt = ? WHERE id = ?')
    .bind(String(data.username || ''), String(data.passwordHash || ''), data.passwordIsDefault ? 1 : 0, String(data.totpSecret || ''), data.totpEnabled ? 1 : 0, String(data.apiToken || ''), String(data.lastLoginAt || ''), uid).run();
  const metaEntries = [
    ['xp', String(data.xp || 0)],
    ['achievements', JSON.stringify(data.achievements || {})],
    ['flags', JSON.stringify(data.flags || {})],
    ['history', JSON.stringify(data.history || {})],
    ['categories', JSON.stringify(Array.isArray(data.categories) ? data.categories : [])],
    ['notify', JSON.stringify(data.notify || {})],
    ['sharedAccounts', JSON.stringify(Array.isArray(data.sharedAccounts) ? data.sharedAccounts : [])],
    ['monthlyReports', JSON.stringify(Array.isArray(data.monthlyReports) ? data.monthlyReports.slice(-12) : [])],
    ['archivedLog', JSON.stringify(Array.isArray(data.archivedLog) ? data.archivedLog.slice(-50) : [])],
    ['loginHistory', JSON.stringify(Array.isArray(data.loginHistory) ? data.loginHistory.slice(-50) : [])]
  ].map(([k, v]) => [userMetaKey(uid, k), v]);
  const stmts = chunkedInsertOrReplace('meta', ['key', 'value'], metaEntries, 40);
  /* GitHub 备份是全局配置，只有管理员保存时才写回（普通用户不碰它） */
  if (data.isAdmin) {
    stmts.push({ sql: 'INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', args: ['githubBackup', JSON.stringify(data.githubBackup || {})] });
  }
  const svcRows = (data.services || []).map((s) => [s.id, JSON.stringify(s), uid]);
  stmts.push(...chunkedInsertOrReplace('services', ['id', 'data', 'userId'], svcRows, 30));
  if (svcRows.length) {
    stmts.push({ sql: `DELETE FROM services WHERE userId = ? AND id NOT IN (${svcRows.map(() => '?').join(',')})`, args: [uid, ...svcRows.map((r) => r[0])] });
  } else {
    stmts.push({ sql: 'DELETE FROM services WHERE userId = ?', args: [uid] });
  }
  const noteRows = (data.notes || []).map((n) => [n.id, n.title, n.content, n.createdAt, n.updatedAt, uid]);
  stmts.push(...chunkedInsertOrReplace('notes', ['id', 'title', 'content', 'createdAt', 'updatedAt', 'userId'], noteRows, 16));
  if (noteRows.length) {
    stmts.push({ sql: `DELETE FROM notes WHERE userId = ? AND id NOT IN (${noteRows.map(() => '?').join(',')})`, args: [uid, ...noteRows.map((r) => r[0])] });
  } else {
    stmts.push({ sql: 'DELETE FROM notes WHERE userId = ?', args: [uid] });
  }
  for (const s of stmts) {
    await db.prepare(s.sql).bind(...s.args).run();
  }
}
/* 会话：D1 存 token + 创建时间 + 所属用户，30 天有效 */
async function currentUser(request, db) {
  const token = parseCookies(request.headers.get('cookie')).session;
  if (!token) return null;
  const row = await db.prepare('SELECT userId, created FROM sessions WHERE token = ?').bind(token).first();
  if (!row || Date.now() - row.created > SESSION_MS) return null;
  let userId = row.userId;
  if (!userId) {
    /* 老会话没有 userId（v67 之前建的）：默认归管理员，并补写 userId */
    const admin = await getAdminUser(db);
    if (!admin) return null;
    userId = admin.id;
    await db.prepare('UPDATE sessions SET userId = ? WHERE token = ?').bind(userId, token).run();
  }
  const user = await getUserById(db, userId);
  if (!user || user.banned) return null; /* 账号被封禁后，已有的会话也失效 */
  return { token, userId, user };
}
async function createSession(db, userId) {
  const token = randomBytes(32).toString('hex');
  await db.prepare('INSERT INTO sessions (token, created, userId) VALUES (?, ?, ?)').bind(token, Date.now(), userId).run();
  await db.prepare('DELETE FROM sessions WHERE created < ?').bind(Date.now() - SESSION_MS).run();
  return token;
}
async function deleteSession(db, token) {
  await db.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
}
/* v59：API 令牌（给 iOS 快捷指令用）——只放行签到那两个接口。
   v67：令牌是每个用户自己的，返回令牌所属用户（封禁用户的令牌失效）。 */
async function apiTokenUser(request, db) {
  const h = request.headers.get('authorization') || '';
  const m = h.match(/^Bearer\s+(\S+)$/i);
  let tok = m ? m[1] : '';
  if (!tok) {
    try { tok = new URL(request.url).searchParams.get('token') || ''; } catch { tok = ''; }
  }
  if (!tok) return null;
  const row = await db.prepare('SELECT id, username, banned FROM users WHERE apiToken = ?').bind(tok).first();
  if (!row || row.banned) return null;
  return { userId: row.id, user: row };
}
function isTokenAllowedEndpoint(pathname, method) {
  if (method !== 'POST') return false;
  if (pathname === '/api/checkins/all') return true;
  return /^\/api\/services\/[0-9a-f]+\/checkin$/.test(pathname);
}
/* ---------- 多账号 ---------- */
function sanitizeAccount(a) {
  if (!a || typeof a !== 'object') return null;
  return {
    id: String(a.id || randomBytes(6).toString('hex')).slice(0, 32),
    label: String(a.label || '').trim().slice(0, 30) || '账号',
    username: String(a.username || '').trim().slice(0, 200),
    password: String(a.password || '').slice(0, 500),
    notes: String(a.notes || '').trim().slice(0, 200),
    isDefault: !!a.isDefault,
    /* v65：链接到共享账号库的账号（sharedId 指向 vault 里的 id）；passwordChangedAt
       是上次改密码的日期（YYYY-MM-DD），老账号没有这个字段按“未知”处理 */
    sharedId: (typeof a.sharedId === 'string' && a.sharedId.trim()) ? String(a.sharedId).trim().slice(0, 32) : undefined,
    passwordChangedAt: (/^\d{4}-\d{2}-\d{2}$/.test(String(a.passwordChangedAt || ''))) ? String(a.passwordChangedAt) : undefined,
    checkins: (Array.isArray(a.checkins) ? a.checkins : []).filter((d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)).slice(0, 1000).sort()
  };
}
/* v65：共享账号库里的一条账号（只存一份，多服务共用） */
function sanitizeVaultAccount(v) {
  if (!v || typeof v !== 'object') return null;
  const label = String(v.label || '').trim().slice(0, 30);
  const username = String(v.username || '').trim().slice(0, 200);
  const password = String(v.password || '').slice(0, 500);
  if (!label && !username && !password) return null;
  return {
    id: String(v.id || randomBytes(6).toString('hex')).slice(0, 32),
    label: label || '账号',
    username,
    password,
    notes: String(v.notes || '').trim().slice(0, 200),
    passwordChangedAt: (/^\d{4}-\d{2}-\d{2}$/.test(String(v.passwordChangedAt || ''))) ? String(v.passwordChangedAt) : undefined
  };
}
/* v65：读时解析——服务里链接了共享账号库的账号，用户名/密码/备注以库为准
   （改库里的密码，所有链接的服务读出来就跟着变）；库里找不到这条（已被删）
   时保留服务里存的快照，账号自动变回本地副本。 */
function resolveVaultAccounts(data) {
  const vault = Array.isArray(data.sharedAccounts) ? data.sharedAccounts : [];
  if (!vault.length) return;
  const byId = new Map(vault.map((v) => [String(v.id), v]));
  for (const s of (data.services || [])) {
    for (const a of (Array.isArray(s.accounts) ? s.accounts : [])) {
      if (!a.sharedId) continue;
      const v = byId.get(String(a.sharedId));
      if (!v) continue;
      a.label = v.label || a.label;
      a.username = v.username || '';
      a.password = v.password || '';
      a.notes = v.notes || '';
      a.passwordChangedAt = v.passwordChangedAt;
    }
  }
}
function normalizeAccounts(svc) {
  if (!Array.isArray(svc.accounts)) svc.accounts = [];
  svc.accounts = svc.accounts.map(sanitizeAccount).filter(Boolean).slice(0, 20);
  if (!svc.accounts.length && (svc.account || svc.secret)) {
    svc.accounts.push({ id: randomBytes(6).toString('hex'), label: '默认', username: String(svc.account || ''), password: String(svc.secret || ''), notes: '', isDefault: true, checkins: [] });
  }
  let def = svc.accounts.find((a) => a.isDefault);
  if (!def && svc.accounts.length) { svc.accounts[0].isDefault = true; def = svc.accounts[0]; }
  svc.accounts.forEach((a) => { if (a !== def) a.isDefault = false; });
  if (svc.accounts.length && (svc.checkins || []).length && !svc.accounts.some((a) => (a.checkins || []).length)) {
    def.checkins = [...(svc.checkins || [])].sort();
  }
  svc.account = def ? def.username : '';
  svc.secret = def ? def.password : '';
  return svc;
}
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
function clampInt(v, lo, hi, fb) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fb;
}
function checkinEvery(s) {
  return clampInt(s.checkinEveryDays, 1, 365, 1);
}
function renewEvery(s) {
  return clampInt(s.renewDays, 1, 3650, 365);
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
  if (b.customFields !== undefined) out.customFields = sanitizeCustomFields(b.customFields);
  if (b.tags !== undefined) {
    const raw = Array.isArray(b.tags) ? b.tags : String(b.tags || '').split(/[,，、\s]+/);
    const seen = new Set();
    out.tags = raw.map((t) => String(t).trim().slice(0, 20)).filter((t) => t && !seen.has(t) && seen.add(t)).slice(0, 10);
  }
  if (b.autoSignin !== undefined) {
    if (b.autoSignin === null) { out.autoSignin = null; }
    else {
      const cfg = sanitizeAutoSignin(b.autoSignin);
      if (cfg) out.autoSignin = cfg;
      else if (b.autoSignin && typeof b.autoSignin === 'object' && !b.autoSignin.url) out.autoSignin = null;
    }
  }
  if (b.category === 'fav' && (!existing || existing.category !== 'fav')) out.favorite = true;
  if (Array.isArray(b.accounts)) {
    const existingById = new Map((Array.isArray(existing?.accounts) ? existing.accounts : []).map((a) => [String(a.id || ''), a]));
    out.accounts = b.accounts.map((a) => {
      const s = sanitizeAccount(a);
      if (!s) return null;
      if ((!a.checkins || !a.checkins.length) && existingById.has(s.id)) {
        const old = existingById.get(s.id);
        if (Array.isArray(old.checkins)) s.checkins = old.checkins.filter((d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)).slice(0, 1000).sort();
      }
      /* v65：密码变了（或新账号）就记今天为上次改密日期；没变就沿用旧日期；
         客户端直接传了合法日期也认（比如从库里链接过来时带的快照） */
      const old = existingById.get(s.id);
      if (s.password && (!old || old.password !== s.password)) {
        s.passwordChangedAt = todayStr();
      } else if (old && old.passwordChangedAt && !s.passwordChangedAt) {
        s.passwordChangedAt = old.passwordChangedAt;
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
      acc.username = username; acc.password = password;
      out.accounts = base;
    } else {
      out.accounts = [{ id: randomBytes(6).toString('hex'), label: '默认', username, password, notes: '', isDefault: true }];
    }
    out.account = username;
    out.secret = password;
  }
  for (const k of ['url', 'price', 'notes', 'registeredAt', 'expiresAt']) {
    if (typeof b[k] === 'string') out[k] = b[k].trim().slice(0, 500);
  }
  return out;
}

/* ---------- 签到核心（纯函数，和 Node 版一模一样） ---------- */
function dayDiff(a, b) {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400e3);
}
function checkinDue(s, t) {
  const c = (s.checkins || []).filter(Boolean).sort();
  if (!c.length) return true;
  return dayDiff(c[c.length - 1], t) >= checkinEvery(s);
}
function accountCheckins(a) { return Array.isArray(a.checkins) ? a.checkins : []; }
function serviceAccounts(s) { return Array.isArray(s.accounts) ? s.accounts : []; }
function serviceDoneToday(s, t) {
  const accs = serviceAccounts(s);
  if (!accs.length) return (s.checkins || []).includes(t);
  return accs.every((a) => accountCheckins(a).includes(t));
}
function serviceProgress(s, t) {
  const accs = serviceAccounts(s);
  if (!accs.length) return { done: (s.checkins || []).includes(t) ? 1 : 0, total: 1 };
  return { done: accs.filter((a) => accountCheckins(a).includes(t)).length, total: accs.length };
}
function checkinCohort(data, t) {
  return dailyServices(data).filter((s) => !s.abnormal && (checkinDue(s, t) || serviceDoneToday(s, t)));
}
function unsignedDaily(data, t) {
  return dailyServices(data).filter((s) => !s.abnormal && checkinDue(s, t));
}
function doCheckin(data, svc, t) {
  let xp = 0;
  if (!(svc.checkins || []).includes(t)) {
    svc.checkins = svc.checkins || [];
    svc.checkins.push(t);
    svc.checkins.sort();
    data.history[t] = data.history[t] || { c: 0 };
    data.history[t].c++;
    if (!data.history[t].x) { xp += 5; data.history[t].x = 5; }
    data.flags = data.flags || {};
    if (cstHour() < 5) data.flags.night = true;
  }
  return xp;
}
function doCheckinAccount(data, svc, acc, t) {
  acc.checkins = accountCheckins(acc);
  if (acc.checkins.includes(t)) return 0;
  acc.checkins.push(t);
  acc.checkins.sort();
  if (!serviceDoneToday(svc, t)) return 0;
  return doCheckin(data, svc, t);
}
function doUncheckinAccount(data, svc, acc, t) {
  acc.checkins = accountCheckins(acc).filter((d) => d !== t);
  if ((svc.checkins || []).includes(t) && !serviceDoneToday(svc, t)) {
    svc.checkins = svc.checkins.filter((d) => d !== t);
    if (data.history[t]) data.history[t].c = Math.max(0, (data.history[t].c || 1) - 1);
  }
}
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
function daysUntilSrv(dateStr) {
  if (!dateStr) return null;
  const [y, m, d] = dateStr.split('-').map(Number);
  const [ty, tm, td] = todayStr().split('-').map(Number);
  return Math.round((new Date(y, m - 1, d) - new Date(ty, tm - 1, td)) / 86400e3);
}
function expiringList(data) {
  /* v65：已归档的服务不计入临期提醒 */
  return data.services
    .filter((s) => s.expiresAt && !isArchived(s) && daysUntilSrv(s.expiresAt) <= 30)
    .map((s) => ({ s, d: daysUntilSrv(s.expiresAt) }))
    .sort((a, b) => a.d - b.d);
}
/* v65：某服务某月的在线率（linkHistory 里当月的探活记录；没有记录返回 null） */
function uptimeInMonth(svc, yearMonth) {
  const hist = (Array.isArray(svc?.linkHistory) ? svc.linkHistory : []).filter((h) => h && typeof h.t === 'number' && typeof h.ok === 'boolean');
  if (!hist.length) return null;
  const [y, m] = yearMonth.split('-').map(Number);
  const start = Date.UTC(y, m - 1, 1);
  const end = Date.UTC(y, m, 1);
  const inMonth = hist.filter((h) => h.t >= start && h.t < end);
  if (!inMonth.length) return null;
  return {
    rate: Math.round((inMonth.filter((h) => h.ok).length / inMonth.length) * 100),
    count: inMonth.length
  };
}
/* v65：超 90 天没换密码的账号（只认有 passwordChangedAt 的；老账号“未知”不算） */
function stalePasswordAccounts(data, t) {
  const out = [];
  const isStale = (acc) => {
    if (!acc || !/^\d{4}-\d{2}-\d{2}$/.test(String(acc.passwordChangedAt || ''))) return false;
    return dayDiff(acc.passwordChangedAt, t) > 90;
  };
  for (const s of (data.services || [])) {
    for (const a of serviceAccounts(s)) {
      if (isStale(a)) out.push({ serviceId: s.id, service: s.name, label: a.label || '', username: a.username || '', changedAt: a.passwordChangedAt });
    }
  }
  return out;
}
/* v65：月度报告（纯函数，可单元测试）。yearMonth 是 'YYYY-MM'（要生成的月份，
   比如 2026-10）。签到天数/总次数/签到攒的经验都从 history 里算；新增服务按
   registeredAt 落在当月算；到期提醒数按 expiresAt 落在当月算；在线率最低的 3 个
   服务按 linkHistory 当月记录算（没记录的不参与）。 */
function buildMonthlyReport(data, yearMonth) {
  const hist = data.history || {};
  let days = 0, totalCk = 0, xp = 0;
  for (const [d, h] of Object.entries(hist)) {
    if (!d.startsWith(yearMonth + '-')) continue;
    if ((h.c || 0) > 0) days++;
    totalCk += (h.c || 0);
    xp += (h.x || 0) + (h.all ? 10 : 0);
  }
  let top = null, topN = 0;
  for (const s of (data.services || [])) {
    const n = (s.checkins || []).filter((d) => d.startsWith(yearMonth + '-')).length;
    if (n > topN) { topN = n; top = s; }
  }
  const newServices = (data.services || []).filter((s) => (s.registeredAt || '').startsWith(yearMonth + '-')).length;
  const expiring = (data.services || []).filter((s) => (s.expiresAt || '').startsWith(yearMonth + '-')).length;
  const lowest = (data.services || [])
    .map((s) => ({ s, u: uptimeInMonth(s, yearMonth) }))
    .filter((x) => x.u)
    .sort((a, b) => a.u.rate - b.u.rate || b.u.count - a.u.count)
    .slice(0, 3)
    .map((x) => ({ name: x.s.name, rate: x.u.rate, count: x.u.count }));
  return {
    month: yearMonth,
    days,
    totalCk,
    xp,
    topService: top ? top.name : null,
    topCount: topN,
    newServices,
    expiring,
    lowestUptime: lowest,
    generatedAt: cstDateTime()
  };
}
function addYear(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y + 1, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) dt.setUTCDate(0);
  return dt.toISOString().slice(0, 10);
}
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * 86400e3).toISOString().slice(0, 10);
}
/* v66：续期一律从今天起算——提前续期不保留剩余天数（新到期日 = 今天 + 续期周期，
   注册/购买日期也设为今天，新周期从今天开始）。已过期的服务本来就是从今天起算，
   结果不变。365 天按加一年（2 月 29 日 → 2 月 28 日），其他天数直接加天数。 */
function renewDates(t, days) {
  return { registeredAt: t, expiresAt: days === 365 ? addYear(t) : addDays(t, days) };
}

/* ---------- Telegram 通知 ---------- */
function notifyCfg(data) {
  if (!data.notify || typeof data.notify !== 'object') data.notify = {};
  return data.notify;
}
function tgApiUrl(token, method) { return `https://api.telegram.org/bot${token}/${method}`; }
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
function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
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
/* 每小时检查一次；北京时间 9 点后才发（默认，设置里可改）。每天每种最多发一次。 */
async function runNotifyChecks(db, userId) {
  try {
    const data = await loadData(db, userId);
    const n = notifyCfg(data);
    if (!(n.token && n.chatId) && !n.webhookUrl && !n.barkKey && !n.serverChanKey) return;
    const prevNotify = { lastExpiring: n.lastExpiring, lastCheckin: n.lastCheckin, lastCheckinRepeatAt: n.lastCheckinRepeatAt };
    const pushHour = (n.pushHour === undefined ? 9 : n.pushHour);
    if (cstHour() < pushHour) return;
    const t = todayStr();
    let dirty = false;
    const tryPush = async (title, htmlText, tgMarkup) => {
      try {
        const r = await sendMultiChannel(n, title, htmlText, tgMarkup);
        if (!r.ok) console.error('[!] 多渠道推送全部失败');
        return r.ok;
      } catch (e) { console.error('[!] 多渠道推送异常:', e.message); return false; }
    };
    if (n.expiring !== false && n.lastExpiring !== t) {
      const items = expiringList(data);
      let ok = true;
      if (items.length) {
        ok = await tryPush(`服务台临期提醒 · ${t}`,
          `⏰ <b>服务台临期提醒</b> · ${t}\n共 ${items.length} 个服务临期：\n\n${expiringLines(items).join('\n')}`);
      }
      if (ok) { n.lastExpiring = t; dirty = true; }
    }
    if (n.checkin !== false && n.lastCheckin !== t) {
      const todo = unsignedDaily(data, t);
      let ok = true;
      if (todo.length) {
        /* v65：密码轮换提醒——有账号超 90 天没换密码时，在签到提醒里加一句 */
        const stale = stalePasswordAccounts(data, t);
        const staleLine = stale.length ? `\n\n🔑 另外还有 ${stale.length} 个账号密码超 90 天没换了，记得去换（数据中心「该换密码了」里有名单）。` : '';
        ok = await tryPush(`服务台签到提醒 · ${t}`,
          `⚡ <b>服务台签到提醒</b> · ${t}\n今日还有 ${todo.length} 个站未签到：\n\n${checkinLines(todo).join('\n')}\n\n👉 点下面按钮直接签完，别断了连签。${staleLine}`, CHECKIN_KB);
      }
      if (ok) { n.lastCheckin = t; n.lastCheckinRepeatAt = Date.now(); dirty = true; }
    }
    if (n.checkin !== false && n.repeatHours > 0 && n.lastCheckin === t) {
      const todo = unsignedDaily(data, t);
      const h = cstHour();
      const last = n.lastCheckinRepeatAt || 0;
      if (todo.length && h >= pushHour && h < 23 && Date.now() - last >= n.repeatHours * 3600e3) {
        const okR = await tryPush(`服务台签到提醒（复查）· ${t}`,
          `⚡ <b>服务台签到提醒（复查）</b> · ${t}\n今日还有 ${todo.length} 个站未签到：\n\n${checkinLines(todo).join('\n')}\n\n👉 点下面按钮直接签完，别断了连签。`, CHECKIN_KB);
        if (okR) { n.lastCheckinRepeatAt = Date.now(); dirty = true; }
      }
    }
    if (dirty) {
      /* 写回前重读：这一小时里用户可能改过数据，只合并提醒自己改的日期字段 */
      const fresh = await loadData(db, userId);
      const fn = notifyCfg(fresh);
      for (const k of ['lastExpiring', 'lastCheckin', 'lastCheckinRepeatAt']) {
        if (n[k] !== undefined && n[k] !== prevNotify[k]) fn[k] = n[k];
      }
      await saveData(db, fresh);
    }
  } catch (e) { console.error('[!] TG 定时检查异常:', e.message); }
}
/* 机器人回话：每分钟拉一次 getUpdates，只回配置好的那个 Chat ID。永不传 offset，
   用 tgSeen 记已处理的最大 update_id 去重。 */
function snapshotPollState(data) {
  return {
    tgSeen: (data.notify || {}).tgSeen,
    checkins: new Map(data.services.map((s) => [s.id, JSON.stringify(s.checkins || [])])),
    history: JSON.parse(JSON.stringify(data.history || {})),
    xp: data.xp,
    achievements: JSON.parse(JSON.stringify(data.achievements || {})),
    flags: JSON.parse(JSON.stringify(data.flags || {}))
  };
}
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
async function pollBotCommands(db, userId) {
  try {
    const data = await loadData(db, userId);
    const n = notifyCfg(data);
    if (!n.token || !n.chatId) return;
    const snap = snapshotPollState(data);
    const res = await fetch(tgApiUrl(n.token, 'getUpdates'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
    });
    const j = await res.json().catch(() => ({}));
    if (!j.ok || !Array.isArray(j.result)) return;
    if (n.tgSeen === undefined) {
      n.tgSeen = j.result.reduce((m, u) => Math.max(m, u.update_id || 0), 0);
      await saveData(db, mergePollWrites(await loadData(db, userId), data, snap));
      return;
    }
    const fresh = j.result.filter((u) => (u.update_id || 0) > n.tgSeen);
    if (!fresh.length) return;
    const t = todayStr();
    for (const u of fresh) {
      n.tgSeen = Math.max(n.tgSeen, u.update_id || 0);
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
    await saveData(db, mergePollWrites(await loadData(db, userId), data, snap));
  } catch (e) { console.error('[!] TG 命令轮询异常:', e.message); }
}

/* ---------- 死链检测 ---------- */
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
/* v65：SSL 证书到期日——Workers 里 fetch 读不到证书，改用 crt.sh 公开 API。
   取该域名下“当前有效”（not_before <= 现在 < not_after）且 not_after 最晚的那张
   证书的到期日。crt.sh 有速率限制：失败就返回 null（跳过，不报错、不重试）。 */
async function checkCertExpiry(host) {
  try {
    const res = await fetch(`https://crt.sh/?q=${encodeURIComponent(host)}&output=json`, {
      signal: AbortSignal.timeout(6000),
      headers: { 'User-Agent': 'hubmate' }
    });
    if (!res.ok) return null;
    const list = await res.json().catch(() => null);
    if (!Array.isArray(list)) return null;
    const now = Date.now();
    let best = null;
    for (const c of list) {
      if (!c || typeof c.not_after !== 'string' || typeof c.not_before !== 'string') continue;
      /* 只认明确包含这个域名的证书（name_value 里多行，每行一个域名；通配符 *.example.com 也认） */
      const names = String(c.name_value || '').split('\n').map((x) => x.trim().toLowerCase());
      const hit = names.some((n) => n === host || (n.startsWith('*.') && host.endsWith(n.slice(1))));
      if (!hit) continue;
      const nb = Date.parse(c.not_before), na = Date.parse(c.not_after);
      if (!Number.isFinite(nb) || !Number.isFinite(na)) continue;
      if (nb <= now && na > now && (!best || na > best)) best = na;
    }
    if (!best) return null;
    return new Date(best).toISOString().slice(0, 10); // YYYY-MM-DD
  } catch { return null; }
}
async function checkLinks(db, userId) {
  try {
    const data = await loadData(db, userId);
    const t = todayStr();
    const now = Date.now();
    const results = await Promise.all(data.services.map(async (s) => ({ id: s.id, st: await probeLink(s.url) })));
    /* v65：证书到期监控——只对 https 的站查，每天每个域名最多查一次（按 certCheckedAt
       记日期），crt.sh 失败就跳过，绝不影响死链检测本身。每轮最多查 9 个域名（每批 3 个
       并发），剩下的下一轮再查，免得定时任务超时 */
    const certHosts = new Map(); // host -> [service ids]
    for (const s of data.services) {
      let host = '';
      try {
        const u = new URL(/^https?:\/\//i.test(s.url || '') ? s.url : 'https://' + (s.url || ''));
        if (u.protocol !== 'https:') continue;
        host = u.hostname.toLowerCase();
      } catch { continue; }
      if (!host || s.certCheckedAt === t) continue;
      if (!certHosts.has(host)) certHosts.set(host, []);
      certHosts.get(host).push(s.id);
      if (certHosts.size >= 9) break;
    }
    const certResults = new Map(); // host -> YYYY-MM-DD | null
    const certHostList = [...certHosts.keys()];
    for (let i = 0; i < certHostList.length; i += 3) {
      const batch = certHostList.slice(i, i + 3);
      const outs = await Promise.all(batch.map((h) => checkCertExpiry(h)));
      batch.forEach((h, j) => certResults.set(h, outs[j]));
    }
    const fresh = await loadData(db, userId);
    let changed = false;
    for (const { id, st } of results) {
      const s = fresh.services.find((x) => x.id === id);
      if (!s) continue;
      if (s.linkStatus !== st) { s.linkStatus = st; s.linkCheckedAt = t; changed = true; }
      if (st === 'ok' || st === 'dead') {
        s.linkHistory = (Array.isArray(s.linkHistory) ? s.linkHistory : []).filter((h) => h && typeof h.t === 'number');
        s.linkHistory.push({ t: now, ok: st === 'ok' });
        if (s.linkHistory.length > 120) s.linkHistory = s.linkHistory.slice(-120);
        changed = true;
      }
    }
    for (const [host, ids] of certHosts) {
      const exp = certResults.get(host);
      for (const id of ids) {
        const s = fresh.services.find((x) => x.id === id);
        if (!s) continue;
        s.certCheckedAt = t;
        if (exp) s.certExpiresAt = exp;
        changed = true;
      }
    }
    if (changed) await saveData(db, fresh);
    return {
      total: results.length,
      dead: results.filter((r) => r.st === 'dead').length,
      ok: results.filter((r) => r.st === 'ok').length,
      unknown: results.filter((r) => r.st === 'unknown').length,
      changed
    };
  } catch (e) { console.error('[!] 链接检测异常:', e.message); return null; }
}

/* ---------- 自动签到 ---------- */
async function tryAutoSignin(svc, cfg) {
  try {
    const res = await fetch(cfg.url, {
      method: cfg.method,
      headers: cfg.headers,
      body: cfg.method === 'POST' && cfg.body ? cfg.body : undefined,
      signal: AbortSignal.timeout(15000),
      redirect: 'follow'
    });
    const text = await res.text().catch(() => '');
    const ok = res.status >= 200 && res.status < 300 && (!cfg.expect || text.includes(cfg.expect));
    return { ok, status: res.status, note: ok ? '' : (res.status >= 200 && res.status < 300 ? `响应里没找到“${cfg.expect}”` : `HTTP ${res.status}`) };
  } catch (e) {
    return { ok: false, status: 0, note: e.name === 'AbortError' ? '请求超时（15 秒）' : (e.message || '请求失败') };
  }
}
async function runAutoSignins(db, userId) {
  try {
    const data = await loadData(db, userId);
    const t = todayStr();
    const due = checkinCohort(data, t);
    const results = [];
    let changed = false;
    for (const svc of due) {
      const cfg = autoSigninOf(svc);
      if (!cfg) continue;
      if (serviceDoneToday(svc, t)) continue;
      const r = await tryAutoSignin(svc, cfg);
      svc.autoSigninLast = { at: cstDateTime(), ok: r.ok, status: r.status, note: r.note || '' };
      changed = true;
      if (r.ok) {
        doCheckin(data, svc, t);
        results.push({ id: svc.id, name: svc.name, ok: true });
      } else {
        results.push({ id: svc.id, name: svc.name, ok: false, note: r.note });
      }
    }
    if (changed) await saveData(db, data);
    if (results.length) console.log(`[auto-signin] ${results.filter((r) => r.ok).length}/${results.length} 成功`);
    return results;
  } catch (e) { console.error('[!] 自动签到异常:', e.message); return null; }
}

/* v65：月度报告——每月 1 号（北京时间）生成上月的报告并推多渠道。
   每小时跑一轮时检查：上月报告还没生成就生成并推送（只推一次，生成后就记下来了）。 */
function prevMonthStr() {
  const [y, m] = todayStr().split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
async function runMonthlyReport(db, userId, force) {
  try {
    const data = await loadData(db, userId);
    const ym = prevMonthStr();
    if (!Array.isArray(data.monthlyReports)) data.monthlyReports = [];
    if (data.monthlyReports.some((r) => r && r.month === ym)) return { ok: true, skipped: true, month: ym };
    const report = buildMonthlyReport(data, ym);
    data.monthlyReports.push(report);
    data.monthlyReports = data.monthlyReports.slice(-12);
    await saveData(db, data);
    const n = notifyCfg(data);
    const hasChannel = (n.token && n.chatId) || n.webhookUrl || n.barkKey || n.serverChanKey;
    if (hasChannel) {
      const low = report.lowestUptime.length
        ? report.lowestUptime.map((x) => `• ${x.name}：${x.rate}%（${x.count} 次探测）`).join('\n')
        : '本月没有在线率数据';
      const text = `📊 <b>月度报告 · ${ym}</b>\n签到 ${report.days} 天 · 共 ${report.totalCk} 次 · 攒了 ${report.xp}⚡\n最常签到：${report.topService ? `${report.topService}（${report.topCount} 次）` : '—'}\n新增服务 ${report.newServices} 个 · 当月到期 ${report.expiring} 个\n\n📉 本月在线率最低：\n${low}`;
      await sendMultiChannel(n, `月度报告 · ${ym}`, text).catch((e) => console.error('[!] 月度报告推送失败:', e.message));
    }
    return { ok: true, month: ym, report };
  } catch (e) { console.error('[!] 月度报告异常:', e.message); return { ok: false, note: e.message }; }
}
/* v65：到期自动归档——每天跑一次：到期日超过 30 天还没续的服务，自动归到
   “已归档”分类（不存在就新建，图标 🗄️）；归档记录记在 meta.archivedLog 里。
   归档的服务不计入签到队列/临期提醒/Telegram 提醒（dailyServices 和 expiringList
   里已经排除了）；用户手动把分类改回去就恢复正常。 */
async function runAutoArchive(db, userId) {
  try {
    const data = await loadData(db, userId);
    const t = todayStr();
    const cats = ensureCategories(data);
    let archivedCat = cats.find((c) => c.id === ARCHIVED_CAT.id);
    const toArchive = data.services.filter((s) => {
      if (!s.expiresAt || isArchived(s)) return false;
      return dayDiff(s.expiresAt, t) > 30;
    });
    if (!toArchive.length) return { ok: true, archived: 0 };
    if (!archivedCat) {
      archivedCat = { ...ARCHIVED_CAT };
      cats.push(archivedCat);
    }
    if (!Array.isArray(data.archivedLog)) data.archivedLog = [];
    for (const s of toArchive) {
      s.category = ARCHIVED_CAT.id;
      data.archivedLog.push({ id: s.id, name: s.name, at: cstDateTime() });
    }
    data.archivedLog = data.archivedLog.slice(-50);
    await saveData(db, data);
    console.log(`[auto-archive] 归档 ${toArchive.length} 个：${toArchive.map((s) => s.name).join('、')}`);
    return { ok: true, archived: toArchive.length, names: toArchive.map((s) => s.name) };
  } catch (e) { console.error('[!] 自动归档异常:', e.message); return { ok: false, note: e.message }; }
}

/* ---------- GitHub 自动备份（v67：整份数据，所有用户） ---------- */
/* 一个用户的备份数据（去掉登录密码哈希、API 令牌、TOTP 密钥、通知渠道密钥、
   自动签到请求头）。users 表里的账号字段不在这里，备份文件里不含任何密码哈希。 */
function strippedUserBackup(data) {
  const out = { ...data };
  delete out.userId;
  delete out.username;
  delete out.passwordHash;
  delete out.apiToken;
  delete out.totpSecret;
  delete out.isAdmin;
  delete out.banned;
  delete out.createdAt;
  delete out.lastLoginAt;
  out.services = (data.services || []).map((s) => {
    if (!s.autoSignin) return s;
    return { ...s, autoSignin: { ...s.autoSignin, headers: {} } };
  });
  out.notify = { ...(data.notify || {}) };
  delete out.notify.token;
  delete out.notify.webhookUrl;
  delete out.notify.barkKey;
  delete out.notify.serverChanKey;
  delete out.githubBackup; /* 全局配置只在顶层放一份 */
  return out;
}
/* v2 备份格式：{ version: 2, exportedAt, users: [账号信息（无密码哈希）],
   userData: { userId: 该用户的业务数据 }, githubBackup: {配置（无 Token）} } */
function strippedBackupDataV2(all) {
  const userData = {};
  for (const [uid, d] of Object.entries(all.userData || {})) userData[uid] = strippedUserBackup(d);
  const gb = { ...(all.githubBackup || {}) };
  delete gb.token;
  return {
    version: 2,
    exportedAt: cstDateTime(),
    users: (all.users || []).map(publicUser),
    userData,
    githubBackup: gb
  };
}
/* 把一份备份里的单个用户业务数据映射回 data 对象（服务逐字段清洗，分类、
   历史、经验、记事本、共享账号库、月度报告、归档记录、登录历史都恢复；通知渠道的
   密钥不覆盖（留着当前配好的），账号（users/invite_codes）不动）。
   v1 旧备份（顶层就是 services）和 v2 备份里的 userData[uid] 都走这里。 */
function restoreUserData(data, imp) {
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
    abnormal: !!s.abnormal,
    accounts: (Array.isArray(s.accounts) ? s.accounts : []).map(sanitizeAccount).filter(Boolean).slice(0, 20),
    checkins: Array.isArray(s.checkins) ? s.checkins.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)) : [],
    visits: Number(s.visits) || 0,
    sortOrder: Number(s.sortOrder) || 0,
    linkStatus: s.linkStatus,
    linkHistory: (Array.isArray(s.linkHistory) ? s.linkHistory : []).filter((h) => h && typeof h.t === 'number' && typeof h.ok === 'boolean').slice(-120),
    /* v65：证书到期日和检查日期也随备份恢复 */
    certExpiresAt: (/^\d{4}-\d{2}-\d{2}$/.test(String(s.certExpiresAt || ''))) ? String(s.certExpiresAt) : undefined,
    certCheckedAt: (/^\d{4}-\d{2}-\d{2}$/.test(String(s.certCheckedAt || ''))) ? String(s.certCheckedAt) : undefined,
    renewHistory: (Array.isArray(s.renewHistory) ? s.renewHistory : []).filter((h) => h && /^\d{4}-\d{2}-\d{2}$/.test(h.at || '') && typeof h.from === 'string' && typeof h.to === 'string').slice(-20),
    tags: (Array.isArray(s.tags) ? s.tags : []).map((t) => String(t).trim().slice(0, 20)).filter(Boolean).slice(0, 10),
    customFields: sanitizeCustomFields(s.customFields),
    autoSignin: sanitizeAutoSignin(s.autoSignin),
    autoSigninLast: (s.autoSigninLast && typeof s.autoSigninLast === 'object') ? { at: String(s.autoSigninLast.at || '').slice(0, 30), ok: !!s.autoSigninLast.ok, status: Number(s.autoSigninLast.status) || 0, note: String(s.autoSigninLast.note || '').slice(0, 200) } : undefined
  }));
  data.services.forEach(normalizeAccounts);
  data.categories = cats.map((c) => ({ id: c.id, label: String(c.label).slice(0, 20), icon: cleanIcon(c.icon), cls: c.cls || 't-custom' }));
  if (imp.history && typeof imp.history === 'object') data.history = imp.history;
  if (imp.achievements && typeof imp.achievements === 'object') data.achievements = imp.achievements;
  if (Number(imp.xp) >= 0) data.xp = Number(imp.xp);
  if (imp.flags && typeof imp.flags === 'object') data.flags = imp.flags;
  /* v65：备份里带回来的共享账号库、月度报告、归档记录、登录历史也一并恢复 */
  if (Array.isArray(imp.sharedAccounts)) data.sharedAccounts = imp.sharedAccounts.map(sanitizeVaultAccount).filter(Boolean).slice(0, 200);
  if (Array.isArray(imp.monthlyReports)) data.monthlyReports = imp.monthlyReports.filter((r) => r && typeof r.month === 'string').slice(-12);
  if (Array.isArray(imp.archivedLog)) data.archivedLog = imp.archivedLog.filter((r) => r && typeof r.id === 'string').slice(-50);
  if (Array.isArray(imp.loginHistory)) data.loginHistory = imp.loginHistory.filter((r) => r && typeof r.at === 'string').slice(-50);
  /* 记事本：之前漏了，备份里有 notes 但恢复时没写回，导致恢复后记事全丢 */
  if (Array.isArray(imp.notes)) data.notes = imp.notes.filter((n) => n && typeof n.id === 'string').map((n) => ({ id: String(n.id), title: String(n.title || '').slice(0, 100), content: String(n.content || '').slice(0, 20000), createdAt: String(n.createdAt || ''), updatedAt: String(n.updatedAt || '') }));
  if (imp.notify && typeof imp.notify === 'object') {
    const n = notifyCfg(data);
    const keep = { token: n.token, webhookUrl: n.webhookUrl, barkKey: n.barkKey, serverChanKey: n.serverChanKey };
    Object.assign(n, imp.notify);
    for (const k of ['token', 'webhookUrl', 'barkKey', 'serverChanKey']) {
      if (keep[k]) n[k] = keep[k]; else delete n[k];
    }
  }
}
async function pushGithubBackup(db) {
  try {
    const all = await loadAllData(db);
    const gb = all.githubBackup || {};
    if (!gb.token || !gb.repo || !/^[^/\s]+\/[^/\s]+$/.test(gb.repo)) return null;
    const content = JSON.stringify(strippedBackupDataV2(all), null, 2);
    const hash = createHash('sha256').update(content).digest('hex');
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
    const fresh = await loadData(db);
    fresh.githubBackup = { ...(fresh.githubBackup || {}), lastAt: cstDateTime(), lastOk: ok, lastNote: note, ...(ok ? { lastHash: hash } : {}) };
    await saveData(db, fresh);
    console.log(`[github-backup] ${ok ? '成功' : '失败 ' + note}`);
    return { ok, note };
  } catch (e) { console.error('[!] GitHub 备份异常:', e.message); return { ok: false, note: e.message }; }
}

/* ---------- 台账 ---------- */
function mdCell(v) { return String(v ?? '').replace(/\|/g, '/').replace(/\r?\n/g, ' '); }
function ledgerMarkdown(data, origin) {
  const titles = {
    fav: '★ 收藏',
    checkin: '📅 每日签到类',
    relay: '🔀 中转站 / API 站点',
    vps: '🖥️ VPS / 服务器',
    game: '🎮 游戏相关（游戏机 / 平台 / 订阅）',
    domain: '🌐 域名 / 其他订阅',
    idle: '🧟 已闲置 / 忘了干嘛的'
  };
  let md = `# 🗂️ 我的服务台账\n\n> 由「服务台」系统自动导出于 ${todayStr()}。请勿手改本文件——在系统里增删后点「导出台账」即可刷新。\n> 系统地址：${origin || ''}\n`;
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
async function jsonBody(request) {
  if (request._bodyJson !== undefined) return request._bodyJson;
  try {
    const text = await request.text();
    if (text.length > 1e6) { request._bodyJson = {}; return request._bodyJson; }
    request._bodyJson = text ? JSON.parse(text) : {};
  } catch { request._bodyJson = {}; }
  return request._bodyJson;
}

/* v65：登录历史——每次登录成功记一条（时间、IP、UA 粗存，保留最近 50 条）；
   本次登录 IP 和上一次不同时，多渠道发一条异地登录提醒。登录接口返回时不带历史。 */
function parseDevice(ua) {
  const s = String(ua || '');
  let os = '未知设备';
  if (/iPhone/i.test(s)) os = 'iPhone';
  else if (/iPad/i.test(s)) os = 'iPad';
  else if (/Android/i.test(s)) os = 'Android';
  else if (/Windows/i.test(s)) os = 'Windows';
  else if (/Mac OS X/i.test(s)) os = 'Mac';
  else if (/Linux/i.test(s)) os = 'Linux';
  let br = '';
  if (/Edg\//i.test(s)) br = 'Edge';
  else if (/Chrome\//i.test(s)) br = 'Chrome';
  else if (/Safari\//i.test(s) && !/Chrome/i.test(s)) br = 'Safari';
  else if (/Firefox\//i.test(s)) br = 'Firefox';
  return br ? `${os} · ${br}` : os;
}
async function recordLogin(db, data, request) {
  const ip = clientIp(request);
  const ua = String(request.headers.get('user-agent') || '').slice(0, 300);
  if (!Array.isArray(data.loginHistory)) data.loginHistory = [];
  const prev = data.loginHistory[data.loginHistory.length - 1];
  data.loginHistory.push({ at: cstDateTime(), ip, ua });
  data.loginHistory = data.loginHistory.slice(-50);
  await saveData(db, data);
  if (prev && prev.ip && prev.ip !== ip) {
    const n = notifyCfg(data);
    const hasChannel = (n.token && n.chatId) || n.webhookUrl || n.barkKey || n.serverChanKey;
    if (hasChannel) {
      await sendMultiChannel(n, '异地登录提醒',
        `🔐 <b>异地登录提醒</b>\n刚才有人从新 IP 登录了你的服务台：\nIP：${ip}\n设备：${escHtml(parseDevice(ua))}\n时间：${cstDateTime()}（北京时间）\n上次登录 IP：${prev.ip}\n如果不是你，请立即改密码并检查账号。`).catch((e) => console.error('[!] 异地登录提醒失败:', e.message));
    }
  }
}

async function handleAPI(request, env, pathname) {
  const db = env.DB;
  const method = request.method;
  const send = (status, obj, headers) => jsonResponse(status, obj, headers);

  /* 健康检查不依赖数据库：D1 未绑定时它也能告诉你 db:false，
     免得所有接口一起 500、前端只剩空白却看不出原因。 */
  if (pathname === '/api/healthz' && method === 'GET') {
    return send(200, { ok: true, runtime: 'workers', db: !!db });
  }

  /* D1 没绑定时直接明说，不要等 ensureSchema 里报一个看不懂的 500：
     常见于 Deploy 按钮部署后没绑 D1，或 wrangler.toml 里的 database_id 对不上。 */
  if (!db) {
    return send(503, { error: 'D1 数据库未绑定：请在 Cloudflare Worker 设置里绑定名为 DB 的 D1 数据库（hubmate）后重新部署' });
  }

  /* v67：所有 API 入口先保证表结构存在（ensureSchema 内部有 promise 缓存，
     每个 isolate 只跑一次 DDL）。没有这一步，全新 D1 上第一个 /api/captcha
     或 /api/login 请求会因为 captchas/login_throttle/users 表不存在而 500。 */
  await ensureSchema(db);

  if (pathname === '/api/captcha' && method === 'GET') {
    return send(200, await makeCaptcha(db));
  }

  if (pathname === '/api/login' && method === 'POST') {
    const ip = clientIp(request);
    if (await loginThrottled(db, ip)) {
      console.warn(`[!] 登录过于频繁，已临时封禁：${ip}`);
      return send(429, { error: '尝试太频繁，请 10 分钟后再试' });
    }
    const body = await jsonBody(request);
    if (!(await verifyCaptcha(db, body.captchaId, body.captcha))) {
      return send(400, { error: '验证码不对或已过期，请重新输入' });
    }
    /* v67 多用户：按用户名找账号（查不到和密码不对都回同一个 401，不泄露账号是否存在）；
       密码对了但被封禁才回“账号已被封禁” */
    await ensureUsers(db);
    const user = await getUserByUsername(db, String(body.username || '').trim());
    if (!user || !(await verifyPassword(body.password, user.passwordHash))) {
      return send(401, { error: '用户名或密码不对' });
    }
    if (user.banned) return send(401, { error: '账号已被封禁，请联系管理员' });
    if (user.totpEnabled && user.totpSecret) {
      if (!body.totp) return send(401, { error: 'need_totp' });
      if (!(await verifyTotp(user.totpSecret, body.totp))) return send(401, { error: '二次验证失败' });
    }
    const token = await createSession(db, user.id);
    const data = await loadData(db, user.id);
    data.lastLoginAt = cstDateTime();
    /* v65：登录成功记一条登录历史；IP 和上次不同时发异地提醒（在 recordLogin 里） */
    await recordLogin(db, data, request);
    /* Workers 线上永远是 HTTPS，给 Cookie 加 Secure；本地 wrangler dev 是 http，
       加了 Secure 浏览器/curl 反而不会把 Cookie 发回来，所以只在 https 请求上加 */
    const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
    return send(200, { ok: true, username: user.username, isAdmin: !!user.isAdmin }, {
      'Set-Cookie': `session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_MS / 1000}${secure}`
    });
  }

  /* v67：注册——除第一个默认用户外，注册必须提供邀请码（一个码只能用一次，
     用完即消耗）。注册也要过图形验证码，免得机器人拿着码批量刷号。
     注册成功直接登录（发会话 Cookie），不用再登一次。 */
  if (pathname === '/api/register' && method === 'POST') {
    const ip = clientIp(request);
    if (await loginThrottled(db, ip)) {
      return send(429, { error: '尝试太频繁，请 10 分钟后再试' });
    }
    const body = await jsonBody(request);
    if (!(await verifyCaptcha(db, body.captchaId, body.captcha))) {
      return send(400, { error: '验证码不对或已过期，请重新输入' });
    }
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const code = String(body.inviteCode || '').trim().toUpperCase();
    if (!validUsername(username)) return send(400, { error: '用户名不对（2–32 位，字母/数字/中文/下划线）' });
    if (!password || password.length < 6) return send(400, { error: '密码至少 6 位' });
    if (!code) return send(400, { error: '请填写邀请码' });
    await ensureUsers(db);
    if (await getUserByUsername(db, username)) return send(400, { error: '这个用户名已经被用了' });
    const inv = await db.prepare('SELECT * FROM invite_codes WHERE code = ?').bind(code).first();
    if (!inv) return send(400, { error: '邀请码不对' });
    if (inv.usedBy) return send(400, { error: '这个邀请码已经用过了' });
    const id = randomBytes(6).toString('hex');
    await db.prepare('INSERT INTO users (id, username, passwordHash, passwordIsDefault, isAdmin, banned, createdAt, lastLoginAt, totpSecret, totpEnabled, apiToken) VALUES (?, ?, ?, 0, 0, 0, ?, ?, ?, 0, ?)')
      .bind(id, username, await hashPassword(password), cstDateTime(), '', '', '').run();
    await db.prepare('UPDATE invite_codes SET usedBy = ?, usedAt = ? WHERE code = ?').bind(id, cstDateTime(), code).run();
    const token = await createSession(db, id);
    const data = await loadData(db, id);
    data.lastLoginAt = cstDateTime();
    await recordLogin(db, data, request);
    const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
    return send(200, { ok: true, username, isAdmin: false }, {
      'Set-Cookie': `session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_MS / 1000}${secure}`
    });
  }

  if (pathname === '/api/public' && method === 'GET') {
    const data = await loadData(db);
    const unlocked = syncAchievements(data);
    if (unlocked.length) await saveData(db, data);
    const payload = metaPayload(data);
    payload.services = publicServices(data);
    return send(200, payload);
  }

  if (pathname === '/api/calendar.ics' && method === 'GET') {
    const data = await loadData(db);
    const escICS = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//HubMate//Expiry Calendar//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:HubMate 服务到期日'];
    for (const s of data.services) {
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
    return new Response(lines.join('\r\n'), {
      status: 200,
      headers: Object.assign({ 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'no-store' }, SEC_HEADERS)
    });
  }

  /* v62：浏览器扩展按域名取账号——登录会话或 API 令牌都认（v67：只返回令牌/会话
     所属用户自己的账号） */
  if (pathname === '/api/accounts/by-domain' && method === 'GET') {
    const byAuth = await currentUser(request, db);
    const byToken = !byAuth ? await apiTokenUser(request, db) : null;
    const who = byAuth || byToken;
    if (!who) return send(401, { error: '未登录' });
    const raw = new URL(request.url).searchParams.get('domain') || '';
    const dom = raw.trim().toLowerCase().replace(/^www\./, '').replace(/:\d+$/, '');
    if (!dom || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(dom)) return send(400, { error: '域名不对' });
    const data = await loadData(db, who.userId);
    const out = [];
    for (const s of data.services) {
      let host = '';
      try { host = new URL(/^https?:\/\//i.test(s.url || '') ? s.url : 'https://' + (s.url || '')).hostname.toLowerCase().replace(/^www\./, ''); } catch { continue; }
      if (!host || !(host === dom || host.endsWith('.' + dom))) continue;
      for (const a of serviceAccounts(s)) {
        out.push({ serviceId: s.id, serviceName: s.name, label: a.label || '', username: a.username || '', password: a.password || '', url: s.url || '' });
      }
      if (out.length >= 20) break;
    }
    return send(200, { ok: true, domain: dom, accounts: out.slice(0, 20) });
  }

  const auth = await currentUser(request, db);
  const tokenUser = !auth ? await apiTokenUser(request, db) : null;
  const tokenAllowed = !auth && !!tokenUser && isTokenAllowedEndpoint(pathname, method);
  if (!auth && !tokenAllowed) return send(401, { error: '未登录' });
  /* v67：之后所有业务接口一律按当前登录用户隔离（会话用户或 API 令牌所属用户） */
  const uid = auth ? auth.userId : tokenUser.userId;
  const isAdmin = !!(auth && auth.user && auth.user.isAdmin);
  const requireAdmin = () => {
    if (!isAdmin) return send(403, { error: '只有管理员能用这个功能' });
    return null;
  };

  /* ---------- v67 多用户：改名、邀请码、用户管理 ---------- */
  /* 自己改用户名：要输当前密码确认，全站唯一，不能重名 */
  if (pathname === '/api/username' && method === 'POST') {
    const body = await jsonBody(request);
    const data = await loadData(db, uid);
    if (!(await verifyPassword(body.password, data.passwordHash))) return send(401, { error: '密码不对' });
    const name = String(body.newUsername || body.username || '').trim();
    if (!validUsername(name)) return send(400, { error: '用户名不对（2–32 位，字母/数字/中文/下划线）' });
    if (name === data.username) return send(200, { ok: true, username: name });
    if (await getUserByUsername(db, name)) return send(400, { error: '这个用户名已经被用了' });
    data.username = name;
    await saveData(db, data);
    return send(200, { ok: true, username: name });
  }
  /* 邀请码列表（仅管理员）：码、创建时间、是否已用、被谁用了（用户名，注销了就显示 id） */
  if (pathname === '/api/invite-codes' && method === 'GET') {
    const denied = requireAdmin();
    if (denied) return denied;
    const rows = (await db.prepare('SELECT * FROM invite_codes ORDER BY createdAt DESC').all()).results || [];
    const users = await listUsers(db);
    const nameById = new Map(users.map((u) => [u.id, u.username]));
    return send(200, {
      codes: rows.map((c) => ({
        code: c.code, createdAt: c.createdAt || '',
        used: !!c.usedBy, usedBy: c.usedBy ? (nameById.get(c.usedBy) || '已注销') : '', usedAt: c.usedAt || ''
      }))
    });
  }
  /* 生成一个邀请码（仅管理员）：HUB-XXXX-XXXX-XXXX，只能用一次 */
  if (pathname === '/api/invite-codes' && method === 'POST') {
    const denied = requireAdmin();
    if (denied) return denied;
    const code = genInviteCode();
    await db.prepare('INSERT INTO invite_codes (code, createdAt, usedBy, usedAt) VALUES (?, ?, ?, ?)')
      .bind(code, cstDateTime(), '', '').run();
    return send(200, { ok: true, code, createdAt: cstDateTime() });
  }
  /* 作废一个未用的邀请码（仅管理员）：已用过的不能作废，留着当记录 */
  const revokeMatch = pathname.match(/^\/api\/invite-codes\/([A-Z0-9-]+)\/revoke$/);
  if (revokeMatch && method === 'POST') {
    const denied = requireAdmin();
    if (denied) return denied;
    const row = await db.prepare('SELECT * FROM invite_codes WHERE code = ?').bind(revokeMatch[1]).first();
    if (!row) return send(404, { error: '找不到这个邀请码' });
    if (row.usedBy) return send(400, { error: '这个邀请码已经用过了，不能作废' });
    await db.prepare('DELETE FROM invite_codes WHERE code = ?').bind(revokeMatch[1]).run();
    return send(200, { ok: true });
  }
  /* 用户列表（仅管理员）：只返回账号信息，绝不返回任何用户的服务数据 */
  if (pathname === '/api/admin/users' && method === 'GET') {
    const denied = requireAdmin();
    if (denied) return denied;
    return send(200, { users: (await listUsers(db)).map(publicUser) });
  }
  /* 管理员直接建用户（不用邀请码；密码留空=自动生成 12 位临时密码，只返回一次，
     初始密码是默认密码，下次登录提示改） */
  if (pathname === '/api/admin/users' && method === 'POST') {
    const denied = requireAdmin();
    if (denied) return denied;
    const body = await jsonBody(request);
    const username = String(body.username || '').trim();
    let password = String(body.password || '');
    let tempPassword = null;
    if (!password) {
      /* 留空=自动生成：无歧义字母数字，12 位 */
      const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      tempPassword = '';
      for (let i = 0; i < 12; i++) tempPassword += chars[Math.floor(Math.random() * chars.length)];
      password = tempPassword;
    }
    if (!validUsername(username)) return send(400, { error: '用户名不对（2–32 位，字母/数字/中文/下划线）' });
    if (password.length < 6) return send(400, { error: '密码至少 6 位' });
    if (await getUserByUsername(db, username)) return send(400, { error: '这个用户名已经被用了' });
    const id = randomBytes(6).toString('hex');
    await db.prepare('INSERT INTO users (id, username, passwordHash, passwordIsDefault, isAdmin, banned, createdAt, lastLoginAt, totpSecret, totpEnabled, apiToken) VALUES (?, ?, ?, 1, 0, 0, ?, ?, ?, 0, ?)')
      .bind(id, username, await hashPassword(password), cstDateTime(), '', '', '').run();
    return send(200, { ok: true, id, username, tempPassword });
  }
  const adminUserMatch = pathname.match(/^\/api\/admin\/users\/([0-9a-f]+)(\/reset-password|\/rename|\/ban|\/unban)?$/);
  if (adminUserMatch) {
    const denied = requireAdmin();
    if (denied) return denied;
    const targetId = adminUserMatch[1];
    const action = adminUserMatch[2] || '';
    const target = await getUserById(db, targetId);
    if (!target) return send(404, { error: '找不到这个用户' });
    /* 删用户：删账号及该用户全部数据（需前端二次确认），不能删自己 */
    if (!action && method === 'DELETE') {
      if (targetId === uid) return send(400, { error: '不能删除自己的账号' });
      await deleteUserData(db, targetId);
      return send(200, { ok: true });
    }
    if (action === '/reset-password' && method === 'POST') {
      /* 重置成一个随机临时密码（只返回一次，管理员转告给用户），
         passwordIsDefault=true，下次登录提示改密码 */
      const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      let tmp = '';
      for (let i = 0; i < 12; i++) tmp += chars[Math.floor(Math.random() * chars.length)];
      await db.prepare('UPDATE users SET passwordHash = ?, passwordIsDefault = 1 WHERE id = ?')
        .bind(await hashPassword(tmp), targetId).run();
      await db.prepare('DELETE FROM sessions WHERE userId = ?').bind(targetId).run();
      return send(200, { ok: true, username: target.username, tempPassword: tmp });
    }
    if (action === '/rename' && method === 'POST') {
      const body = await jsonBody(request);
      const name = String(body.newUsername || body.username || '').trim();
      if (!validUsername(name)) return send(400, { error: '用户名不对（2–32 位，字母/数字/中文/下划线）' });
      if (name !== target.username && (await getUserByUsername(db, name))) return send(400, { error: '这个用户名已经被用了' });
      await db.prepare('UPDATE users SET username = ? WHERE id = ?').bind(name, targetId).run();
      return send(200, { ok: true, username: name });
    }
    if ((action === '/ban' || action === '/unban') && method === 'POST') {
      if (targetId === uid) return send(400, { error: '不能封禁自己的账号' });
      await db.prepare('UPDATE users SET banned = ? WHERE id = ?').bind(action === '/ban' ? 1 : 0, targetId).run();
      /* 封禁后立刻踢掉该用户所有会话；解封不自动恢复会话，得重新登录 */
      if (action === '/ban') await db.prepare('DELETE FROM sessions WHERE userId = ?').bind(targetId).run();
      return send(200, { ok: true, banned: action === '/ban' });
    }
  }

  if (pathname === '/api/api-token/status' && method === 'GET') {
    const data = await loadData(db, uid);
    return send(200, { hasToken: !!data.apiToken });
  }
  if (pathname === '/api/api-token' && method === 'POST') {
    const data = await loadData(db, uid);
    data.apiToken = randomBytes(24).toString('hex');
    await saveData(db, data);
    return send(200, { ok: true, token: data.apiToken });
  }
  if (pathname === '/api/api-token/revoke' && method === 'POST') {
    const data = await loadData(db, uid);
    delete data.apiToken;
    await saveData(db, data);
    return send(200, { ok: true });
  }
  /* v65：共享账号库——账号只存一份，多服务共用。GET 列出；POST 按 action 增删改。
     改库里的密码，所有链接的服务读时跟着变（loadData 里解析）；删库里的账号时，
     链接它的服务保留快照，自动变回本地副本。 */
  if (pathname === '/api/vault' && method === 'GET') {
    const data = await loadData(db, uid);
    return send(200, { accounts: Array.isArray(data.sharedAccounts) ? data.sharedAccounts : [] });
  }
  if (pathname === '/api/vault' && method === 'POST') {
    const body = await jsonBody(request);
    const data = await loadData(db, uid);
    if (!Array.isArray(data.sharedAccounts)) data.sharedAccounts = [];
    const action = String(body.action || '');
    if (action === 'create') {
      const v = sanitizeVaultAccount(body.account || {});
      if (!v) return send(400, { error: '账号内容不对' });
      if (v.password) v.passwordChangedAt = todayStr();
      data.sharedAccounts.push(v);
      await saveData(db, data);
      return send(200, { ok: true, account: v });
    }
    if (action === 'update') {
      const id = String(body.id || '');
      const idx = data.sharedAccounts.findIndex((v) => String(v.id) === id);
      if (idx < 0) return send(404, { error: '找不到这条账号' });
      const old = data.sharedAccounts[idx];
      const v = sanitizeVaultAccount({ ...old, ...(body.account || {}), id });
      if (!v) return send(400, { error: '账号内容不对' });
      /* 密码变了就记今天为上次改密日期；没变沿用旧日期 */
      if (v.password && old.password !== v.password) v.passwordChangedAt = todayStr();
      else if (old.passwordChangedAt && !v.passwordChangedAt) v.passwordChangedAt = old.passwordChangedAt;
      data.sharedAccounts[idx] = v;
      resolveVaultAccounts(data); // 改完立刻把新密码写进各链接服务的快照
      await saveData(db, data);
      return send(200, { ok: true, account: v });
    }
    if (action === 'delete') {
      const id = String(body.id || '');
      const idx = data.sharedAccounts.findIndex((v) => String(v.id) === id);
      if (idx < 0) return send(404, { error: '找不到这条账号' });
      data.sharedAccounts.splice(idx, 1);
      /* 删库账号：链接它的服务保留快照变回本地副本（去掉 sharedId，账号密码不动） */
      for (const s of data.services) {
        for (const a of (Array.isArray(s.accounts) ? s.accounts : [])) {
          if (a.sharedId === id) delete a.sharedId;
        }
        normalizeAccounts(s);
      }
      await saveData(db, data);
      return send(200, { ok: true });
    }
    return send(400, { error: 'action 不对（create/update/delete）' });
  }
  /* v65：最近登录——最近 10 条（时间、IP、设备），登录接口不返回历史 */
  if (pathname === '/api/login-history' && method === 'GET') {
    const data = await loadData(db, uid);
    const list = (Array.isArray(data.loginHistory) ? data.loginHistory : []).slice(-10).reverse()
      .map((h) => ({ at: h.at || '', ip: h.ip || '', device: parseDevice(h.ua || '') }));
    return send(200, { logins: list });
  }
  /* v65：月度报告——手动生成上月报告（每月 1 号定时也会自动生成） */
  if (pathname === '/api/monthly-report/run' && method === 'POST') {
    const r = await runMonthlyReport(db, uid, true);
    if (!r.ok) return send(500, { error: r.note || '生成失败' });
    if (r.skipped) return send(200, { ok: true, skipped: true, month: r.month });
    return send(200, { ok: true, month: r.month, report: r.report });
  }
  /* v65：到期自动归档——手动跑一次（每天 04:00 UTC 定时也会自动跑） */
  if (pathname === '/api/archive/run' && method === 'POST') {
    const r = await runAutoArchive(db, uid);
    if (!r.ok) return send(500, { error: r.note || '归档失败' });
    return send(200, { ok: true, archived: r.archived || 0, names: r.names || [] });
  }
  /* v67：GitHub 备份是全局的、管理员配——备份里是所有用户的数据，非管理员一律 403 */
  if (pathname === '/api/github-backup/status' && method === 'GET') {
    const denied = requireAdmin();
    if (denied) return denied;
    const data = await loadData(db, uid);
    const gb = data.githubBackup || {};
    return send(200, { configured: !!(gb.token && gb.repo), repo: gb.repo || '', branch: gb.branch || 'main', lastAt: gb.lastAt || '', lastOk: !!gb.lastOk, lastNote: gb.lastNote || '' });
  }
  if (pathname === '/api/github-backup/save' && method === 'POST') {
    const denied = requireAdmin();
    if (denied) return denied;
    const body = await jsonBody(request);
    const data = await loadData(db, uid);
    const gb = data.githubBackup || {};
    const token = String(body.token || '').trim();
    const repo = String(body.repo || '').trim();
    if (repo && !/^[^/\s]+\/[^/\s]+$/.test(repo)) return send(400, { error: '仓库格式不对，填“用户名/仓库名”，比如 jasonssuns-prog/hubmate-data' });
    if (token) gb.token = token;
    if (repo) gb.repo = repo;
    gb.branch = String(body.branch || 'main').trim() || 'main';
    data.githubBackup = gb;
    await saveData(db, data);
    return send(200, { ok: true, configured: !!(gb.token && gb.repo) });
  }
  if (pathname === '/api/github-backup/run' && method === 'POST') {
    const denied = requireAdmin();
    if (denied) return denied;
    const r = await pushGithubBackup(db);
    if (!r) return send(400, { error: '还没配好 Token 或仓库' });
    if (r.skipped) return send(200, { ok: true, skipped: true, note: '数据没变，不用推' });
    if (!r.ok) return send(400, { error: r.note || '备份失败' });
    return send(200, { ok: true });
  }
  if (pathname === '/api/totp/status' && method === 'GET') {
    const data = await loadData(db, uid);
    return send(200, { enabled: !!data.totpEnabled });
  }
  if (pathname === '/api/totp/setup' && method === 'POST') {
    const data = await loadData(db, uid);
    data.totpSecret = base32Encode(randomBytes(20));
    data.totpEnabled = false;
    await saveData(db, data);
    const label = encodeURIComponent(`hubmate:${data.username || 'user'}`);
    const otpauth = `otpauth://totp/${label}?secret=${data.totpSecret}&issuer=hubmate&algorithm=SHA1&digits=6&period=30`;
    return send(200, { ok: true, secret: data.totpSecret, otpauth });
  }
  if (pathname === '/api/totp/enable' && method === 'POST') {
    const body = await jsonBody(request);
    const data = await loadData(db, uid);
    if (!data.totpSecret) return send(400, { error: '先点“生成密钥”' });
    if (!(await verifyTotp(data.totpSecret, body.code))) return send(401, { error: '动态码不对，请对一下手机时间' });
    data.totpEnabled = true;
    await saveData(db, data);
    return send(200, { ok: true });
  }
  if (pathname === '/api/totp/disable' && method === 'POST') {
    const body = await jsonBody(request);
    const data = await loadData(db, uid);
    if (!(await verifyPassword(body.password, data.passwordHash))) return send(401, { error: '密码不对' });
    if (data.totpEnabled && !(await verifyTotp(data.totpSecret, body.code))) return send(401, { error: '动态码不对' });
    delete data.totpSecret;
    data.totpEnabled = false;
    await saveData(db, data);
    return send(200, { ok: true });
  }

  if (pathname === '/api/notes' && method === 'GET') {
    const data = await loadData(db, uid);
    return send(200, (data.notes || []).slice().sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')));
  }
  if (pathname === '/api/notes' && method === 'POST') {
    const data = await loadData(db, uid);
    const b = await jsonBody(request);
    const title = String(b.title || '').trim().slice(0, 100);
    const content = String(b.content || '').trim().slice(0, 20000);
    if (!title && !content) return send(400, { error: '标题和内容不能都空' });
    const now = cstDateTime();
    const note = { id: randomBytes(12).toString('hex'), title, content, createdAt: now, updatedAt: now };
    data.notes = data.notes || [];
    data.notes.unshift(note);
    await saveData(db, data);
    return send(200, note);
  }
  if (pathname.startsWith('/api/notes/') && (method === 'PUT' || method === 'DELETE')) {
    const id = decodeURIComponent(pathname.slice('/api/notes/'.length));
    const data = await loadData(db, uid);
    const note = (data.notes || []).find((n) => n.id === id);
    if (!note) return send(404, { error: '找不到这条记事' });
    if (method === 'DELETE') {
      data.notes = data.notes.filter((n) => n.id !== id);
      await saveData(db, data);
      return send(200, { ok: true });
    }
    const b = await jsonBody(request);
    const title = String(b.title || '').trim().slice(0, 100);
    const content = String(b.content || '').trim().slice(0, 20000);
    if (!title && !content) return send(400, { error: '标题和内容不能都空' });
    note.title = title; note.content = content; note.updatedAt = cstDateTime();
    await saveData(db, data);
    return send(200, note);
  }

  if (pathname === '/api/me' && method === 'GET') {
    const data = await loadData(db, uid);
    return send(200, { username: data.username, isAdmin: !!data.isAdmin });
  }
  if (pathname === '/api/logout' && method === 'POST') {
    await deleteSession(db, auth.token);
    const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
    return send(200, { ok: true }, { 'Set-Cookie': `session=; HttpOnly; Path=/; Max-Age=0${secure}` });
  }
  if (pathname === '/api/password' && method === 'POST') {
    const body = await jsonBody(request);
    const data = await loadData(db, uid);
    if (!(await verifyPassword(body.oldPassword, data.passwordHash))) return send(400, { error: '旧密码不对' });
    if (!body.newPassword || String(body.newPassword).length < 6) return send(400, { error: '新密码至少 6 位' });
    data.passwordHash = await hashPassword(body.newPassword);
    data.passwordIsDefault = false;
    await saveData(db, data);
    return send(200, { ok: true });
  }
  if (pathname === '/api/notify' && method === 'GET') {
    const n = notifyCfg(await loadData(db, uid));
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
  if (pathname === '/api/notify' && method === 'POST') {
    const body = await jsonBody(request);
    const data = await loadData(db, uid);
    const n = notifyCfg(data);
    if (typeof body.token === 'string' && body.token.trim()) n.token = body.token.trim().slice(0, 200);
    if (typeof body.chatId === 'string' && body.chatId.trim()) n.chatId = body.chatId.trim().slice(0, 64);
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
    await saveData(db, data);
    return send(200, { ok: true, configured: !!(n.token && n.chatId) });
  }
  if (pathname === '/api/notify/test' && method === 'POST') {
    const data = await loadData(db, uid);
    const n = notifyCfg(data);
    const hasAny = (n.token && n.chatId) || n.webhookUrl || n.barkKey || n.serverChanKey;
    if (!hasAny) return send(400, { error: '还没设置任何通知渠道（Telegram / Webhook / Bark / Server酱）' });
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
    const html = `✅ <b>服务台通知测试成功</b> · ${t}\n今日签到 ${done}/${cohort.length} · 30 天内临期 ${items.length} 个\n\n${expPreview}\n\n${ckPreview}\n\n上面就是每天早上会收到的提醒版式。${todo.length ? '（Telegram 下面这个按钮是真的，点一下就签完了。）' : ''}`;
    const r = await sendMultiChannel(n, `服务台通知测试 · ${t}`, html, todo.length ? CHECKIN_KB : undefined);
    if (!r.ok) return send(400, { error: '全部渠道都发送失败', channels: r.results });
    return send(200, { ok: true, channels: r.results });
  }
  if (pathname === '/api/linkcheck' && method === 'POST') {
    const r = await checkLinks(db, uid);
    if (!r) return send(400, { error: '检测失败' });
    return send(200, r);
  }
  if (pathname === '/api/auto-signin/run' && method === 'POST') {
    const r = await runAutoSignins(db, uid);
    if (!r) return send(400, { error: '自动签到失败' });
    return send(200, { ok: true, results: r });
  }
  if (pathname === '/api/auto-signin/test' && method === 'POST') {
    const body = await jsonBody(request);
    const cfg = sanitizeAutoSignin(body.autoSignin || body);
    if (!cfg) return send(400, { error: '自动签到没配好：网址要是 http(s) 开头' });
    const r = await tryAutoSignin(null, cfg);
    return send(200, { ok: r.ok, status: r.status, note: r.note || '' });
  }
  if (pathname === '/api/categories' && method === 'POST') {
    const body = await jsonBody(request);
    const data = await loadData(db, uid);
    const cats = ensureCategories(data);
    const label = String(body.label || '').trim().slice(0, 20);
    if (!label) return send(400, { error: '分类名不能为空' });
    if (cats.some((c) => c.label.toLowerCase() === label.toLowerCase())) return send(400, { error: '已经有同名分类了' });
    const cat = { id: 'c' + randomBytes(4).toString('hex'), label, icon: cleanIcon(body.icon), cls: 't-custom' };
    cats.push(cat);
    await saveData(db, data);
    return send(200, { ok: true, category: cat });
  }
  const cm = pathname.match(/^\/api\/categories\/([A-Za-z0-9_-]+)$/);
  if (cm && method === 'PUT') {
    const body = await jsonBody(request);
    const data = await loadData(db, uid);
    const cats = ensureCategories(data);
    const cat = cats.find((c) => c.id === cm[1]);
    if (!cat) return send(404, { error: '找不到该分类' });
    const label = String(body.label || '').trim().slice(0, 20);
    if (!label) return send(400, { error: '分类名不能为空' });
    if (cats.some((c) => c.id !== cat.id && c.label.toLowerCase() === label.toLowerCase())) return send(400, { error: '已经有同名分类了' });
    cat.label = label;
    if (body.icon !== undefined) cat.icon = cleanIcon(body.icon);
    await saveData(db, data);
    return send(200, { ok: true, category: cat });
  }
  if (cm && method === 'DELETE') {
    if (BUILTIN_CATS.has(cm[1])) return send(400, { error: '系统分类不能删除' });
    const data = await loadData(db, uid);
    const cats = ensureCategories(data);
    const idx = cats.findIndex((c) => c.id === cm[1]);
    if (idx < 0) return send(404, { error: '找不到该分类' });
    const used = data.services.filter((s) => s.category === cm[1]).length;
    if (used) return send(400, { error: `该分类下还有 ${used} 个服务，请先把它们编辑到其他分类后再删除` });
    cats.splice(idx, 1);
    await saveData(db, data);
    return send(200, { ok: true });
  }
  if (pathname === '/api/notify/resolve' && method === 'POST') {
    const data = await loadData(db, uid);
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
      await saveData(db, data);
      return send(200, { ok: true, chatId: n.chatId });
    } catch (e) { return send(400, { error: `获取失败：${e.message}` }); }
  }
  /* 导出台账：Workers 没有磁盘，直接把 Markdown 当文件下载返回 */
  if (pathname === '/api/export-md' && method === 'POST') {
    const data = await loadData(db, uid);
    const md = ledgerMarkdown(data, new URL(request.url).origin);
    return new Response(md, {
      status: 200,
      headers: Object.assign({
        'Content-Type': 'text/markdown; charset=utf-8',
        /* filename 含中文会触发 Fetch 规范的 TypeError；用 RFC 5987 的 filename*（UTF-8 百分号编码）+ ASCII 兜底 */
        'Content-Disposition': `attachment; filename="ledger.md"; filename*=UTF-8''${encodeURIComponent('服务台账.md')}`,
        'Cache-Control': 'no-store'
      }, SEC_HEADERS)
    });
  }
  /* v67：备份下载是整份数据（所有用户），只有管理员能下 */
  if (pathname === '/api/backup' && method === 'GET') {
    const denied = requireAdmin();
    if (denied) return denied;
    const all = await loadAllData(db);
    const out = strippedBackupDataV2(all);
    const fname = `service-hub-backup-${todayStr()}.json`;
    return new Response(JSON.stringify(out, null, 2), {
      status: 200,
      headers: Object.assign({
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${fname}"`,
        'Cache-Control': 'no-store'
      }, SEC_HEADERS)
    });
  }
  /* v67：恢复也只有管理员能做。v2 备份按用户归属恢复（users/invite_codes 不动，
     只恢复库里已存在用户的业务数据）；v1 旧备份（顶层就是 services）恢复进
     当前管理员自己的数据。恢复前先把当前整份数据存一份到 backups 表（只留最近 5 份）。 */
  if (pathname === '/api/backup' && method === 'POST') {
    const denied = requireAdmin();
    if (denied) return denied;
    const body = await jsonBody(request);
    const imp = body && body.data ? body.data : body;
    const isV2 = imp && imp.version === 2 && imp.userData && typeof imp.userData === 'object';
    if (!isV2 && (!imp || !Array.isArray(imp.services))) return send(400, { error: '备份文件不对：里面没有服务列表' });
    if (!isV2) {
      for (const s of imp.services) {
        if (!s || typeof s.id !== 'string' || typeof s.name !== 'string' || !s.name.trim()) {
          return send(400, { error: '备份文件不对：有服务缺名字或编号' });
        }
      }
    }
    const allBefore = await loadAllData(db);
    await db.prepare('INSERT INTO backups (createdAt, data) VALUES (?, ?)')
      .bind(cstDateTime(), JSON.stringify(strippedBackupDataV2(allBefore))).run();
    await db.prepare('DELETE FROM backups WHERE id NOT IN (SELECT id FROM backups ORDER BY id DESC LIMIT 5)').run();
    if (isV2) {
      let restored = 0;
      for (const [uid2, ud] of Object.entries(imp.userData)) {
        if (!ud || !Array.isArray(ud.services)) continue;
        const user = await getUserById(db, uid2);
        if (!user) continue; /* 备份里有、库里没有的用户跳过，不新建账号 */
        const data = await loadData(db, uid2);
        restoreUserData(data, ud);
        await saveData(db, data);
        restored += data.services.length;
      }
      return send(200, { ok: true, services: restored });
    }
    const data = await loadData(db, uid);
    restoreUserData(data, imp);
    await saveData(db, data);
    return send(200, { ok: true, services: data.services.length });
  }
  if (pathname === '/api/meta' && method === 'GET') {
    const data = await loadData(db, uid);
    const unlocked = syncAchievements(data);
    if (unlocked.length) await saveData(db, data);
    return send(200, metaPayload(data));
  }

  if (pathname === '/api/services' && method === 'GET') {
    return send(200, (await loadData(db, uid)).services);
  }
  if (pathname === '/api/services' && method === 'POST') {
    const data = await loadData(db, uid);
    const f = pickFields(await jsonBody(request), null, categoriesOf(data).map((c) => c.id));
    if (!f.name) return send(400, { error: '名称必填' });
    const svc = Object.assign({
      id: randomBytes(12).toString('hex'),
      category: 'relay',
      url: '', account: '', secret: '', price: '', notes: '',
      registeredAt: todayStr(), expiresAt: '',
      checkinFrequency: 'none', checkinEveryDays: 1, renewDays: 365, checkins: [],
      visits: 0,
      sortOrder: Math.min(0, ...data.services.map((s) => s.sortOrder ?? 0)) - 1
    }, f);
    data.services.push(svc);
    data.xp += 10;
    const unlocked = syncAchievements(data);
    await saveData(db, data);
    return send(200, { ...svc, xpGained: 10, unlocked });
  }

  if (pathname === '/api/services/import' && method === 'POST') {
    const body = await jsonBody(request);
    const rows = Array.isArray(body.services) ? body.services : [];
    if (!rows.length) return send(400, { error: '没有可导入的服务' });
    if (rows.length > 500) return send(400, { error: '一次最多导入 500 个' });
    const data = await loadData(db, uid);
    const catIds = categoriesOf(data).map((c) => c.id);
    let maxOrder = data.services.reduce((m, s) => Math.max(m, s.sortOrder ?? 0), 0);
    let imported = 0;
    for (const r of rows) {
      const f = pickFields(r || {}, null, catIds);
      if (!f.name) continue;
      const svc = Object.assign({
        id: randomBytes(12).toString('hex'),
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
      await saveData(db, data);
    }
    return send(200, { ok: true, imported, skipped: rows.length - imported });
  }

  if (pathname === '/api/services/import-bookmarks' && method === 'POST') {
    const body = await jsonBody(request);
    const rows = Array.isArray(body.services) ? body.services : [];
    if (!rows.length) return send(400, { error: '没有可导入的书签' });
    if (rows.length > 500) return send(400, { error: '一次最多导入 500 个' });
    const normUrl = (u) => String(u || '').trim().toLowerCase().replace(/\/+$/, '');
    const data = await loadData(db, uid);
    const catIds = categoriesOf(data).map((c) => c.id);
    const seenUrls = new Set(data.services.map((s) => normUrl(s.url)).filter(Boolean));
    let maxOrder = data.services.reduce((m, s) => Math.max(m, s.sortOrder ?? 0), 0);
    let imported = 0, dupes = 0;
    for (const r of rows) {
      const f = pickFields(r || {}, null, catIds);
      if (!f.name) continue;
      const nu = normUrl(f.url);
      if (nu && seenUrls.has(nu)) { dupes++; continue; }
      const svc = Object.assign({
        id: randomBytes(12).toString('hex'),
        category: 'relay',
        url: '', account: '', secret: '', price: '', notes: '',
        registeredAt: todayStr(), expiresAt: '',
        checkinFrequency: 'none', checkinEveryDays: 1, renewDays: 365, checkins: [],
        visits: 0,
        sortOrder: ++maxOrder
      }, f);
      data.services.push(svc);
      if (nu) seenUrls.add(nu);
      imported++;
    }
    if (imported) {
      syncAchievements(data);
      await saveData(db, data);
    }
    return send(200, { ok: true, imported, skipped: rows.length - imported - dupes, dupes });
  }

  if (pathname === '/api/services/import-accounts' && method === 'POST') {
    const body = await jsonBody(request);
    const rows = Array.isArray(body.accounts) ? body.accounts : [];
    if (!rows.length) return send(400, { error: '没有可导入的账号' });
    if (rows.length > 500) return send(400, { error: '一次最多导入 500 个' });
    const data = await loadData(db, uid);
    const byName = new Map();
    for (const s of data.services) {
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
      normalizeAccounts(svc);
      if (svc.accounts.some((a) => String(a.username || '').trim().toLowerCase() === acc.username.toLowerCase())) { dupes++; continue; }
      acc.isDefault = svc.accounts.length === 0;
      svc.accounts.push(acc);
      normalizeAccounts(svc);
      imported++;
    }
    if (imported) await saveData(db, data);
    return send(200, { ok: true, imported, skipped: rows.length - imported - dupes - missingRows, dupes, missing });
  }
  if (pathname === '/api/reorder' && method === 'POST') {
    const body = await jsonBody(request);
    if (!Array.isArray(body.ids)) return send(400, { error: '参数错误' });
    const data = await loadData(db, uid);
    const pos = new Map(body.ids.map((x, i) => [String(x), i]));
    data.services.forEach((s) => { if (pos.has(s.id)) s.sortOrder = pos.get(s.id); });
    await saveData(db, data);
    return send(200, { ok: true });
  }
  if (pathname === '/api/checkins/all' && method === 'POST') {
    const data = await loadData(db, uid);
    const r = checkinAllTodayNoWrite(data);
    await saveData(db, data);
    return send(200, r);
  }
  if (pathname === '/api/services/bulk' && method === 'POST') {
    const body = await jsonBody(request);
    const data = await loadData(db, uid);
    const ids = new Set((Array.isArray(body.ids) ? body.ids : []).map(String));
    if (!ids.size) return send(400, { error: '没有选中服务' });
    if (body.action === 'delete') {
      const before = data.services.length;
      data.services = data.services.filter((s) => !ids.has(s.id));
      await saveData(db, data);
      return send(200, { ok: true, deleted: before - data.services.length });
    }
    if (body.action === 'category') {
      const catIds = categoriesOf(data).map((c) => c.id);
      const cat = catIds.includes(body.category) ? body.category : 'relay';
      let moved = 0;
      for (const s of data.services) {
        if (!ids.has(s.id)) continue;
        if (cat === 'fav' && s.category !== 'fav') s.favorite = true;
        s.category = cat;
        moved++;
      }
      await saveData(db, data);
      return send(200, { ok: true, moved });
    }
    if (body.action === 'edit') {
      const every = (body.checkinEveryDays === '' || body.checkinEveryDays == null) ? null : clampInt(body.checkinEveryDays, 1, 365, null);
      const renew = (body.renewDays === '' || body.renewDays == null) ? null : clampInt(body.renewDays, 1, 3650, null);
      if (every === null && renew === null) return send(400, { error: '没填要改的内容' });
      let updated = 0;
      for (const s of data.services) {
        if (!ids.has(s.id)) continue;
        if (every !== null) s.checkinEveryDays = every;
        if (renew !== null) s.renewDays = renew;
        updated++;
      }
      await saveData(db, data);
      return send(200, { ok: true, updated });
    }
    return send(400, { error: '未知操作' });
  }

  const m = pathname.match(/^\/api\/services\/([0-9a-f]+)(\/checkin|\/uncheckin|\/checkin-account|\/uncheckin-account|\/visit|\/undo-renew|\/renew|\/move|\/duplicate)?$/);
  if (m) {
    const data = await loadData(db, uid);
    const idx = data.services.findIndex((s) => s.id === m[1]);
    if (idx < 0) return send(404, { error: '找不到该服务' });
    const svc = data.services[idx];
    const t = todayStr();
    if (method === 'POST' && m[2] === '/visit') {
      svc.visits = (svc.visits || 0) + 1;
      await saveData(db, data);
      return send(200, { ok: true, visits: svc.visits });
    }
    if (method === 'POST' && m[2] === '/checkin') {
      let xpGained = 0;
      const accs = serviceAccounts(svc);
      if (accs.length) {
        for (const a of accs) xpGained += doCheckinAccount(data, svc, a, t);
      } else {
        xpGained = doCheckin(data, svc, t);
      }
      const { allDone, bonus } = allDoneBonus(data, t);
      xpGained += bonus;
      data.xp += xpGained;
      const unlocked = syncAchievements(data);
      await saveData(db, data);
      return send(200, {
        ok: true, checkins: svc.checkins, accounts: svc.accounts, xpGained, allDone,
        unlocked, xp: data.xp, level: levelOf(data.xp)
      });
    }
    if (method === 'POST' && m[2] === '/checkin-account') {
      const body = await jsonBody(request);
      const acc = serviceAccounts(svc).find((a) => a.id === String(body.accountId || ''));
      if (!acc) return send(404, { error: '找不到该账号' });
      let xpGained = doCheckinAccount(data, svc, acc, t);
      const { allDone, bonus } = allDoneBonus(data, t);
      xpGained += bonus;
      data.xp += xpGained;
      const unlocked = syncAchievements(data);
      await saveData(db, data);
      return send(200, {
        ok: true, checkins: svc.checkins, accounts: svc.accounts, xpGained, allDone,
        unlocked, xp: data.xp, level: levelOf(data.xp)
      });
    }
    if (method === 'POST' && m[2] === '/uncheckin-account') {
      const body = await jsonBody(request);
      const acc = serviceAccounts(svc).find((a) => a.id === String(body.accountId || ''));
      if (!acc) return send(404, { error: '找不到该账号' });
      doUncheckinAccount(data, svc, acc, t);
      await saveData(db, data);
      return send(200, { ok: true, checkins: svc.checkins, accounts: svc.accounts });
    }
    if (method === 'POST' && m[2] === '/renew') {
      /* v66：续期一律从今天起算——提前续期不保留剩余天数（新到期日 = 今天 + 续期周期，
         注册/购买日期也设为今天，新周期从今天开始）。已过期的服务本来就是从今天起算，
         结果不变。快照和续期记录照常记，撤回续期照常恢复两个日期。 */
      const days = renewEvery(svc);
      svc.prevRenew = { expiresAt: svc.expiresAt || '', registeredAt: svc.registeredAt || '' };
      delete svc.prevExpiresAt;
      svc.renewHistory = (Array.isArray(svc.renewHistory) ? svc.renewHistory : []).filter((h) => h && /^\d{4}-\d{2}-\d{2}$/.test(h.at || ''));
      const newExpires = renewDates(t, days).expiresAt;
      svc.renewHistory.push({ at: t, from: svc.expiresAt || '', to: newExpires });
      if (svc.renewHistory.length > 20) svc.renewHistory = svc.renewHistory.slice(-20);
      svc.registeredAt = t;
      svc.expiresAt = newExpires;
      await saveData(db, data);
      return send(200, { ok: true, expiresAt: svc.expiresAt });
    }
    if (method === 'POST' && m[2] === '/undo-renew') {
      const snap = svc.prevRenew || (svc.prevExpiresAt ? { expiresAt: svc.prevExpiresAt, registeredAt: svc.registeredAt } : null);
      if (!snap) return send(400, { error: '没有可撤回的续期' });
      if (Array.isArray(svc.renewHistory) && svc.renewHistory.length) {
        const last = svc.renewHistory[svc.renewHistory.length - 1];
        if (last && last.to === svc.expiresAt) svc.renewHistory.pop();
      }
      svc.expiresAt = snap.expiresAt || '';
      if (typeof snap.registeredAt === 'string') svc.registeredAt = snap.registeredAt;
      delete svc.prevRenew;
      delete svc.prevExpiresAt;
      await saveData(db, data);
      return send(200, { ok: true, expiresAt: svc.expiresAt });
    }
    if (method === 'POST' && m[2] === '/move') {
      const body = await jsonBody(request);
      const dir = body.dir === 'down' ? 1 : -1;
      const group = data.services.filter((s) => s.category === svc.category).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
      const i = group.findIndex((s) => s.id === svc.id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= group.length) return send(200, { ok: true, moved: false });
      const tmp = group[i].sortOrder; group[i].sortOrder = group[j].sortOrder; group[j].sortOrder = tmp;
      await saveData(db, data);
      return send(200, { ok: true, moved: true });
    }
    if (method === 'POST' && m[2] === '/duplicate') {
      const maxOrder = data.services.filter((s) => s.category === svc.category).reduce((n, s) => Math.max(n, s.sortOrder ?? 0), 0);
      const copy = {
        ...svc,
        id: randomBytes(6).toString('hex'),
        name: (svc.name || '服务').slice(0, 96) + ' 副本',
        checkins: [],
        visits: 0,
        sortOrder: maxOrder + 1,
        linkStatus: undefined,
        linkCheckedAt: undefined,
        renewHistory: [],
        prevRenew: undefined,
        prevExpiresAt: undefined,
        accounts: (Array.isArray(svc.accounts) ? svc.accounts : []).map((a) => ({ ...sanitizeAccount(a), id: randomBytes(6).toString('hex'), checkins: [] }))
      };
      copy.account = copy.accounts.find((a) => a.isDefault)?.username || '';
      copy.secret = copy.accounts.find((a) => a.isDefault)?.password || '';
      data.services.push(copy);
      await saveData(db, data);
      return send(200, copy);
    }
    if (method === 'POST' && m[2] === '/uncheckin') {
      const accs = serviceAccounts(svc);
      if (accs.length) {
        for (const a of accs) a.checkins = accountCheckins(a).filter((d) => d !== t);
      }
      svc.checkins = svc.checkins.filter((d) => d !== t);
      if (data.history[t]) data.history[t].c = Math.max(0, (data.history[t].c || 1) - 1);
      await saveData(db, data);
      return send(200, { ok: true, checkins: svc.checkins, accounts: svc.accounts });
    }
    if (method === 'PUT' && !m[2]) {
      const body = await jsonBody(request);
      Object.assign(svc, pickFields(body, svc, categoriesOf(data).map((c) => c.id)));
      if (typeof body.expiresAt === 'string' || typeof body.registeredAt === 'string') { delete svc.prevRenew; delete svc.prevExpiresAt; }
      await saveData(db, data);
      return send(200, svc);
    }
    if (method === 'DELETE' && !m[2]) {
      data.services.splice(idx, 1);
      await saveData(db, data);
      return send(200, { ok: true });
    }
  }
  return send(404, { error: '接口不存在' });
}

/* ---------- Worker 入口 ---------- */
export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const { pathname } = url;
      if (pathname.startsWith('/api/')) {
        return await handleAPI(request, env, pathname);
      }
      /* 其余请求由 Workers Static Assets 处理；走到这里说明没有匹配的静态文件 */
      return new Response('404 Not Found', {
        status: 404,
        headers: Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, SEC_HEADERS)
      });
    } catch (e) {
      console.error('[!] 请求处理异常:', e);
      try { return jsonResponse(500, { error: '服务器错误' }); } catch { return new Response('服务器错误', { status: 500 }); }
    }
  },

  /* 定时任务：按 wrangler.toml 里的 Cron 表达式分发（每分钟 TG 轮询、每小时提醒+
     自动签到、每 6 小时死链检测、每天 04:00 UTC GitHub 备份；v65：每月 1 号生成月度
     报告、每天自动归档过期服务） */
  /* v67：定时任务按用户循环跑——每个用户用自己的通知配置（Telegram/webhook/
     Bark/Server酱）、自己的服务列表做提醒、自动签到、死链检测、月度报告和
     自动归档；GitHub 备份是全局的，只跑一次（所有用户的数据都在备份里）。 */
  async scheduled(event, env, ctx) {
    const db = env.DB;
    try {
      const users = await listUsers(db).catch(() => []);
      const ids = users.map((u) => u.id);
      if (event.cron === '* * * * *') {
        ctx.waitUntil((async () => { for (const id of ids) await pollBotCommands(db, id); })());
      } else if (event.cron === '0 * * * *') {
        ctx.waitUntil((async () => {
          for (const id of ids) {
            await runNotifyChecks(db, id);
            await runAutoSignins(db, id);
          }
          /* v65：每月 1 号（北京时间）生成上月报告并推送；runMonthlyReport 自己判断
             上月报告是否已生成，没生成才推，已生成就直接跳过 */
          if (todayStr().endsWith('-01')) {
            for (const id of ids) await runMonthlyReport(db, id);
          }
        })());
      } else if (event.cron === '0 */6 * * *') {
        ctx.waitUntil((async () => { for (const id of ids) await checkLinks(db, id); })());
      } else if (event.cron === '0 4 * * *') {
        ctx.waitUntil((async () => {
          await pushGithubBackup(db);
          for (const id of ids) await runAutoArchive(db, id);
        })());
      }
    } catch (e) {
      console.error('[!] 定时任务异常:', e.message);
    }
  }
};
