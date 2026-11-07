var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/worker.js
import { randomBytes, createHash } from "node:crypto";
import { Buffer as Buffer2 } from "node:buffer";
var SESSION_MS = 30 * 86400 * 1e3;
var SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS services (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', content TEXT NOT NULL DEFAULT '', createdAt TEXT NOT NULL DEFAULT '', updatedAt TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS captchas (id TEXT PRIMARY KEY, code TEXT NOT NULL, expiresAt INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS login_throttle (ip TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0, resetAt INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS backups (id INTEGER PRIMARY KEY AUTOINCREMENT, createdAt TEXT NOT NULL, data TEXT NOT NULL);
`;
var schemaPromise = null;
function ensureSchema(db) {
  if (!schemaPromise) {
    schemaPromise = db.exec(SCHEMA_SQL).catch((e) => {
      schemaPromise = null;
      throw e;
    });
  }
  return schemaPromise;
}
__name(ensureSchema, "ensureSchema");
var DEFAULT_CATEGORIES = [
  { id: "fav", label: "\u6536\u85CF", icon: "\u2605", cls: "t-fav" },
  { id: "checkin", label: "\u6BCF\u65E5\u7B7E\u5230", icon: "\u{1F4C5}", cls: "t-checkin" },
  { id: "relay", label: "\u4E2D\u8F6C\u7AD9/API", icon: "\u{1F500}", cls: "t-relay" },
  { id: "vps", label: "VPS/\u670D\u52A1\u5668", icon: "\u{1F5A5}\uFE0F", cls: "t-vps" },
  { id: "game", label: "\u6E38\u620F", icon: "\u{1F3AE}", cls: "t-game" },
  { id: "domain", label: "\u57DF\u540D/\u8BA2\u9605", icon: "\u{1F310}", cls: "t-domain" },
  { id: "idle", label: "\u5DF2\u95F2\u7F6E", icon: "\u{1F9DF}", cls: "t-idle" }
];
var BUILTIN_CATS = new Set(DEFAULT_CATEGORIES.map((c) => c.id));
function categoriesOf(data) {
  if (Array.isArray(data.categories) && data.categories.length) return data.categories;
  return DEFAULT_CATEGORIES;
}
__name(categoriesOf, "categoriesOf");
function ensureCategories(data) {
  if (!Array.isArray(data.categories) || !data.categories.length) {
    data.categories = DEFAULT_CATEGORIES.map((c) => ({ ...c }));
  }
  return data.categories;
}
__name(ensureCategories, "ensureCategories");
function normCat(c) {
  return { id: c.id, label: c.label, icon: c.icon || "\u{1F3F7}\uFE0F", cls: c.cls || "t-custom" };
}
__name(normCat, "normCat");
function cleanIcon(v) {
  return [...String(v || "")].slice(0, 2).join("").trim() || "\u{1F3F7}\uFE0F";
}
__name(cleanIcon, "cleanIcon");
var SEC_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Cross-Origin-Opener-Policy": "same-origin"
};
function cstNow() {
  return new Date(Date.now() + 8 * 36e5);
}
__name(cstNow, "cstNow");
function cstHour() {
  return cstNow().getUTCHours();
}
__name(cstHour, "cstHour");
function todayStr() {
  const d = cstNow();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
__name(todayStr, "todayStr");
function cstDateTime() {
  const d = cstNow();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}
__name(cstDateTime, "cstDateTime");
function nextDay(ds) {
  const [y, m, d] = ds.split("-").map(Number);
  const dt = new Date(y, m - 1, d + 1);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}
__name(nextDay, "nextDay");
function safeJSON(s, fallback) {
  try {
    const v = JSON.parse(s);
    return v === void 0 ? fallback : v;
  } catch {
    return fallback;
  }
}
__name(safeJSON, "safeJSON");
function hex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(hex, "hex");
function unhex(s) {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
__name(unhex, "unhex");
function parseCookies(header) {
  const out = {};
  String(header || "").split(";").forEach((p) => {
    const i = p.indexOf("=");
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
__name(parseCookies, "parseCookies");
function jsonResponse(status, obj, extraHeaders) {
  const h = Object.assign({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  }, SEC_HEADERS, extraHeaders || {});
  return new Response(JSON.stringify(obj), { status, headers: h });
}
__name(jsonResponse, "jsonResponse");
function clientIp(request) {
  return request.headers.get("cf-connecting-ip") || "?";
}
__name(clientIp, "clientIp");
var PBKDF2_ITER = 1e5;
async function hashPassword(pw) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(String(pw)), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: PBKDF2_ITER, hash: "SHA-256" }, key, 256);
  return `pbkdf2:${hex(salt)}:${hex(bits)}`;
}
__name(hashPassword, "hashPassword");
async function verifyPassword(pw, stored) {
  try {
    const parts = String(stored).split(":");
    if (parts.length !== 3 || parts[0] !== "pbkdf2") return false;
    const salt = unhex(parts[1]);
    const want = unhex(parts[2]);
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(String(pw)), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: PBKDF2_ITER, hash: "SHA-256" }, key, 256);
    const got = new Uint8Array(bits);
    if (got.length !== want.length) return false;
    let diff = 0;
    for (let i = 0; i < got.length; i++) diff |= got[i] ^ want[i];
    return diff === 0;
  } catch {
    return false;
  }
}
__name(verifyPassword, "verifyPassword");
var TOTP_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32Encode(buf) {
  let out = "", bits = 0, val = 0;
  for (const b of buf) {
    val = val << 8 | b;
    bits += 8;
    while (bits >= 5) {
      out += TOTP_ALPHABET[val >>> bits - 5 & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += TOTP_ALPHABET[val << 5 - bits & 31];
  return out;
}
__name(base32Encode, "base32Encode");
function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[^A-Z2-7]/g, "");
  const bytes = [];
  let bits = 0, val = 0;
  for (const ch of clean) {
    val = val << 5 | TOTP_ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bytes.push(val >>> bits - 8 & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(bytes);
}
__name(base32Decode, "base32Decode");
async function totpCode(secret, step) {
  const key = await crypto.subtle.importKey("raw", base32Decode(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const msg = new Uint8Array(8);
  new DataView(msg.buffer).setBigUint64(0, BigInt(step));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const off = sig[sig.length - 1] & 15;
  const code = (sig[off] & 127) << 24 | (sig[off + 1] & 255) << 16 | (sig[off + 2] & 255) << 8 | sig[off + 3] & 255;
  return String(code % 1e6).padStart(6, "0");
}
__name(totpCode, "totpCode");
async function verifyTotp(secret, code) {
  if (!secret || !/^\d{6}$/.test(String(code || ""))) return false;
  const step = Math.floor(Date.now() / 3e4);
  for (const s of [step - 1, step, step + 1]) {
    if (await totpCode(secret, s) === String(code)) return true;
  }
  return false;
}
__name(verifyTotp, "verifyTotp");
async function makeCaptcha(db) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  const colors = ["#1e3a8a", "#7c2d12", "#14532d", "#581c87", "#991b1b"];
  const texts = [...code].map((ch, i) => {
    const x = 18 + i * 28, y = 28 + Math.floor(Math.random() * 8 - 4);
    const r = Math.floor(Math.random() * 36 - 18);
    return `<text x="${x}" y="${y}" font-size="26" font-weight="700" font-family="Arial, sans-serif" fill="${colors[Math.floor(Math.random() * colors.length)]}" transform="rotate(${r} ${x} ${y})">${ch}</text>`;
  }).join("");
  const lines = [0, 1, 2].map(() => {
    const y1 = Math.floor(Math.random() * 44), y2 = Math.floor(Math.random() * 44);
    return `<line x1="0" y1="${y1}" x2="130" y2="${y2}" stroke="#a5b4fc" stroke-width="1" opacity="0.7"/>`;
  }).join("");
  const dots = Array.from({ length: 24 }, () => `<circle cx="${Math.floor(Math.random() * 130)}" cy="${Math.floor(Math.random() * 44)}" r="1.2" fill="#c7d2fe"/>`).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="130" height="44" viewBox="0 0 130 44"><rect width="130" height="44" fill="#ede9fe"/>${lines}${dots}${texts}</svg>`;
  const id = randomBytes(12).toString("hex");
  await db.prepare("INSERT INTO captchas (id, code, expiresAt) VALUES (?, ?, ?)").bind(id, code, Date.now() + 5 * 6e4).run();
  await db.prepare("DELETE FROM captchas WHERE expiresAt < ?").bind(Date.now()).run();
  return { id, svg };
}
__name(makeCaptcha, "makeCaptcha");
async function verifyCaptcha(db, id, answer) {
  if (!id || !answer) return false;
  const row = await db.prepare("SELECT code, expiresAt FROM captchas WHERE id = ?").bind(id).first();
  await db.prepare("DELETE FROM captchas WHERE id = ?").bind(id).run();
  if (!row || Date.now() > row.expiresAt) return false;
  return String(answer).trim().toUpperCase() === row.code;
}
__name(verifyCaptcha, "verifyCaptcha");
async function loginThrottled(db, ip) {
  const now = Date.now();
  const row = await db.prepare("SELECT count, resetAt FROM login_throttle WHERE ip = ?").bind(ip).first();
  let count = 1, resetAt = now + 10 * 6e4;
  if (row && now <= row.resetAt) {
    count = row.count + 1;
    resetAt = row.resetAt;
  }
  await db.prepare("INSERT OR REPLACE INTO login_throttle (ip, count, resetAt) VALUES (?, ?, ?)").bind(ip, count, resetAt).run();
  return count > 10;
}
__name(loginThrottled, "loginThrottled");
var LEVELS = [
  { xp: 0, t: "\u521D\u51FA\u8305\u5E90" },
  { xp: 25, t: "\u7B7E\u5230\u5B66\u5F92" },
  { xp: 60, t: "\u52E4\u594B\u6253\u5DE5\u4EBA" },
  { xp: 120, t: "\u767D\u5AD6\u8FBE\u4EBA" },
  { xp: 200, t: "\u8D44\u4EA7\u7BA1\u5BB6" },
  { xp: 320, t: "\u7F8A\u6BDB\u5927\u5E08" },
  { xp: 480, t: "\u8D44\u672C\u65B0\u8D35" },
  { xp: 700, t: "\u7B7E\u5230\u4ED9\u4EBA" },
  { xp: 1e3, t: "\u8D44\u4EA7\u7BA1\u7406\u5927\u4EA8" },
  { xp: 1500, t: "\u4F20\u8BF4\u7BA1\u7406\u4EBA" }
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
    progress: next ? Math.min(100, Math.round((xp - LEVELS[i].xp) / (next.xp - LEVELS[i].xp) * 100)) : 100
  };
}
__name(levelOf, "levelOf");
var ACH_DEFS = [
  { id: "first", icon: "\u{1F389}", name: "\u521D\u6B21\u7B7E\u5230", desc: "\u5B8C\u6210\u4EBA\u751F\u7B2C\u4E00\u6B21\u7B7E\u5230" },
  { id: "all1", icon: "\u2705", name: "\u5355\u65E5\u5168\u52E4", desc: "\u4E00\u5929\u5185\u7B7E\u5B8C\u6240\u6709\u6BCF\u65E5\u7B7E\u5230\u670D\u52A1" },
  { id: "week", icon: "\u{1F4C5}", name: "\u5B8C\u7F8E\u4E00\u5468", desc: "\u8FDE\u7EED 7 \u5929\u5929\u5929\u5168\u52E4" },
  { id: "s7", icon: "\u{1F525}", name: "\u4E03\u65E5\u8FDE\u7B7E", desc: "\u5355\u4E2A\u670D\u52A1\u8FDE\u7EED\u7B7E\u5230 7 \u5929" },
  { id: "s30", icon: "\u26A1", name: "\u4E09\u5341\u8FDE\u7B7E", desc: "\u5355\u4E2A\u670D\u52A1\u8FDE\u7EED\u7B7E\u5230 30 \u5929" },
  { id: "night", icon: "\u{1F319}", name: "\u591C\u732B\u5B50", desc: "\u51CC\u6668 0~5 \u70B9\u8FD8\u5728\u7B7E\u5230\uFF08\u9690\u85CF\u6210\u5C31\uFF09" },
  { id: "c10", icon: "\u{1F5C3}\uFE0F", name: "\u5341\u4EF6\u5957", desc: "\u53F0\u8D26\u8BB0\u5F55\u6EE1 10 \u4E2A\u670D\u52A1" },
  { id: "c30", icon: "\u{1F3E6}", name: "\u8D44\u4EA7\u5927\u6237", desc: "\u53F0\u8D26\u8BB0\u5F55\u6EE1 30 \u4E2A\u670D\u52A1" },
  { id: "xp100", icon: "\u{1F4B0}", name: "\u767E\u70B9\u5BB6\u4EA7", desc: "\u7D2F\u8BA1\u83B7\u5F97 100 \u70B9\u70ED\u60C5\u503C" }
];
function maxRun(dates) {
  const s = [...new Set(dates)].sort();
  let best = 0, run = 0, prev = null;
  for (const d of s) {
    run = prev && nextDay(prev) === d ? run + 1 : 1;
    prev = d;
    if (run > best) best = run;
  }
  return best;
}
__name(maxRun, "maxRun");
function dailyServices(data) {
  return data.services.filter((s) => s.checkinFrequency === "daily" && s.category !== "idle");
}
__name(dailyServices, "dailyServices");
function ensureMeta(data) {
  let dirty = false;
  if (typeof data.xp !== "number") {
    data.xp = 0;
    dirty = true;
  }
  if (!data.achievements || typeof data.achievements !== "object") {
    data.achievements = {};
    dirty = true;
  }
  if (!data.flags || typeof data.flags !== "object") {
    data.flags = {};
    dirty = true;
  }
  if (!data.history || typeof data.history !== "object") {
    data.history = {};
    for (const s of data.services) {
      for (const d of s.checkins || []) {
        data.history[d] = data.history[d] || { c: 0 };
        data.history[d].c++;
      }
    }
    dirty = true;
  }
  return dirty;
}
__name(ensureMeta, "ensureMeta");
function syncAchievements(data) {
  const unlocked = [];
  const award = /* @__PURE__ */ __name((id) => {
    if (!data.achievements[id]) {
      data.achievements[id] = todayStr();
      data.xp += 10;
      unlocked.push(ACH_DEFS.find((a) => a.id === id));
    }
  }, "award");
  if (data.services.some((s) => (s.checkins || []).length)) award("first");
  const best = Math.max(0, ...data.services.map((s) => maxRun(s.checkins || [])));
  if (best >= 7) award("s7");
  if (best >= 30) award("s30");
  if (Object.values(data.history).some((h) => h && h.all)) award("all1");
  const allDays = Object.keys(data.history).filter((k) => data.history[k].all).sort();
  let run = 0, bestAll = 0, prev = null;
  for (const d of allDays) {
    run = prev && nextDay(prev) === d ? run + 1 : 1;
    prev = d;
    if (run > best) bestAll = run;
  }
  if (bestAll >= 7) award("week");
  if (data.flags.night) award("night");
  if (data.services.length >= 10) award("c10");
  if (data.services.length >= 30) award("c30");
  if (data.xp >= 100) award("xp100");
  return unlocked;
}
__name(syncAchievements, "syncAchievements");
function metaPayload(data) {
  const t = todayStr();
  const daily = dailyServices(data);
  const best = Math.max(0, ...data.services.map((s) => maxRun(s.checkins || [])));
  return {
    username: data.username,
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
    history: data.history
  };
}
__name(metaPayload, "metaPayload");
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
    hasAccount: Array.isArray(s.accounts) && s.accounts.length > 0 || !!s.account,
    visits: s.visits || 0,
    sortOrder: s.sortOrder ?? 0,
    notes: s.notes || "",
    linkStatus: s.linkStatus,
    tags: (Array.isArray(s.tags) ? s.tags : []).map((t) => String(t).trim().slice(0, 20)).filter(Boolean).slice(0, 10),
    uptime7: (() => {
      const hist = (Array.isArray(s.linkHistory) ? s.linkHistory : []).filter((h) => h && typeof h.t === "number" && typeof h.ok === "boolean");
      if (!hist.length) return null;
      const cutoff = Date.now() - 7 * 864e5;
      const recent = hist.filter((h) => h.t >= cutoff);
      if (!recent.length) return null;
      return Math.round(recent.filter((h) => h.ok).length / recent.length * 100);
    })()
  }));
}
__name(publicServices, "publicServices");
async function loadData(db) {
  await ensureSchema(db);
  const metaRows = await db.prepare("SELECT key, value FROM meta").all();
  const meta = {};
  for (const r of metaRows.results || []) meta[r.key] = r.value;
  const svcRows = await db.prepare("SELECT data FROM services").all();
  const services = (svcRows.results || []).map((r) => JSON.parse(r.data));
  const noteRows = await db.prepare("SELECT id, title, content, createdAt, updatedAt FROM notes ORDER BY updatedAt DESC").all();
  const notes = (noteRows.results || []).map((r) => ({ id: r.id, title: r.title, content: r.content, createdAt: r.createdAt, updatedAt: r.updatedAt }));
  if (!meta.username) {
    const data2 = await defaultData();
    await saveData(db, data2);
    return data2;
  }
  const data = {
    username: meta.username,
    passwordHash: meta.passwordHash || "",
    passwordIsDefault: meta.passwordIsDefault ? JSON.parse(meta.passwordIsDefault) : true,
    xp: Number(meta.xp || 0),
    apiToken: meta.apiToken || void 0,
    totpSecret: meta.totpSecret || void 0,
    totpEnabled: meta.totpEnabled ? JSON.parse(meta.totpEnabled) : false,
    achievements: safeJSON(meta.achievements, {}),
    flags: safeJSON(meta.flags, {}),
    history: safeJSON(meta.history, {}),
    categories: safeJSON(meta.categories, null),
    notify: safeJSON(meta.notify, {}),
    githubBackup: safeJSON(meta.githubBackup, {}),
    services,
    notes
  };
  let dirty = ensureMeta(data);
  data.services.forEach((s, i) => {
    if (typeof s.sortOrder !== "number") {
      s.sortOrder = i;
      dirty = true;
    }
    if (typeof s.visits !== "number") {
      s.visits = 0;
      dirty = true;
    }
    const snap = JSON.stringify([s.accounts, s.account, s.secret]);
    normalizeAccounts(s);
    if (JSON.stringify([s.accounts, s.account, s.secret]) !== snap) dirty = true;
  });
  if (dirty) await saveData(db, data);
  return data;
}
__name(loadData, "loadData");
async function defaultData() {
  return {
    username: "jason",
    passwordHash: await hashPassword("jason123"),
    passwordIsDefault: true,
    xp: 0,
    achievements: {},
    flags: {},
    history: {},
    services: [
      {
        id: randomBytes(12).toString("hex"),
        name: "\u793A\u4F8B \xB7 \u67D0\u7B7E\u5230\u4E2D\u8F6C\u7AD9",
        category: "checkin",
        url: "https://example.com",
        account: "jason",
        secret: "",
        registeredAt: "2026-10-20",
        expiresAt: "",
        price: "",
        checkinFrequency: "daily",
        notes: "\u793A\u4F8B\u6570\u636E\uFF1A\u7B7E\u5230\u9001\u989D\u5EA6\u3002\u5728\u5361\u7247\u4E0A\u53EF\u4EE5\u7F16\u8F91\u6216\u5220\u9664\u3002",
        checkins: ["2026-10-25", "2026-10-26"],
        visits: 0,
        sortOrder: 0
      },
      {
        id: randomBytes(12).toString("hex"),
        name: "\u793A\u4F8B \xB7 \u4E00\u53F0 VPS",
        category: "vps",
        url: "",
        account: "root",
        secret: "",
        registeredAt: "2026-01-10",
        expiresAt: "2026-11-03",
        price: "$10/\u5E74",
        checkinFrequency: "none",
        notes: "\u793A\u4F8B\u6570\u636E\uFF1A\u6F14\u793A 7 \u5929\u5185\u5230\u671F\u63D0\u9192\u3002",
        checkins: [],
        visits: 0,
        sortOrder: 1
      }
    ],
    notes: []
  };
}
__name(defaultData, "defaultData");
function chunkedInsertOrReplace(table, cols, rows, perStmt) {
  const stmts = [];
  for (let i = 0; i < rows.length; i += perStmt) {
    const part = rows.slice(i, i + perStmt);
    const placeholders = part.map(() => `(${cols.map(() => "?").join(",")})`).join(",");
    stmts.push({
      sql: `INSERT OR REPLACE INTO ${table} (${cols.join(",")}) VALUES ${placeholders}`,
      args: part.flat()
    });
  }
  return stmts;
}
__name(chunkedInsertOrReplace, "chunkedInsertOrReplace");
async function saveData(db, data) {
  const metaEntries = [
    ["username", String(data.username || "jason")],
    ["passwordHash", String(data.passwordHash || "")],
    ["passwordIsDefault", JSON.stringify(data.passwordIsDefault !== false)],
    ["xp", String(data.xp || 0)],
    ["achievements", JSON.stringify(data.achievements || {})],
    ["flags", JSON.stringify(data.flags || {})],
    ["history", JSON.stringify(data.history || {})],
    ["categories", JSON.stringify(Array.isArray(data.categories) ? data.categories : [])],
    ["notify", JSON.stringify(data.notify || {})],
    ["githubBackup", JSON.stringify(data.githubBackup || {})],
    ["totpEnabled", JSON.stringify(!!data.totpEnabled)]
  ];
  if (data.apiToken) metaEntries.push(["apiToken", data.apiToken]);
  if (data.totpSecret) metaEntries.push(["totpSecret", data.totpSecret]);
  const stmts = chunkedInsertOrReplace("meta", ["key", "value"], metaEntries, 40);
  if (!data.apiToken) stmts.push({ sql: "DELETE FROM meta WHERE key = ?", args: ["apiToken"] });
  if (!data.totpSecret) stmts.push({ sql: "DELETE FROM meta WHERE key = ?", args: ["totpSecret"] });
  const svcRows = (data.services || []).map((s) => [s.id, JSON.stringify(s)]);
  stmts.push(...chunkedInsertOrReplace("services", ["id", "data"], svcRows, 40));
  if (svcRows.length) {
    stmts.push({ sql: `DELETE FROM services WHERE id NOT IN (${svcRows.map(() => "?").join(",")})`, args: svcRows.map((r) => r[0]) });
  } else {
    stmts.push({ sql: "DELETE FROM services", args: [] });
  }
  const noteRows = (data.notes || []).map((n) => [n.id, n.title, n.content, n.createdAt, n.updatedAt]);
  stmts.push(...chunkedInsertOrReplace("notes", ["id", "title", "content", "createdAt", "updatedAt"], noteRows, 16));
  if (noteRows.length) {
    stmts.push({ sql: `DELETE FROM notes WHERE id NOT IN (${noteRows.map(() => "?").join(",")})`, args: noteRows.map((r) => r[0]) });
  } else {
    stmts.push({ sql: "DELETE FROM notes", args: [] });
  }
  for (const s of stmts) {
    await db.prepare(s.sql).bind(...s.args).run();
  }
}
__name(saveData, "saveData");
async function currentUser(request, db) {
  const token = parseCookies(request.headers.get("cookie")).session;
  if (!token) return null;
  const row = await db.prepare("SELECT created FROM sessions WHERE token = ?").bind(token).first();
  if (!row || Date.now() - row.created > SESSION_MS) return null;
  return { token };
}
__name(currentUser, "currentUser");
async function createSession(db) {
  const token = randomBytes(32).toString("hex");
  await db.prepare("INSERT INTO sessions (token, created) VALUES (?, ?)").bind(token, Date.now()).run();
  await db.prepare("DELETE FROM sessions WHERE created < ?").bind(Date.now() - SESSION_MS).run();
  return token;
}
__name(createSession, "createSession");
async function deleteSession(db, token) {
  await db.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
}
__name(deleteSession, "deleteSession");
async function isApiToken(request, db) {
  const h = request.headers.get("authorization") || "";
  const m = h.match(/^Bearer\s+(\S+)$/i);
  let tok = m ? m[1] : "";
  if (!tok) {
    try {
      tok = new URL(request.url).searchParams.get("token") || "";
    } catch {
      tok = "";
    }
  }
  if (!tok) return false;
  const row = await db.prepare("SELECT value FROM meta WHERE key = 'apiToken'").bind().first();
  return !!row && row.value === tok;
}
__name(isApiToken, "isApiToken");
function isTokenAllowedEndpoint(pathname, method) {
  if (method !== "POST") return false;
  if (pathname === "/api/checkins/all") return true;
  return /^\/api\/services\/[0-9a-f]+\/checkin$/.test(pathname);
}
__name(isTokenAllowedEndpoint, "isTokenAllowedEndpoint");
function sanitizeAccount(a) {
  if (!a || typeof a !== "object") return null;
  return {
    id: String(a.id || randomBytes(6).toString("hex")).slice(0, 32),
    label: String(a.label || "").trim().slice(0, 30) || "\u8D26\u53F7",
    username: String(a.username || "").trim().slice(0, 200),
    password: String(a.password || "").slice(0, 500),
    notes: String(a.notes || "").trim().slice(0, 200),
    isDefault: !!a.isDefault,
    checkins: (Array.isArray(a.checkins) ? a.checkins : []).filter((d) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)).slice(0, 1e3).sort()
  };
}
__name(sanitizeAccount, "sanitizeAccount");
function normalizeAccounts(svc) {
  if (!Array.isArray(svc.accounts)) svc.accounts = [];
  svc.accounts = svc.accounts.map(sanitizeAccount).filter(Boolean).slice(0, 20);
  if (!svc.accounts.length && (svc.account || svc.secret)) {
    svc.accounts.push({ id: randomBytes(6).toString("hex"), label: "\u9ED8\u8BA4", username: String(svc.account || ""), password: String(svc.secret || ""), notes: "", isDefault: true, checkins: [] });
  }
  let def = svc.accounts.find((a) => a.isDefault);
  if (!def && svc.accounts.length) {
    svc.accounts[0].isDefault = true;
    def = svc.accounts[0];
  }
  svc.accounts.forEach((a) => {
    if (a !== def) a.isDefault = false;
  });
  if (svc.accounts.length && (svc.checkins || []).length && !svc.accounts.some((a) => (a.checkins || []).length)) {
    def.checkins = [...svc.checkins || []].sort();
  }
  svc.account = def ? def.username : "";
  svc.secret = def ? def.password : "";
  return svc;
}
__name(normalizeAccounts, "normalizeAccounts");
function sanitizeCustomFields(v) {
  if (!Array.isArray(v)) return [];
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const f of v) {
    if (!f || typeof f !== "object") continue;
    const k = String(f.k || "").trim().slice(0, 20);
    const val = String(f.v ?? "").trim().slice(0, 200);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push({ k, v: val });
    if (out.length >= 10) break;
  }
  return out;
}
__name(sanitizeCustomFields, "sanitizeCustomFields");
function sanitizeAutoSignin(a) {
  if (!a || typeof a !== "object") return null;
  const url = String(a.url || "").trim().slice(0, 500);
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const headers = {};
  if (a.headers && typeof a.headers === "object") {
    for (const [k, v] of Object.entries(a.headers).slice(0, 10)) {
      const key = String(k).trim().slice(0, 100);
      if (!key) continue;
      headers[key] = String(v).slice(0, 500);
    }
  }
  return {
    enabled: !!a.enabled,
    url,
    method: String(a.method || "POST").toUpperCase() === "GET" ? "GET" : "POST",
    headers,
    body: String(a.body || "").slice(0, 2e3),
    expect: String(a.expect || "").trim().slice(0, 200)
  };
}
__name(sanitizeAutoSignin, "sanitizeAutoSignin");
function autoSigninOf(s) {
  if (!s || !s.autoSignin || typeof s.autoSignin !== "object") return null;
  const cfg = sanitizeAutoSignin(s.autoSignin);
  if (!cfg || !cfg.enabled) return null;
  return cfg;
}
__name(autoSigninOf, "autoSigninOf");
function clampInt(v, lo, hi, fb) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fb;
}
__name(clampInt, "clampInt");
function checkinEvery(s) {
  return clampInt(s.checkinEveryDays, 1, 365, 1);
}
__name(checkinEvery, "checkinEvery");
function renewEvery(s) {
  return clampInt(s.renewDays, 1, 3650, 365);
}
__name(renewEvery, "renewEvery");
function pickFields(b, existing, catIds) {
  const out = {};
  if (typeof b.name === "string") out.name = b.name.trim().slice(0, 100);
  if (b.category !== void 0) out.category = (catIds || []).includes(b.category) ? b.category : "relay";
  if (b.checkinFrequency !== void 0) out.checkinFrequency = b.checkinFrequency === "daily" ? "daily" : "none";
  if (b.checkinEveryDays !== void 0) out.checkinEveryDays = clampInt(b.checkinEveryDays, 1, 365, 1);
  if (b.renewDays !== void 0) out.renewDays = clampInt(b.renewDays, 1, 3650, 365);
  if (b.favorite !== void 0) out.favorite = !!b.favorite;
  if (b.abnormal !== void 0) out.abnormal = !!b.abnormal;
  if (b.customFields !== void 0) out.customFields = sanitizeCustomFields(b.customFields);
  if (b.tags !== void 0) {
    const raw = Array.isArray(b.tags) ? b.tags : String(b.tags || "").split(/[,，、\s]+/);
    const seen = /* @__PURE__ */ new Set();
    out.tags = raw.map((t) => String(t).trim().slice(0, 20)).filter((t) => t && !seen.has(t) && seen.add(t)).slice(0, 10);
  }
  if (b.autoSignin !== void 0) {
    if (b.autoSignin === null) {
      out.autoSignin = null;
    } else {
      const cfg = sanitizeAutoSignin(b.autoSignin);
      if (cfg) out.autoSignin = cfg;
      else if (b.autoSignin && typeof b.autoSignin === "object" && !b.autoSignin.url) out.autoSignin = null;
    }
  }
  if (b.category === "fav" && (!existing || existing.category !== "fav")) out.favorite = true;
  if (Array.isArray(b.accounts)) {
    const existingById = new Map((Array.isArray(existing?.accounts) ? existing.accounts : []).map((a) => [String(a.id || ""), a]));
    out.accounts = b.accounts.map((a) => {
      const s = sanitizeAccount(a);
      if (!s) return null;
      if ((!a.checkins || !a.checkins.length) && existingById.has(s.id)) {
        const old = existingById.get(s.id);
        if (Array.isArray(old.checkins)) s.checkins = old.checkins.filter((d) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)).slice(0, 1e3).sort();
      }
      return s;
    }).filter(Boolean).slice(0, 20);
    const def = out.accounts.find((a) => a.isDefault) || out.accounts[0];
    out.account = def ? def.username : "";
    out.secret = def ? def.password : "";
  } else if (b.account !== void 0 || b.secret !== void 0) {
    const base = Array.isArray(existing?.accounts) ? existing.accounts.map(sanitizeAccount).filter(Boolean) : [];
    const acc = base.find((a) => a.isDefault) || base[0];
    const username = typeof b.account === "string" ? b.account.trim().slice(0, 200) : acc ? acc.username : "";
    const password = typeof b.secret === "string" ? b.secret.slice(0, 500) : acc ? acc.password : "";
    if (acc) {
      acc.username = username;
      acc.password = password;
      out.accounts = base;
    } else {
      out.accounts = [{ id: randomBytes(6).toString("hex"), label: "\u9ED8\u8BA4", username, password, notes: "", isDefault: true }];
    }
    out.account = username;
    out.secret = password;
  }
  for (const k of ["url", "price", "notes", "registeredAt", "expiresAt"]) {
    if (typeof b[k] === "string") out[k] = b[k].trim().slice(0, 500);
  }
  return out;
}
__name(pickFields, "pickFields");
function dayDiff(a, b) {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 864e5);
}
__name(dayDiff, "dayDiff");
function checkinDue(s, t) {
  const c = (s.checkins || []).filter(Boolean).sort();
  if (!c.length) return true;
  return dayDiff(c[c.length - 1], t) >= checkinEvery(s);
}
__name(checkinDue, "checkinDue");
function accountCheckins(a) {
  return Array.isArray(a.checkins) ? a.checkins : [];
}
__name(accountCheckins, "accountCheckins");
function serviceAccounts(s) {
  return Array.isArray(s.accounts) ? s.accounts : [];
}
__name(serviceAccounts, "serviceAccounts");
function serviceDoneToday(s, t) {
  const accs = serviceAccounts(s);
  if (!accs.length) return (s.checkins || []).includes(t);
  return accs.every((a) => accountCheckins(a).includes(t));
}
__name(serviceDoneToday, "serviceDoneToday");
function serviceProgress(s, t) {
  const accs = serviceAccounts(s);
  if (!accs.length) return { done: (s.checkins || []).includes(t) ? 1 : 0, total: 1 };
  return { done: accs.filter((a) => accountCheckins(a).includes(t)).length, total: accs.length };
}
__name(serviceProgress, "serviceProgress");
function checkinCohort(data, t) {
  return dailyServices(data).filter((s) => !s.abnormal && (checkinDue(s, t) || serviceDoneToday(s, t)));
}
__name(checkinCohort, "checkinCohort");
function unsignedDaily(data, t) {
  return dailyServices(data).filter((s) => !s.abnormal && checkinDue(s, t));
}
__name(unsignedDaily, "unsignedDaily");
function doCheckin(data, svc, t) {
  let xp = 0;
  if (!(svc.checkins || []).includes(t)) {
    svc.checkins = svc.checkins || [];
    svc.checkins.push(t);
    svc.checkins.sort();
    data.history[t] = data.history[t] || { c: 0 };
    data.history[t].c++;
    if (!data.history[t].x) {
      xp += 5;
      data.history[t].x = 5;
    }
    data.flags = data.flags || {};
    if (cstHour() < 5) data.flags.night = true;
  }
  return xp;
}
__name(doCheckin, "doCheckin");
function doCheckinAccount(data, svc, acc, t) {
  acc.checkins = accountCheckins(acc);
  if (acc.checkins.includes(t)) return 0;
  acc.checkins.push(t);
  acc.checkins.sort();
  if (!serviceDoneToday(svc, t)) return 0;
  return doCheckin(data, svc, t);
}
__name(doCheckinAccount, "doCheckinAccount");
function doUncheckinAccount(data, svc, acc, t) {
  acc.checkins = accountCheckins(acc).filter((d) => d !== t);
  if ((svc.checkins || []).includes(t) && !serviceDoneToday(svc, t)) {
    svc.checkins = svc.checkins.filter((d) => d !== t);
    if (data.history[t]) data.history[t].c = Math.max(0, (data.history[t].c || 1) - 1);
  }
}
__name(doUncheckinAccount, "doUncheckinAccount");
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
__name(allDoneBonus, "allDoneBonus");
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
__name(checkinAllTodayNoWrite, "checkinAllTodayNoWrite");
function daysUntilSrv(dateStr) {
  if (!dateStr) return null;
  const [y, m, d] = dateStr.split("-").map(Number);
  const [ty, tm, td] = todayStr().split("-").map(Number);
  return Math.round((new Date(y, m - 1, d) - new Date(ty, tm - 1, td)) / 864e5);
}
__name(daysUntilSrv, "daysUntilSrv");
function expiringList(data) {
  return data.services.filter((s) => s.expiresAt && daysUntilSrv(s.expiresAt) <= 30).map((s) => ({ s, d: daysUntilSrv(s.expiresAt) })).sort((a, b) => a.d - b.d);
}
__name(expiringList, "expiringList");
function addYear(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y + 1, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) dt.setUTCDate(0);
  return dt.toISOString().slice(0, 10);
}
__name(addYear, "addYear");
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * 864e5).toISOString().slice(0, 10);
}
__name(addDays, "addDays");
function notifyCfg(data) {
  if (!data.notify || typeof data.notify !== "object") data.notify = {};
  return data.notify;
}
__name(notifyCfg, "notifyCfg");
function tgApiUrl(token, method) {
  return `https://api.telegram.org/bot${token}/${method}`;
}
__name(tgApiUrl, "tgApiUrl");
var CHECKIN_KB = { inline_keyboard: [[{ text: "\u2705 \u5168\u90E8\u7B7E\u5230", callback_data: "checkin_all" }]] };
async function tgSend(token, chatId, text, markup) {
  const payload = { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true };
  if (markup) payload.reply_markup = markup;
  const res = await fetch(tgApiUrl(token, "sendMessage"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.description || `Telegram \u8FD4\u56DE ${res.status}`);
  return j;
}
__name(tgSend, "tgSend");
function escHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
__name(escHtml, "escHtml");
function stripHtmlTags(s) {
  return String(s ?? "").replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}
__name(stripHtmlTags, "stripHtmlTags");
async function sendWebhook(url, title, text) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, text, time: cstDateTime(), source: "hubmate" }),
    signal: AbortSignal.timeout(1e4)
  });
  if (!res.ok) throw new Error(`Webhook \u8FD4\u56DE ${res.status}`);
}
__name(sendWebhook, "sendWebhook");
async function sendBark(key, title, body) {
  const url = `https://api.day.app/${encodeURIComponent(key)}/${encodeURIComponent(title)}/${encodeURIComponent(body)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(1e4) });
  if (!res.ok) throw new Error(`Bark \u8FD4\u56DE ${res.status}`);
}
__name(sendBark, "sendBark");
async function sendServerChan(key, title, desp) {
  const res = await fetch(`https://sctapi.ftqq.com/${encodeURIComponent(key)}.send`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `title=${encodeURIComponent(title)}&desp=${encodeURIComponent(desp)}`,
    signal: AbortSignal.timeout(1e4)
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.code !== void 0 && j.code !== 0) throw new Error(j.message || `Server\u9171\u8FD4\u56DE ${res.status}`);
}
__name(sendServerChan, "sendServerChan");
async function sendMultiChannel(n, title, htmlText, tgMarkup) {
  const plain = stripHtmlTags(htmlText);
  const results = {};
  const run = /* @__PURE__ */ __name(async (name, fn) => {
    try {
      await fn();
      results[name] = "ok";
    } catch (e) {
      results[name] = "error: " + (e.message || "\u53D1\u9001\u5931\u8D25");
      console.error(`[!] ${name} \u63A8\u9001\u5931\u8D25:`, e.message);
    }
  }, "run");
  if (n.token && n.chatId) await run("telegram", () => tgSend(n.token, n.chatId, htmlText, tgMarkup));
  else results.telegram = "skip";
  if (n.webhookUrl) await run("webhook", () => sendWebhook(n.webhookUrl, title, plain));
  else results.webhook = "skip";
  if (n.barkKey) await run("bark", () => sendBark(n.barkKey, title, plain));
  else results.bark = "skip";
  if (n.serverChanKey) await run("serverchan", () => sendServerChan(n.serverChanKey, title, plain));
  else results.serverchan = "skip";
  const ok = Object.values(results).some((v) => v === "ok");
  return { ok, results };
}
__name(sendMultiChannel, "sendMultiChannel");
function expiringLines(items) {
  const lines = items.slice(0, 20).map(({ s, d }) => {
    const name = escHtml(s.name);
    if (d < 0) return `\u2022 <b>${name}</b> \u670D\u52A1\u5DF2\u8FC7\u671F ${-d} \u5929\uFF08${s.expiresAt}\uFF09`;
    if (d === 0) return `\u2022 <b>${name}</b> \u670D\u52A1\u4ECA\u5929\u5230\u671F\uFF08${s.expiresAt}\uFF09`;
    return `\u2022 <b>${name}</b> \u670D\u52A1\u5373\u5C06\u5230\u671F\uFF0C\u8FD8\u5269 ${d} \u5929\uFF08${s.expiresAt}\uFF09`;
  });
  if (items.length > 20) lines.push(`\u2026\u7B49\u5171 ${items.length} \u4E2A\u4E34\u671F\u670D\u52A1`);
  return lines;
}
__name(expiringLines, "expiringLines");
function checkinLines(todo) {
  const t = todayStr();
  const lines = todo.slice(0, 20).map((s) => {
    const p = serviceProgress(s, t);
    const suffix = p.total > 1 ? `\uFF08\u5DF2\u7B7E ${p.done}/${p.total}\uFF09` : "";
    return `\u2022 <b>${escHtml(s.name)}</b>${suffix}`;
  });
  if (todo.length > 20) lines.push(`\u2026\u7B49\u5171 ${todo.length} \u4E2A`);
  return lines;
}
__name(checkinLines, "checkinLines");
async function runNotifyChecks(db) {
  try {
    const data = await loadData(db);
    const n = notifyCfg(data);
    if (!(n.token && n.chatId) && !n.webhookUrl && !n.barkKey && !n.serverChanKey) return;
    const prevNotify = { lastExpiring: n.lastExpiring, lastCheckin: n.lastCheckin, lastCheckinRepeatAt: n.lastCheckinRepeatAt };
    const pushHour = n.pushHour === void 0 ? 9 : n.pushHour;
    if (cstHour() < pushHour) return;
    const t = todayStr();
    let dirty = false;
    const tryPush = /* @__PURE__ */ __name(async (title, htmlText, tgMarkup) => {
      try {
        const r = await sendMultiChannel(n, title, htmlText, tgMarkup);
        if (!r.ok) console.error("[!] \u591A\u6E20\u9053\u63A8\u9001\u5168\u90E8\u5931\u8D25");
        return r.ok;
      } catch (e) {
        console.error("[!] \u591A\u6E20\u9053\u63A8\u9001\u5F02\u5E38:", e.message);
        return false;
      }
    }, "tryPush");
    if (n.expiring !== false && n.lastExpiring !== t) {
      const items = expiringList(data);
      let ok = true;
      if (items.length) {
        ok = await tryPush(
          `\u670D\u52A1\u53F0\u4E34\u671F\u63D0\u9192 \xB7 ${t}`,
          `\u23F0 <b>\u670D\u52A1\u53F0\u4E34\u671F\u63D0\u9192</b> \xB7 ${t}
\u5171 ${items.length} \u4E2A\u670D\u52A1\u4E34\u671F\uFF1A

${expiringLines(items).join("\n")}`
        );
      }
      if (ok) {
        n.lastExpiring = t;
        dirty = true;
      }
    }
    if (n.checkin !== false && n.lastCheckin !== t) {
      const todo = unsignedDaily(data, t);
      let ok = true;
      if (todo.length) {
        ok = await tryPush(
          `\u670D\u52A1\u53F0\u7B7E\u5230\u63D0\u9192 \xB7 ${t}`,
          `\u26A1 <b>\u670D\u52A1\u53F0\u7B7E\u5230\u63D0\u9192</b> \xB7 ${t}
\u4ECA\u65E5\u8FD8\u6709 ${todo.length} \u4E2A\u7AD9\u672A\u7B7E\u5230\uFF1A

${checkinLines(todo).join("\n")}

\u{1F449} \u70B9\u4E0B\u9762\u6309\u94AE\u76F4\u63A5\u7B7E\u5B8C\uFF0C\u522B\u65AD\u4E86\u8FDE\u7B7E\u3002`,
          CHECKIN_KB
        );
      }
      if (ok) {
        n.lastCheckin = t;
        n.lastCheckinRepeatAt = Date.now();
        dirty = true;
      }
    }
    if (n.checkin !== false && n.repeatHours > 0 && n.lastCheckin === t) {
      const todo = unsignedDaily(data, t);
      const h = cstHour();
      const last = n.lastCheckinRepeatAt || 0;
      if (todo.length && h >= pushHour && h < 23 && Date.now() - last >= n.repeatHours * 36e5) {
        const okR = await tryPush(
          `\u670D\u52A1\u53F0\u7B7E\u5230\u63D0\u9192\uFF08\u590D\u67E5\uFF09\xB7 ${t}`,
          `\u26A1 <b>\u670D\u52A1\u53F0\u7B7E\u5230\u63D0\u9192\uFF08\u590D\u67E5\uFF09</b> \xB7 ${t}
\u4ECA\u65E5\u8FD8\u6709 ${todo.length} \u4E2A\u7AD9\u672A\u7B7E\u5230\uFF1A

${checkinLines(todo).join("\n")}

\u{1F449} \u70B9\u4E0B\u9762\u6309\u94AE\u76F4\u63A5\u7B7E\u5B8C\uFF0C\u522B\u65AD\u4E86\u8FDE\u7B7E\u3002`,
          CHECKIN_KB
        );
        if (okR) {
          n.lastCheckinRepeatAt = Date.now();
          dirty = true;
        }
      }
    }
    if (dirty) {
      const fresh = await loadData(db);
      const fn = notifyCfg(fresh);
      for (const k of ["lastExpiring", "lastCheckin", "lastCheckinRepeatAt"]) {
        if (n[k] !== void 0 && n[k] !== prevNotify[k]) fn[k] = n[k];
      }
      await saveData(db, fresh);
    }
  } catch (e) {
    console.error("[!] TG \u5B9A\u65F6\u68C0\u67E5\u5F02\u5E38:", e.message);
  }
}
__name(runNotifyChecks, "runNotifyChecks");
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
__name(snapshotPollState, "snapshotPollState");
function mergePollWrites(cur, mutated, snap) {
  const cn = notifyCfg(cur);
  const mn = mutated.notify || {};
  if (mn.tgSeen !== void 0) cn.tgSeen = Math.max(cn.tgSeen || 0, mn.tgSeen);
  for (const s of mutated.services) {
    const before = snap.checkins.get(s.id);
    if (before !== void 0 && JSON.stringify(s.checkins || []) !== before) {
      const cs = cur.services.find((x) => x.id === s.id);
      if (cs) cs.checkins = [.../* @__PURE__ */ new Set([...cs.checkins || [], ...s.checkins || []])].sort();
    }
  }
  const mh = mutated.history || {};
  cur.history = cur.history || {};
  for (const [k, v] of Object.entries(mh)) {
    if (JSON.stringify(v) !== JSON.stringify(snap.history[k])) {
      const base = cur.history[k] || {};
      const delta = (v.c || 0) - (snap.history[k] && snap.history[k].c || 0);
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
__name(mergePollWrites, "mergePollWrites");
async function pollBotCommands(db) {
  try {
    const data = await loadData(db);
    const n = notifyCfg(data);
    if (!n.token || !n.chatId) return;
    const snap = snapshotPollState(data);
    const res = await fetch(tgApiUrl(n.token, "getUpdates"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    });
    const j = await res.json().catch(() => ({}));
    if (!j.ok || !Array.isArray(j.result)) return;
    if (n.tgSeen === void 0) {
      n.tgSeen = j.result.reduce((m, u) => Math.max(m, u.update_id || 0), 0);
      await saveData(db, mergePollWrites(await loadData(db), data, snap));
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
        if (cb.data === "checkin_all") {
          const r = checkinAllTodayNoWrite(data);
          await fetch(tgApiUrl(n.token, "answerCallbackQuery"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ callback_query_id: cb.id, text: r.signed ? `\u5DF2\u7B7E\u5230 ${r.signed} \u4E2A${r.xpGained ? `\uFF0C+${r.xpGained}\u26A1` : ""}` : "\u4ECA\u65E5\u5DF2\u5168\u90E8\u7B7E\u5B8C \u2713" })
          }).catch(() => {
          });
          const mid = cb.message && cb.message.message_id;
          if (mid) {
            await fetch(tgApiUrl(n.token, "editMessageText"), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ chat_id: n.chatId, message_id: mid, text: `\u26A1 <b>\u670D\u52A1\u53F0\u7B7E\u5230\u63D0\u9192</b> \xB7 ${t}
\u4ECA\u65E5\u5DF2\u5168\u90E8\u7B7E\u5230 \u2713${r.signed ? `\uFF08\u521A\u624D\u7B7E\u4E86 ${r.signed} \u4E2A\uFF09` : ""}`, parse_mode: "HTML", reply_markup: { inline_keyboard: [] } })
            }).catch(() => {
            });
          }
        }
        continue;
      }
      const msg = u.message;
      if (!msg || String(msg.chat && msg.chat.id) !== String(n.chatId)) continue;
      const text = String(msg.text || "").trim();
      const send = /* @__PURE__ */ __name((txt) => tgSend(n.token, n.chatId, txt).catch(() => {
      }), "send");
      if (text === "/start" || text === "/help") {
        await send(`\u{1F916} <b>\u670D\u52A1\u53F0\u673A\u5668\u4EBA</b>
/today \u4ECA\u65E5\u7B7E\u5230\u60C5\u51B5
/expiring \u4E34\u671F\u670D\u52A1\u5217\u8868`);
      } else if (text === "/today") {
        const cohort = checkinCohort(data, t);
        const done = cohort.filter((s) => (s.checkins || []).includes(t)).length;
        const todo = unsignedDaily(data, t);
        const body = todo.length ? `\u4ECA\u65E5\u7B7E\u5230 ${done}/${cohort.length}\uFF0C\u8FD8\u6709 ${todo.length} \u4E2A\u672A\u7B7E\uFF1A

${checkinLines(todo).join("\n")}` : `\u4ECA\u65E5\u7B7E\u5230 ${done}/${cohort.length}\uFF0C\u5DF2\u5168\u90E8\u7B7E\u5B8C \u2713`;
        if (todo.length) await tgSend(n.token, n.chatId, `\u26A1 <b>\u4ECA\u65E5\u7B7E\u5230</b> \xB7 ${t}
${body}`, CHECKIN_KB).catch(() => {
        });
        else await send(`\u26A1 <b>\u4ECA\u65E5\u7B7E\u5230</b> \xB7 ${t}
${body}`);
      } else if (text === "/expiring") {
        const items = expiringList(data);
        const body = items.length ? `\u5171 ${items.length} \u4E2A\u670D\u52A1\u4E34\u671F\uFF1A

${expiringLines(items).join("\n")}` : "30 \u5929\u5185\u6682\u65E0\u4E34\u671F\u670D\u52A1";
        await send(`\u23F0 <b>\u4E34\u671F\u670D\u52A1</b> \xB7 ${t}
${body}`);
      }
    }
    await saveData(db, mergePollWrites(await loadData(db), data, snap));
  } catch (e) {
    console.error("[!] TG \u547D\u4EE4\u8F6E\u8BE2\u5F02\u5E38:", e.message);
  }
}
__name(pollBotCommands, "pollBotCommands");
function normLinkUrl(u) {
  u = String(u || "").trim();
  if (!u) return "";
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  try {
    return new URL(u).toString();
  } catch {
    return "";
  }
}
__name(normLinkUrl, "normLinkUrl");
async function probeLink(u) {
  const url = normLinkUrl(u);
  if (!url) return "unknown";
  try {
    const res = await fetch(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(8e3) });
    if (res.status >= 200 && res.status < 400) return "ok";
    if ([400, 401, 403, 405, 429, 501].includes(res.status)) return "unknown";
    return "dead";
  } catch {
    return "dead";
  }
}
__name(probeLink, "probeLink");
async function checkLinks(db) {
  try {
    const data = await loadData(db);
    const t = todayStr();
    const now = Date.now();
    const results = await Promise.all(data.services.map(async (s) => ({ id: s.id, st: await probeLink(s.url) })));
    const fresh = await loadData(db);
    let changed = false;
    for (const { id, st } of results) {
      const s = fresh.services.find((x) => x.id === id);
      if (!s) continue;
      if (s.linkStatus !== st) {
        s.linkStatus = st;
        s.linkCheckedAt = t;
        changed = true;
      }
      if (st === "ok" || st === "dead") {
        s.linkHistory = (Array.isArray(s.linkHistory) ? s.linkHistory : []).filter((h) => h && typeof h.t === "number");
        s.linkHistory.push({ t: now, ok: st === "ok" });
        if (s.linkHistory.length > 120) s.linkHistory = s.linkHistory.slice(-120);
        changed = true;
      }
    }
    if (changed) await saveData(db, fresh);
    return {
      total: results.length,
      dead: results.filter((r) => r.st === "dead").length,
      ok: results.filter((r) => r.st === "ok").length,
      unknown: results.filter((r) => r.st === "unknown").length,
      changed
    };
  } catch (e) {
    console.error("[!] \u94FE\u63A5\u68C0\u6D4B\u5F02\u5E38:", e.message);
    return null;
  }
}
__name(checkLinks, "checkLinks");
async function tryAutoSignin(svc, cfg) {
  try {
    const res = await fetch(cfg.url, {
      method: cfg.method,
      headers: cfg.headers,
      body: cfg.method === "POST" && cfg.body ? cfg.body : void 0,
      signal: AbortSignal.timeout(15e3),
      redirect: "follow"
    });
    const text = await res.text().catch(() => "");
    const ok = res.status >= 200 && res.status < 300 && (!cfg.expect || text.includes(cfg.expect));
    return { ok, status: res.status, note: ok ? "" : res.status >= 200 && res.status < 300 ? `\u54CD\u5E94\u91CC\u6CA1\u627E\u5230\u201C${cfg.expect}\u201D` : `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, status: 0, note: e.name === "AbortError" ? "\u8BF7\u6C42\u8D85\u65F6\uFF0815 \u79D2\uFF09" : e.message || "\u8BF7\u6C42\u5931\u8D25" };
  }
}
__name(tryAutoSignin, "tryAutoSignin");
async function runAutoSignins(db) {
  try {
    const data = await loadData(db);
    const t = todayStr();
    const due = checkinCohort(data, t);
    const results = [];
    let changed = false;
    for (const svc of due) {
      const cfg = autoSigninOf(svc);
      if (!cfg) continue;
      if (serviceDoneToday(svc, t)) continue;
      const r = await tryAutoSignin(svc, cfg);
      svc.autoSigninLast = { at: cstDateTime(), ok: r.ok, status: r.status, note: r.note || "" };
      changed = true;
      if (r.ok) {
        doCheckin(data, svc, t);
        results.push({ id: svc.id, name: svc.name, ok: true });
      } else {
        results.push({ id: svc.id, name: svc.name, ok: false, note: r.note });
      }
    }
    if (changed) await saveData(db, data);
    if (results.length) console.log(`[auto-signin] ${results.filter((r) => r.ok).length}/${results.length} \u6210\u529F`);
    return results;
  } catch (e) {
    console.error("[!] \u81EA\u52A8\u7B7E\u5230\u5F02\u5E38:", e.message);
    return null;
  }
}
__name(runAutoSignins, "runAutoSignins");
function strippedBackupData(data) {
  const out = { ...data };
  delete out.passwordHash;
  delete out.apiToken;
  delete out.totpSecret;
  out.services = (data.services || []).map((s) => {
    if (!s.autoSignin) return s;
    return { ...s, autoSignin: { ...s.autoSignin, headers: {} } };
  });
  out.notify = { ...data.notify || {} };
  delete out.notify.token;
  delete out.notify.webhookUrl;
  delete out.notify.barkKey;
  delete out.notify.serverChanKey;
  out.githubBackup = { ...data.githubBackup || {} };
  delete out.githubBackup.token;
  return out;
}
__name(strippedBackupData, "strippedBackupData");
async function pushGithubBackup(db) {
  try {
    const data = await loadData(db);
    const gb = data.githubBackup || {};
    if (!gb.token || !gb.repo || !/^[^/\s]+\/[^/\s]+$/.test(gb.repo)) return null;
    const content = JSON.stringify(strippedBackupData(data), null, 2);
    const hash = createHash("sha256").update(content).digest("hex");
    if (gb.lastHash === hash) return { ok: true, skipped: true };
    const branch = gb.branch || "main";
    const [owner, repo] = gb.repo.split("/");
    const apiBase = `https://api.github.com/repos/${owner}/${repo}/contents/hubmate-backup.json`;
    const headers = { "Authorization": `Bearer ${gb.token}`, "Accept": "application/vnd.github+json", "User-Agent": "hubmate" };
    let sha = null;
    try {
      const cur = await fetch(`${apiBase}?ref=${encodeURIComponent(branch)}`, { headers });
      if (cur.ok) {
        const j = await cur.json();
        sha = j.sha || null;
      }
    } catch {
    }
    const res = await fetch(apiBase, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: `hubmate backup ${todayStr()}`,
        content: Buffer2.from(content).toString("base64"),
        branch,
        ...sha ? { sha } : {}
      })
    });
    const ok = res.ok;
    const note = ok ? "" : `GitHub \u8FD4\u56DE HTTP ${res.status}`;
    const fresh = await loadData(db);
    fresh.githubBackup = { ...fresh.githubBackup || {}, lastAt: cstDateTime(), lastOk: ok, lastNote: note, ...ok ? { lastHash: hash } : {} };
    await saveData(db, fresh);
    console.log(`[github-backup] ${ok ? "\u6210\u529F" : "\u5931\u8D25 " + note}`);
    return { ok, note };
  } catch (e) {
    console.error("[!] GitHub \u5907\u4EFD\u5F02\u5E38:", e.message);
    return { ok: false, note: e.message };
  }
}
__name(pushGithubBackup, "pushGithubBackup");
function mdCell(v) {
  return String(v ?? "").replace(/\|/g, "/").replace(/\r?\n/g, " ");
}
__name(mdCell, "mdCell");
function ledgerMarkdown(data, origin) {
  const titles = {
    fav: "\u2605 \u6536\u85CF",
    checkin: "\u{1F4C5} \u6BCF\u65E5\u7B7E\u5230\u7C7B",
    relay: "\u{1F500} \u4E2D\u8F6C\u7AD9 / API \u7AD9\u70B9",
    vps: "\u{1F5A5}\uFE0F VPS / \u670D\u52A1\u5668",
    game: "\u{1F3AE} \u6E38\u620F\u76F8\u5173\uFF08\u6E38\u620F\u673A / \u5E73\u53F0 / \u8BA2\u9605\uFF09",
    domain: "\u{1F310} \u57DF\u540D / \u5176\u4ED6\u8BA2\u9605",
    idle: "\u{1F9DF} \u5DF2\u95F2\u7F6E / \u5FD8\u4E86\u5E72\u561B\u7684"
  };
  let md = `# \u{1F5C2}\uFE0F \u6211\u7684\u670D\u52A1\u53F0\u8D26

> \u7531\u300C\u670D\u52A1\u53F0\u300D\u7CFB\u7EDF\u81EA\u52A8\u5BFC\u51FA\u4E8E ${todayStr()}\u3002\u8BF7\u52FF\u624B\u6539\u672C\u6587\u4EF6\u2014\u2014\u5728\u7CFB\u7EDF\u91CC\u589E\u5220\u540E\u70B9\u300C\u5BFC\u51FA\u53F0\u8D26\u300D\u5373\u53EF\u5237\u65B0\u3002
> \u7CFB\u7EDF\u5730\u5740\uFF1A${origin || ""}
`;
  for (const c of categoriesOf(data)) {
    const list = data.services.filter((s) => s.category === c.id);
    md += `
## ${titles[c.id] || `${c.icon} ${c.label}`}\uFF08${list.length}\uFF09

`;
    if (!list.length) {
      md += "\uFF08\u6682\u65E0\uFF09\n";
      continue;
    }
    md += "| \u540D\u79F0 | \u7F51\u5740/\u5730\u5740 | \u8D26\u53F7 | \u6CE8\u518C/\u8D2D\u4E70 | \u5230\u671F | \u7B7E\u5230 | \u5907\u6CE8 |\n|---|---|---|---|---|---|---|\n";
    for (const s of list) {
      const ci = s.checkinFrequency === "daily" ? s.checkins.length ? `\u5DF2\u7B7E ${s.checkins.length} \u6B21` : "\u672A\u7B7E" : "\u2014";
      md += `| ${mdCell(s.name)} | ${mdCell(s.url)} | ${mdCell(s.account)} | ${mdCell(s.registeredAt)} | ${mdCell(s.expiresAt)} | ${ci} | ${mdCell(s.notes)} |
`;
    }
  }
  return md + "\n";
}
__name(ledgerMarkdown, "ledgerMarkdown");
async function jsonBody(request) {
  if (request._bodyJson !== void 0) return request._bodyJson;
  try {
    const text = await request.text();
    if (text.length > 1e6) {
      request._bodyJson = {};
      return request._bodyJson;
    }
    request._bodyJson = text ? JSON.parse(text) : {};
  } catch {
    request._bodyJson = {};
  }
  return request._bodyJson;
}
__name(jsonBody, "jsonBody");
async function handleAPI(request, env, pathname) {
  const db = env.DB;
  const method = request.method;
  const send = /* @__PURE__ */ __name((status, obj, headers) => jsonResponse(status, obj, headers), "send");
  if (pathname === "/api/healthz" && method === "GET") {
    return send(200, { ok: true, runtime: "workers" });
  }
  if (pathname === "/api/captcha" && method === "GET") {
    return send(200, await makeCaptcha(db));
  }
  if (pathname === "/api/login" && method === "POST") {
    const ip = clientIp(request);
    if (await loginThrottled(db, ip)) {
      console.warn(`[!] \u767B\u5F55\u8FC7\u4E8E\u9891\u7E41\uFF0C\u5DF2\u4E34\u65F6\u5C01\u7981\uFF1A${ip}`);
      return send(429, { error: "\u5C1D\u8BD5\u592A\u9891\u7E41\uFF0C\u8BF7 10 \u5206\u949F\u540E\u518D\u8BD5" });
    }
    const body = await jsonBody(request);
    if (!await verifyCaptcha(db, body.captchaId, body.captcha)) {
      return send(400, { error: "\u9A8C\u8BC1\u7801\u4E0D\u5BF9\u6216\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u65B0\u8F93\u5165" });
    }
    const data = await loadData(db);
    if (body.username !== data.username || !await verifyPassword(body.password, data.passwordHash)) {
      return send(401, { error: "\u7528\u6237\u540D\u6216\u5BC6\u7801\u4E0D\u5BF9" });
    }
    if (data.totpEnabled && data.totpSecret) {
      if (!body.totp) return send(401, { error: "need_totp" });
      if (!await verifyTotp(data.totpSecret, body.totp)) return send(401, { error: "\u4E8C\u6B21\u9A8C\u8BC1\u5931\u8D25" });
    }
    const token = await createSession(db);
    const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
    return send(200, { ok: true, username: data.username }, {
      "Set-Cookie": `session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_MS / 1e3}${secure}`
    });
  }
  if (pathname === "/api/public" && method === "GET") {
    const data = await loadData(db);
    const unlocked = syncAchievements(data);
    if (unlocked.length) await saveData(db, data);
    const payload = metaPayload(data);
    payload.services = publicServices(data);
    return send(200, payload);
  }
  if (pathname === "/api/calendar.ics" && method === "GET") {
    const data = await loadData(db);
    const escICS = /* @__PURE__ */ __name((s) => String(s || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n"), "escICS");
    const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//HubMate//Expiry Calendar//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "X-WR-CALNAME:HubMate \u670D\u52A1\u5230\u671F\u65E5"];
    for (const s of data.services) {
      if (!s.expiresAt || !/^\d{4}-\d{2}-\d{2}$/.test(s.expiresAt)) continue;
      lines.push("BEGIN:VEVENT");
      lines.push("UID:" + s.id + "@hubmate");
      lines.push("DTSTAMP:" + stamp);
      lines.push("DTSTART;VALUE=DATE:" + s.expiresAt.replace(/-/g, ""));
      lines.push("SUMMARY:" + escICS("\u670D\u52A1\u5230\u671F\uFF1A" + s.name));
      lines.push("DESCRIPTION:" + escICS(`\u6CE8\u518C ${s.registeredAt || "\u2014"}\uFF0C\u7EED\u671F\u5468\u671F ${s.renewDays ?? 365} \u5929${s.url ? "\uFF0C" + s.url : ""}`));
      lines.push("BEGIN:VALARM", "TRIGGER:-P3D", "ACTION:DISPLAY", "DESCRIPTION:" + escICS("\u670D\u52A1\u5230\u671F\u63D0\u9192\uFF1A" + s.name), "END:VALARM");
      lines.push("BEGIN:VALARM", "TRIGGER:-P1D", "ACTION:DISPLAY", "DESCRIPTION:" + escICS("\u670D\u52A1\u5230\u671F\u63D0\u9192\uFF1A" + s.name), "END:VALARM");
      lines.push("END:VEVENT");
    }
    lines.push("END:VCALENDAR");
    return new Response(lines.join("\r\n"), {
      status: 200,
      headers: Object.assign({ "Content-Type": "text/calendar; charset=utf-8", "Cache-Control": "no-store" }, SEC_HEADERS)
    });
  }
  if (pathname === "/api/accounts/by-domain" && method === "GET") {
    if (!await currentUser(request, db) && !await isApiToken(request, db)) return send(401, { error: "\u672A\u767B\u5F55" });
    const raw = new URL(request.url).searchParams.get("domain") || "";
    const dom = raw.trim().toLowerCase().replace(/^www\./, "").replace(/:\d+$/, "");
    if (!dom || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(dom)) return send(400, { error: "\u57DF\u540D\u4E0D\u5BF9" });
    const data = await loadData(db);
    const out = [];
    for (const s of data.services) {
      let host = "";
      try {
        host = new URL(/^https?:\/\//i.test(s.url || "") ? s.url : "https://" + (s.url || "")).hostname.toLowerCase().replace(/^www\./, "");
      } catch {
        continue;
      }
      if (!host || !(host === dom || host.endsWith("." + dom))) continue;
      for (const a of serviceAccounts(s)) {
        out.push({ serviceId: s.id, serviceName: s.name, label: a.label || "", username: a.username || "", password: a.password || "", url: s.url || "" });
      }
      if (out.length >= 20) break;
    }
    return send(200, { ok: true, domain: dom, accounts: out.slice(0, 20) });
  }
  const auth = await currentUser(request, db);
  const tokenAllowed = !auth && await isApiToken(request, db) && isTokenAllowedEndpoint(pathname, method);
  if (!auth && !tokenAllowed) return send(401, { error: "\u672A\u767B\u5F55" });
  if (pathname === "/api/api-token/status" && method === "GET") {
    const data = await loadData(db);
    return send(200, { hasToken: !!data.apiToken });
  }
  if (pathname === "/api/api-token" && method === "POST") {
    const data = await loadData(db);
    data.apiToken = randomBytes(24).toString("hex");
    await saveData(db, data);
    return send(200, { ok: true, token: data.apiToken });
  }
  if (pathname === "/api/api-token/revoke" && method === "POST") {
    const data = await loadData(db);
    delete data.apiToken;
    await saveData(db, data);
    return send(200, { ok: true });
  }
  if (pathname === "/api/github-backup/status" && method === "GET") {
    const data = await loadData(db);
    const gb = data.githubBackup || {};
    return send(200, { configured: !!(gb.token && gb.repo), repo: gb.repo || "", branch: gb.branch || "main", lastAt: gb.lastAt || "", lastOk: !!gb.lastOk, lastNote: gb.lastNote || "" });
  }
  if (pathname === "/api/github-backup/save" && method === "POST") {
    const body = await jsonBody(request);
    const data = await loadData(db);
    const gb = data.githubBackup || {};
    const token = String(body.token || "").trim();
    const repo = String(body.repo || "").trim();
    if (repo && !/^[^/\s]+\/[^/\s]+$/.test(repo)) return send(400, { error: "\u4ED3\u5E93\u683C\u5F0F\u4E0D\u5BF9\uFF0C\u586B\u201C\u7528\u6237\u540D/\u4ED3\u5E93\u540D\u201D\uFF0C\u6BD4\u5982 jasonssuns-prog/hubmate-data" });
    if (token) gb.token = token;
    if (repo) gb.repo = repo;
    gb.branch = String(body.branch || "main").trim() || "main";
    data.githubBackup = gb;
    await saveData(db, data);
    return send(200, { ok: true, configured: !!(gb.token && gb.repo) });
  }
  if (pathname === "/api/github-backup/run" && method === "POST") {
    const r = await pushGithubBackup(db);
    if (!r) return send(400, { error: "\u8FD8\u6CA1\u914D\u597D Token \u6216\u4ED3\u5E93" });
    if (r.skipped) return send(200, { ok: true, skipped: true, note: "\u6570\u636E\u6CA1\u53D8\uFF0C\u4E0D\u7528\u63A8" });
    if (!r.ok) return send(400, { error: r.note || "\u5907\u4EFD\u5931\u8D25" });
    return send(200, { ok: true });
  }
  if (pathname === "/api/totp/status" && method === "GET") {
    const data = await loadData(db);
    return send(200, { enabled: !!data.totpEnabled });
  }
  if (pathname === "/api/totp/setup" && method === "POST") {
    const data = await loadData(db);
    data.totpSecret = base32Encode(randomBytes(20));
    data.totpEnabled = false;
    await saveData(db, data);
    const label = encodeURIComponent(`hubmate:${data.username || "user"}`);
    const otpauth = `otpauth://totp/${label}?secret=${data.totpSecret}&issuer=hubmate&algorithm=SHA1&digits=6&period=30`;
    return send(200, { ok: true, secret: data.totpSecret, otpauth });
  }
  if (pathname === "/api/totp/enable" && method === "POST") {
    const body = await jsonBody(request);
    const data = await loadData(db);
    if (!data.totpSecret) return send(400, { error: "\u5148\u70B9\u201C\u751F\u6210\u5BC6\u94A5\u201D" });
    if (!await verifyTotp(data.totpSecret, body.code)) return send(401, { error: "\u52A8\u6001\u7801\u4E0D\u5BF9\uFF0C\u8BF7\u5BF9\u4E00\u4E0B\u624B\u673A\u65F6\u95F4" });
    data.totpEnabled = true;
    await saveData(db, data);
    return send(200, { ok: true });
  }
  if (pathname === "/api/totp/disable" && method === "POST") {
    const body = await jsonBody(request);
    const data = await loadData(db);
    if (!await verifyPassword(body.password, data.passwordHash)) return send(401, { error: "\u5BC6\u7801\u4E0D\u5BF9" });
    if (data.totpEnabled && !await verifyTotp(data.totpSecret, body.code)) return send(401, { error: "\u52A8\u6001\u7801\u4E0D\u5BF9" });
    delete data.totpSecret;
    data.totpEnabled = false;
    await saveData(db, data);
    return send(200, { ok: true });
  }
  if (pathname === "/api/notes" && method === "GET") {
    const data = await loadData(db);
    return send(200, (data.notes || []).slice().sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || "")));
  }
  if (pathname === "/api/notes" && method === "POST") {
    const data = await loadData(db);
    const b = await jsonBody(request);
    const title = String(b.title || "").trim().slice(0, 100);
    const content = String(b.content || "").trim().slice(0, 2e4);
    if (!title && !content) return send(400, { error: "\u6807\u9898\u548C\u5185\u5BB9\u4E0D\u80FD\u90FD\u7A7A" });
    const now = cstDateTime();
    const note = { id: randomBytes(12).toString("hex"), title, content, createdAt: now, updatedAt: now };
    data.notes = data.notes || [];
    data.notes.unshift(note);
    await saveData(db, data);
    return send(200, note);
  }
  if (pathname.startsWith("/api/notes/") && (method === "PUT" || method === "DELETE")) {
    const id = decodeURIComponent(pathname.slice("/api/notes/".length));
    const data = await loadData(db);
    const note = (data.notes || []).find((n) => n.id === id);
    if (!note) return send(404, { error: "\u627E\u4E0D\u5230\u8FD9\u6761\u8BB0\u4E8B" });
    if (method === "DELETE") {
      data.notes = data.notes.filter((n) => n.id !== id);
      await saveData(db, data);
      return send(200, { ok: true });
    }
    const b = await jsonBody(request);
    const title = String(b.title || "").trim().slice(0, 100);
    const content = String(b.content || "").trim().slice(0, 2e4);
    if (!title && !content) return send(400, { error: "\u6807\u9898\u548C\u5185\u5BB9\u4E0D\u80FD\u90FD\u7A7A" });
    note.title = title;
    note.content = content;
    note.updatedAt = cstDateTime();
    await saveData(db, data);
    return send(200, note);
  }
  if (pathname === "/api/me" && method === "GET") {
    return send(200, { username: (await loadData(db)).username });
  }
  if (pathname === "/api/logout" && method === "POST") {
    await deleteSession(db, auth.token);
    const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
    return send(200, { ok: true }, { "Set-Cookie": `session=; HttpOnly; Path=/; Max-Age=0${secure}` });
  }
  if (pathname === "/api/password" && method === "POST") {
    const body = await jsonBody(request);
    const data = await loadData(db);
    if (!await verifyPassword(body.oldPassword, data.passwordHash)) return send(400, { error: "\u65E7\u5BC6\u7801\u4E0D\u5BF9" });
    if (!body.newPassword || String(body.newPassword).length < 6) return send(400, { error: "\u65B0\u5BC6\u7801\u81F3\u5C11 6 \u4F4D" });
    data.passwordHash = await hashPassword(body.newPassword);
    data.passwordIsDefault = false;
    await saveData(db, data);
    return send(200, { ok: true });
  }
  if (pathname === "/api/notify" && method === "GET") {
    const n = notifyCfg(await loadData(db));
    return send(200, {
      configured: !!(n.token && n.chatId),
      chatId: n.chatId || "",
      expiring: n.expiring !== false,
      checkin: n.checkin !== false,
      pushHour: n.pushHour === void 0 ? 9 : n.pushHour,
      repeatHours: n.repeatHours === void 0 ? 0 : n.repeatHours,
      webhookConfigured: !!n.webhookUrl,
      barkConfigured: !!n.barkKey,
      serverChanConfigured: !!n.serverChanKey,
      lastExpiring: n.lastExpiring || "",
      lastCheckin: n.lastCheckin || ""
    });
  }
  if (pathname === "/api/notify" && method === "POST") {
    const body = await jsonBody(request);
    const data = await loadData(db);
    const n = notifyCfg(data);
    if (typeof body.token === "string" && body.token.trim()) n.token = body.token.trim().slice(0, 200);
    if (typeof body.chatId === "string" && body.chatId.trim()) n.chatId = body.chatId.trim().slice(0, 64);
    if (typeof body.webhookUrl === "string" && body.webhookUrl.trim()) {
      const u = body.webhookUrl.trim().slice(0, 500);
      if (!/^https?:\/\//i.test(u)) return send(400, { error: "Webhook \u5730\u5740\u8981\u662F http(s) \u5F00\u5934" });
      n.webhookUrl = u;
    }
    if (typeof body.barkKey === "string" && body.barkKey.trim()) n.barkKey = body.barkKey.trim().slice(0, 200);
    if (typeof body.serverChanKey === "string" && body.serverChanKey.trim()) n.serverChanKey = body.serverChanKey.trim().slice(0, 200);
    if (body.expiring !== void 0) n.expiring = !!body.expiring;
    if (body.checkin !== void 0) n.checkin = !!body.checkin;
    if (body.pushHour !== void 0 && body.pushHour !== "") {
      const h = Math.trunc(Number(body.pushHour));
      if (Number.isFinite(h)) n.pushHour = Math.min(23, Math.max(0, h));
    }
    if (body.repeatHours !== void 0 && body.repeatHours !== "") {
      const rh = Math.trunc(Number(body.repeatHours));
      if (Number.isFinite(rh)) n.repeatHours = Math.min(24, Math.max(0, rh));
    }
    await saveData(db, data);
    return send(200, { ok: true, configured: !!(n.token && n.chatId) });
  }
  if (pathname === "/api/notify/test" && method === "POST") {
    const data = await loadData(db);
    const n = notifyCfg(data);
    const hasAny = n.token && n.chatId || n.webhookUrl || n.barkKey || n.serverChanKey;
    if (!hasAny) return send(400, { error: "\u8FD8\u6CA1\u8BBE\u7F6E\u4EFB\u4F55\u901A\u77E5\u6E20\u9053\uFF08Telegram / Webhook / Bark / Server\u9171\uFF09" });
    const t = todayStr();
    const cohort = checkinCohort(data, t);
    const done = cohort.filter((s) => (s.checkins || []).includes(t)).length;
    const items = expiringList(data);
    const todo = unsignedDaily(data, t);
    const expPreview = items.length ? `\u23F0 <b>\u4E34\u671F\u9884\u89C8</b>\uFF08${items.length} \u4E2A\uFF09\uFF1A
${expiringLines(items).join("\n")}` : "\u23F0 <b>\u4E34\u671F\u9884\u89C8</b>\uFF1A30 \u5929\u5185\u6682\u65E0\u4E34\u671F\u670D\u52A1";
    const ckPreview = todo.length ? `\u26A1 <b>\u7B7E\u5230\u9884\u89C8</b>\uFF08${todo.length} \u4E2A\u672A\u7B7E\uFF09\uFF1A
${checkinLines(todo).join("\n")}` : "\u26A1 <b>\u7B7E\u5230\u9884\u89C8</b>\uFF1A\u4ECA\u65E5\u5DF2\u5168\u90E8\u7B7E\u5230";
    const html = `\u2705 <b>\u670D\u52A1\u53F0\u901A\u77E5\u6D4B\u8BD5\u6210\u529F</b> \xB7 ${t}
\u4ECA\u65E5\u7B7E\u5230 ${done}/${cohort.length} \xB7 30 \u5929\u5185\u4E34\u671F ${items.length} \u4E2A

${expPreview}

${ckPreview}

\u4E0A\u9762\u5C31\u662F\u6BCF\u5929\u65E9\u4E0A\u4F1A\u6536\u5230\u7684\u63D0\u9192\u7248\u5F0F\u3002${todo.length ? "\uFF08Telegram \u4E0B\u9762\u8FD9\u4E2A\u6309\u94AE\u662F\u771F\u7684\uFF0C\u70B9\u4E00\u4E0B\u5C31\u7B7E\u5B8C\u4E86\u3002\uFF09" : ""}`;
    const r = await sendMultiChannel(n, `\u670D\u52A1\u53F0\u901A\u77E5\u6D4B\u8BD5 \xB7 ${t}`, html, todo.length ? CHECKIN_KB : void 0);
    if (!r.ok) return send(400, { error: "\u5168\u90E8\u6E20\u9053\u90FD\u53D1\u9001\u5931\u8D25", channels: r.results });
    return send(200, { ok: true, channels: r.results });
  }
  if (pathname === "/api/linkcheck" && method === "POST") {
    const r = await checkLinks(db);
    if (!r) return send(400, { error: "\u68C0\u6D4B\u5931\u8D25" });
    return send(200, r);
  }
  if (pathname === "/api/auto-signin/run" && method === "POST") {
    const r = await runAutoSignins(db);
    if (!r) return send(400, { error: "\u81EA\u52A8\u7B7E\u5230\u5931\u8D25" });
    return send(200, { ok: true, results: r });
  }
  if (pathname === "/api/auto-signin/test" && method === "POST") {
    const body = await jsonBody(request);
    const cfg = sanitizeAutoSignin(body.autoSignin || body);
    if (!cfg) return send(400, { error: "\u81EA\u52A8\u7B7E\u5230\u6CA1\u914D\u597D\uFF1A\u7F51\u5740\u8981\u662F http(s) \u5F00\u5934" });
    const r = await tryAutoSignin(null, cfg);
    return send(200, { ok: r.ok, status: r.status, note: r.note || "" });
  }
  if (pathname === "/api/categories" && method === "POST") {
    const body = await jsonBody(request);
    const data = await loadData(db);
    const cats = ensureCategories(data);
    const label = String(body.label || "").trim().slice(0, 20);
    if (!label) return send(400, { error: "\u5206\u7C7B\u540D\u4E0D\u80FD\u4E3A\u7A7A" });
    if (cats.some((c) => c.label.toLowerCase() === label.toLowerCase())) return send(400, { error: "\u5DF2\u7ECF\u6709\u540C\u540D\u5206\u7C7B\u4E86" });
    const cat = { id: "c" + randomBytes(4).toString("hex"), label, icon: cleanIcon(body.icon), cls: "t-custom" };
    cats.push(cat);
    await saveData(db, data);
    return send(200, { ok: true, category: cat });
  }
  const cm = pathname.match(/^\/api\/categories\/([A-Za-z0-9_-]+)$/);
  if (cm && method === "PUT") {
    const body = await jsonBody(request);
    const data = await loadData(db);
    const cats = ensureCategories(data);
    const cat = cats.find((c) => c.id === cm[1]);
    if (!cat) return send(404, { error: "\u627E\u4E0D\u5230\u8BE5\u5206\u7C7B" });
    const label = String(body.label || "").trim().slice(0, 20);
    if (!label) return send(400, { error: "\u5206\u7C7B\u540D\u4E0D\u80FD\u4E3A\u7A7A" });
    if (cats.some((c) => c.id !== cat.id && c.label.toLowerCase() === label.toLowerCase())) return send(400, { error: "\u5DF2\u7ECF\u6709\u540C\u540D\u5206\u7C7B\u4E86" });
    cat.label = label;
    if (body.icon !== void 0) cat.icon = cleanIcon(body.icon);
    await saveData(db, data);
    return send(200, { ok: true, category: cat });
  }
  if (cm && method === "DELETE") {
    if (BUILTIN_CATS.has(cm[1])) return send(400, { error: "\u7CFB\u7EDF\u5206\u7C7B\u4E0D\u80FD\u5220\u9664" });
    const data = await loadData(db);
    const cats = ensureCategories(data);
    const idx = cats.findIndex((c) => c.id === cm[1]);
    if (idx < 0) return send(404, { error: "\u627E\u4E0D\u5230\u8BE5\u5206\u7C7B" });
    const used = data.services.filter((s) => s.category === cm[1]).length;
    if (used) return send(400, { error: `\u8BE5\u5206\u7C7B\u4E0B\u8FD8\u6709 ${used} \u4E2A\u670D\u52A1\uFF0C\u8BF7\u5148\u628A\u5B83\u4EEC\u7F16\u8F91\u5230\u5176\u4ED6\u5206\u7C7B\u540E\u518D\u5220\u9664` });
    cats.splice(idx, 1);
    await saveData(db, data);
    return send(200, { ok: true });
  }
  if (pathname === "/api/notify/resolve" && method === "POST") {
    const data = await loadData(db);
    const n = notifyCfg(data);
    if (!n.token) return send(400, { error: "\u8BF7\u5148\u4FDD\u5B58 Token" });
    try {
      const res = await fetch(tgApiUrl(n.token, "getUpdates"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}"
      });
      const j = await res.json().catch(() => ({}));
      if (!j.ok) throw new Error(j.description || "Telegram \u8FD4\u56DE\u9519\u8BEF");
      const updates = (j.result || []).filter((u) => u.message && u.message.chat && u.message.chat.id);
      if (!updates.length) return send(400, { error: "\u6CA1\u627E\u5230\u6D88\u606F\uFF0C\u8BF7\u5148\u7ED9\u673A\u5668\u4EBA\u53D1\u4E00\u6761 /start \u518D\u8BD5" });
      n.chatId = String(updates[updates.length - 1].message.chat.id);
      await saveData(db, data);
      return send(200, { ok: true, chatId: n.chatId });
    } catch (e) {
      return send(400, { error: `\u83B7\u53D6\u5931\u8D25\uFF1A${e.message}` });
    }
  }
  if (pathname === "/api/export-md" && method === "POST") {
    const data = await loadData(db);
    const md = ledgerMarkdown(data, new URL(request.url).origin);
    return new Response(md, {
      status: 200,
      headers: Object.assign({
        "Content-Type": "text/markdown; charset=utf-8",
        /* filename 含中文会触发 Fetch 规范的 TypeError；用 RFC 5987 的 filename*（UTF-8 百分号编码）+ ASCII 兜底 */
        "Content-Disposition": `attachment; filename="ledger.md"; filename*=UTF-8''${encodeURIComponent("\u670D\u52A1\u53F0\u8D26.md")}`,
        "Cache-Control": "no-store"
      }, SEC_HEADERS)
    });
  }
  if (pathname === "/api/backup" && method === "GET") {
    const data = await loadData(db);
    const out = strippedBackupData(data);
    const fname = `service-hub-backup-${todayStr()}.json`;
    return new Response(JSON.stringify(out, null, 2), {
      status: 200,
      headers: Object.assign({
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${fname}"`,
        "Cache-Control": "no-store"
      }, SEC_HEADERS)
    });
  }
  if (pathname === "/api/backup" && method === "POST") {
    const body = await jsonBody(request);
    const imp = body && body.data ? body.data : body;
    if (!imp || !Array.isArray(imp.services)) return send(400, { error: "\u5907\u4EFD\u6587\u4EF6\u4E0D\u5BF9\uFF1A\u91CC\u9762\u6CA1\u6709\u670D\u52A1\u5217\u8868" });
    for (const s of imp.services) {
      if (!s || typeof s.id !== "string" || typeof s.name !== "string" || !s.name.trim()) {
        return send(400, { error: "\u5907\u4EFD\u6587\u4EF6\u4E0D\u5BF9\uFF1A\u6709\u670D\u52A1\u7F3A\u540D\u5B57\u6216\u7F16\u53F7" });
      }
    }
    const data = await loadData(db);
    await db.prepare("INSERT INTO backups (createdAt, data) VALUES (?, ?)").bind(cstDateTime(), JSON.stringify(strippedBackupData(data))).run();
    await db.prepare("DELETE FROM backups WHERE id NOT IN (SELECT id FROM backups ORDER BY id DESC LIMIT 5)").run();
    const cats = Array.isArray(imp.categories) && imp.categories.length ? imp.categories.filter((c) => c && typeof c.id === "string" && typeof c.label === "string" && c.label.trim()) : categoriesOf(data);
    const catIds = new Set(cats.map((c) => c.id));
    const seen = /* @__PURE__ */ new Set();
    data.services = imp.services.filter((s) => {
      if (seen.has(String(s.id))) return false;
      seen.add(String(s.id));
      return true;
    }).map((s) => ({
      id: String(s.id),
      name: String(s.name).slice(0, 100),
      category: catIds.has(s.category) ? s.category : "relay",
      url: String(s.url || "").slice(0, 500),
      account: String(s.account || "").slice(0, 500),
      secret: String(s.secret || "").slice(0, 500),
      price: String(s.price || "").slice(0, 500),
      notes: String(s.notes || "").slice(0, 500),
      registeredAt: String(s.registeredAt || ""),
      expiresAt: String(s.expiresAt || ""),
      checkinFrequency: s.checkinFrequency === "daily" ? "daily" : "none",
      checkinEveryDays: clampInt(s.checkinEveryDays, 1, 365, 1),
      renewDays: clampInt(s.renewDays, 1, 3650, 365),
      favorite: !!s.favorite,
      abnormal: !!s.abnormal,
      accounts: (Array.isArray(s.accounts) ? s.accounts : []).map(sanitizeAccount).filter(Boolean).slice(0, 20),
      checkins: Array.isArray(s.checkins) ? s.checkins.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)) : [],
      visits: Number(s.visits) || 0,
      sortOrder: Number(s.sortOrder) || 0,
      linkStatus: s.linkStatus,
      linkHistory: (Array.isArray(s.linkHistory) ? s.linkHistory : []).filter((h) => h && typeof h.t === "number" && typeof h.ok === "boolean").slice(-120),
      renewHistory: (Array.isArray(s.renewHistory) ? s.renewHistory : []).filter((h) => h && /^\d{4}-\d{2}-\d{2}$/.test(h.at || "") && typeof h.from === "string" && typeof h.to === "string").slice(-20),
      tags: (Array.isArray(s.tags) ? s.tags : []).map((t) => String(t).trim().slice(0, 20)).filter(Boolean).slice(0, 10),
      customFields: sanitizeCustomFields(s.customFields),
      autoSignin: sanitizeAutoSignin(s.autoSignin),
      autoSigninLast: s.autoSigninLast && typeof s.autoSigninLast === "object" ? { at: String(s.autoSigninLast.at || "").slice(0, 30), ok: !!s.autoSigninLast.ok, status: Number(s.autoSigninLast.status) || 0, note: String(s.autoSigninLast.note || "").slice(0, 200) } : void 0
    }));
    data.services.forEach(normalizeAccounts);
    data.categories = cats.map((c) => ({ id: c.id, label: String(c.label).slice(0, 20), icon: cleanIcon(c.icon), cls: c.cls || "t-custom" }));
    if (imp.history && typeof imp.history === "object") data.history = imp.history;
    if (imp.achievements && typeof imp.achievements === "object") data.achievements = imp.achievements;
    if (Number(imp.xp) >= 0) data.xp = Number(imp.xp);
    if (imp.flags && typeof imp.flags === "object") data.flags = imp.flags;
    if (imp.notify && typeof imp.notify === "object") {
      const n = notifyCfg(data);
      const keep = { token: n.token, webhookUrl: n.webhookUrl, barkKey: n.barkKey, serverChanKey: n.serverChanKey };
      Object.assign(n, imp.notify);
      for (const k of ["token", "webhookUrl", "barkKey", "serverChanKey"]) {
        if (keep[k]) n[k] = keep[k];
        else delete n[k];
      }
    }
    await saveData(db, data);
    return send(200, { ok: true, services: data.services.length });
  }
  if (pathname === "/api/meta" && method === "GET") {
    const data = await loadData(db);
    const unlocked = syncAchievements(data);
    if (unlocked.length) await saveData(db, data);
    return send(200, metaPayload(data));
  }
  if (pathname === "/api/services" && method === "GET") {
    return send(200, (await loadData(db)).services);
  }
  if (pathname === "/api/services" && method === "POST") {
    const data = await loadData(db);
    const f = pickFields(await jsonBody(request), null, categoriesOf(data).map((c) => c.id));
    if (!f.name) return send(400, { error: "\u540D\u79F0\u5FC5\u586B" });
    const svc = Object.assign({
      id: randomBytes(12).toString("hex"),
      category: "relay",
      url: "",
      account: "",
      secret: "",
      price: "",
      notes: "",
      registeredAt: todayStr(),
      expiresAt: "",
      checkinFrequency: "none",
      checkinEveryDays: 1,
      renewDays: 365,
      checkins: [],
      visits: 0,
      sortOrder: Math.min(0, ...data.services.map((s) => s.sortOrder ?? 0)) - 1
    }, f);
    data.services.push(svc);
    data.xp += 10;
    const unlocked = syncAchievements(data);
    await saveData(db, data);
    return send(200, { ...svc, xpGained: 10, unlocked });
  }
  if (pathname === "/api/services/import" && method === "POST") {
    const body = await jsonBody(request);
    const rows = Array.isArray(body.services) ? body.services : [];
    if (!rows.length) return send(400, { error: "\u6CA1\u6709\u53EF\u5BFC\u5165\u7684\u670D\u52A1" });
    if (rows.length > 500) return send(400, { error: "\u4E00\u6B21\u6700\u591A\u5BFC\u5165 500 \u4E2A" });
    const data = await loadData(db);
    const catIds = categoriesOf(data).map((c) => c.id);
    let maxOrder = data.services.reduce((m2, s) => Math.max(m2, s.sortOrder ?? 0), 0);
    let imported = 0;
    for (const r of rows) {
      const f = pickFields(r || {}, null, catIds);
      if (!f.name) continue;
      const svc = Object.assign({
        id: randomBytes(12).toString("hex"),
        category: "relay",
        url: "",
        account: "",
        secret: "",
        price: "",
        notes: "",
        registeredAt: todayStr(),
        expiresAt: "",
        checkinFrequency: "none",
        checkinEveryDays: 1,
        renewDays: 365,
        checkins: [],
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
  if (pathname === "/api/services/import-bookmarks" && method === "POST") {
    const body = await jsonBody(request);
    const rows = Array.isArray(body.services) ? body.services : [];
    if (!rows.length) return send(400, { error: "\u6CA1\u6709\u53EF\u5BFC\u5165\u7684\u4E66\u7B7E" });
    if (rows.length > 500) return send(400, { error: "\u4E00\u6B21\u6700\u591A\u5BFC\u5165 500 \u4E2A" });
    const normUrl = /* @__PURE__ */ __name((u) => String(u || "").trim().toLowerCase().replace(/\/+$/, ""), "normUrl");
    const data = await loadData(db);
    const catIds = categoriesOf(data).map((c) => c.id);
    const seenUrls = new Set(data.services.map((s) => normUrl(s.url)).filter(Boolean));
    let maxOrder = data.services.reduce((m2, s) => Math.max(m2, s.sortOrder ?? 0), 0);
    let imported = 0, dupes = 0;
    for (const r of rows) {
      const f = pickFields(r || {}, null, catIds);
      if (!f.name) continue;
      const nu = normUrl(f.url);
      if (nu && seenUrls.has(nu)) {
        dupes++;
        continue;
      }
      const svc = Object.assign({
        id: randomBytes(12).toString("hex"),
        category: "relay",
        url: "",
        account: "",
        secret: "",
        price: "",
        notes: "",
        registeredAt: todayStr(),
        expiresAt: "",
        checkinFrequency: "none",
        checkinEveryDays: 1,
        renewDays: 365,
        checkins: [],
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
  if (pathname === "/api/services/import-accounts" && method === "POST") {
    const body = await jsonBody(request);
    const rows = Array.isArray(body.accounts) ? body.accounts : [];
    if (!rows.length) return send(400, { error: "\u6CA1\u6709\u53EF\u5BFC\u5165\u7684\u8D26\u53F7" });
    if (rows.length > 500) return send(400, { error: "\u4E00\u6B21\u6700\u591A\u5BFC\u5165 500 \u4E2A" });
    const data = await loadData(db);
    const byName = /* @__PURE__ */ new Map();
    for (const s of data.services) {
      const key = String(s.name || "").trim().toLowerCase();
      if (key && !byName.has(key)) byName.set(key, s);
    }
    let imported = 0, dupes = 0, missingRows = 0;
    const missing = [];
    const missingSeen = /* @__PURE__ */ new Set();
    for (const r of rows) {
      if (!r || typeof r !== "object") continue;
      const svcName = String(r.service || "").trim();
      const svc = svcName ? byName.get(svcName.toLowerCase()) : null;
      if (!svc) {
        missingRows++;
        if (svcName && !missingSeen.has(svcName)) {
          missingSeen.add(svcName);
          missing.push(svcName);
        }
        continue;
      }
      const acc = sanitizeAccount({
        label: r.label,
        username: r.username,
        password: r.password,
        notes: r.notes
      });
      if (!acc || !acc.username) continue;
      normalizeAccounts(svc);
      if (svc.accounts.some((a) => String(a.username || "").trim().toLowerCase() === acc.username.toLowerCase())) {
        dupes++;
        continue;
      }
      acc.isDefault = svc.accounts.length === 0;
      svc.accounts.push(acc);
      normalizeAccounts(svc);
      imported++;
    }
    if (imported) await saveData(db, data);
    return send(200, { ok: true, imported, skipped: rows.length - imported - dupes - missingRows, dupes, missing });
  }
  if (pathname === "/api/reorder" && method === "POST") {
    const body = await jsonBody(request);
    if (!Array.isArray(body.ids)) return send(400, { error: "\u53C2\u6570\u9519\u8BEF" });
    const data = await loadData(db);
    const pos = new Map(body.ids.map((x, i) => [String(x), i]));
    data.services.forEach((s) => {
      if (pos.has(s.id)) s.sortOrder = pos.get(s.id);
    });
    await saveData(db, data);
    return send(200, { ok: true });
  }
  if (pathname === "/api/checkins/all" && method === "POST") {
    const data = await loadData(db);
    const r = checkinAllTodayNoWrite(data);
    await saveData(db, data);
    return send(200, r);
  }
  if (pathname === "/api/services/bulk" && method === "POST") {
    const body = await jsonBody(request);
    const data = await loadData(db);
    const ids = new Set((Array.isArray(body.ids) ? body.ids : []).map(String));
    if (!ids.size) return send(400, { error: "\u6CA1\u6709\u9009\u4E2D\u670D\u52A1" });
    if (body.action === "delete") {
      const before = data.services.length;
      data.services = data.services.filter((s) => !ids.has(s.id));
      await saveData(db, data);
      return send(200, { ok: true, deleted: before - data.services.length });
    }
    if (body.action === "category") {
      const catIds = categoriesOf(data).map((c) => c.id);
      const cat = catIds.includes(body.category) ? body.category : "relay";
      let moved = 0;
      for (const s of data.services) {
        if (!ids.has(s.id)) continue;
        if (cat === "fav" && s.category !== "fav") s.favorite = true;
        s.category = cat;
        moved++;
      }
      await saveData(db, data);
      return send(200, { ok: true, moved });
    }
    if (body.action === "edit") {
      const every = body.checkinEveryDays === "" || body.checkinEveryDays == null ? null : clampInt(body.checkinEveryDays, 1, 365, null);
      const renew = body.renewDays === "" || body.renewDays == null ? null : clampInt(body.renewDays, 1, 3650, null);
      if (every === null && renew === null) return send(400, { error: "\u6CA1\u586B\u8981\u6539\u7684\u5185\u5BB9" });
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
    return send(400, { error: "\u672A\u77E5\u64CD\u4F5C" });
  }
  const m = pathname.match(/^\/api\/services\/([0-9a-f]+)(\/checkin|\/uncheckin|\/checkin-account|\/uncheckin-account|\/visit|\/undo-renew|\/renew|\/move|\/duplicate)?$/);
  if (m) {
    const data = await loadData(db);
    const idx = data.services.findIndex((s) => s.id === m[1]);
    if (idx < 0) return send(404, { error: "\u627E\u4E0D\u5230\u8BE5\u670D\u52A1" });
    const svc = data.services[idx];
    const t = todayStr();
    if (method === "POST" && m[2] === "/visit") {
      svc.visits = (svc.visits || 0) + 1;
      await saveData(db, data);
      return send(200, { ok: true, visits: svc.visits });
    }
    if (method === "POST" && m[2] === "/checkin") {
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
        ok: true,
        checkins: svc.checkins,
        accounts: svc.accounts,
        xpGained,
        allDone,
        unlocked,
        xp: data.xp,
        level: levelOf(data.xp)
      });
    }
    if (method === "POST" && m[2] === "/checkin-account") {
      const body = await jsonBody(request);
      const acc = serviceAccounts(svc).find((a) => a.id === String(body.accountId || ""));
      if (!acc) return send(404, { error: "\u627E\u4E0D\u5230\u8BE5\u8D26\u53F7" });
      let xpGained = doCheckinAccount(data, svc, acc, t);
      const { allDone, bonus } = allDoneBonus(data, t);
      xpGained += bonus;
      data.xp += xpGained;
      const unlocked = syncAchievements(data);
      await saveData(db, data);
      return send(200, {
        ok: true,
        checkins: svc.checkins,
        accounts: svc.accounts,
        xpGained,
        allDone,
        unlocked,
        xp: data.xp,
        level: levelOf(data.xp)
      });
    }
    if (method === "POST" && m[2] === "/uncheckin-account") {
      const body = await jsonBody(request);
      const acc = serviceAccounts(svc).find((a) => a.id === String(body.accountId || ""));
      if (!acc) return send(404, { error: "\u627E\u4E0D\u5230\u8BE5\u8D26\u53F7" });
      doUncheckinAccount(data, svc, acc, t);
      await saveData(db, data);
      return send(200, { ok: true, checkins: svc.checkins, accounts: svc.accounts });
    }
    if (method === "POST" && m[2] === "/renew") {
      const cur = svc.expiresAt && /^\d{4}-\d{2}-\d{2}$/.test(svc.expiresAt) ? svc.expiresAt : t;
      const base = cur < t ? t : cur;
      const days = renewEvery(svc);
      svc.prevRenew = { expiresAt: svc.expiresAt || "", registeredAt: svc.registeredAt || "" };
      delete svc.prevExpiresAt;
      svc.renewHistory = (Array.isArray(svc.renewHistory) ? svc.renewHistory : []).filter((h) => h && /^\d{4}-\d{2}-\d{2}$/.test(h.at || ""));
      const newExpires = days === 365 ? addYear(base) : addDays(base, days);
      svc.renewHistory.push({ at: t, from: svc.expiresAt || "", to: newExpires });
      if (svc.renewHistory.length > 20) svc.renewHistory = svc.renewHistory.slice(-20);
      svc.registeredAt = base;
      svc.expiresAt = newExpires;
      await saveData(db, data);
      return send(200, { ok: true, expiresAt: svc.expiresAt });
    }
    if (method === "POST" && m[2] === "/undo-renew") {
      const snap = svc.prevRenew || (svc.prevExpiresAt ? { expiresAt: svc.prevExpiresAt, registeredAt: svc.registeredAt } : null);
      if (!snap) return send(400, { error: "\u6CA1\u6709\u53EF\u64A4\u56DE\u7684\u7EED\u671F" });
      if (Array.isArray(svc.renewHistory) && svc.renewHistory.length) {
        const last = svc.renewHistory[svc.renewHistory.length - 1];
        if (last && last.to === svc.expiresAt) svc.renewHistory.pop();
      }
      svc.expiresAt = snap.expiresAt || "";
      if (typeof snap.registeredAt === "string") svc.registeredAt = snap.registeredAt;
      delete svc.prevRenew;
      delete svc.prevExpiresAt;
      await saveData(db, data);
      return send(200, { ok: true, expiresAt: svc.expiresAt });
    }
    if (method === "POST" && m[2] === "/move") {
      const body = await jsonBody(request);
      const dir = body.dir === "down" ? 1 : -1;
      const group = data.services.filter((s) => s.category === svc.category).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
      const i = group.findIndex((s) => s.id === svc.id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= group.length) return send(200, { ok: true, moved: false });
      const tmp = group[i].sortOrder;
      group[i].sortOrder = group[j].sortOrder;
      group[j].sortOrder = tmp;
      await saveData(db, data);
      return send(200, { ok: true, moved: true });
    }
    if (method === "POST" && m[2] === "/duplicate") {
      const maxOrder = data.services.filter((s) => s.category === svc.category).reduce((n, s) => Math.max(n, s.sortOrder ?? 0), 0);
      const copy = {
        ...svc,
        id: randomBytes(6).toString("hex"),
        name: (svc.name || "\u670D\u52A1").slice(0, 96) + " \u526F\u672C",
        checkins: [],
        visits: 0,
        sortOrder: maxOrder + 1,
        linkStatus: void 0,
        linkCheckedAt: void 0,
        renewHistory: [],
        prevRenew: void 0,
        prevExpiresAt: void 0,
        accounts: (Array.isArray(svc.accounts) ? svc.accounts : []).map((a) => ({ ...sanitizeAccount(a), id: randomBytes(6).toString("hex"), checkins: [] }))
      };
      copy.account = copy.accounts.find((a) => a.isDefault)?.username || "";
      copy.secret = copy.accounts.find((a) => a.isDefault)?.password || "";
      data.services.push(copy);
      await saveData(db, data);
      return send(200, copy);
    }
    if (method === "POST" && m[2] === "/uncheckin") {
      const accs = serviceAccounts(svc);
      if (accs.length) {
        for (const a of accs) a.checkins = accountCheckins(a).filter((d) => d !== t);
      }
      svc.checkins = svc.checkins.filter((d) => d !== t);
      if (data.history[t]) data.history[t].c = Math.max(0, (data.history[t].c || 1) - 1);
      await saveData(db, data);
      return send(200, { ok: true, checkins: svc.checkins, accounts: svc.accounts });
    }
    if (method === "PUT" && !m[2]) {
      const body = await jsonBody(request);
      Object.assign(svc, pickFields(body, svc, categoriesOf(data).map((c) => c.id)));
      if (typeof body.expiresAt === "string" || typeof body.registeredAt === "string") {
        delete svc.prevRenew;
        delete svc.prevExpiresAt;
      }
      await saveData(db, data);
      return send(200, svc);
    }
    if (method === "DELETE" && !m[2]) {
      data.services.splice(idx, 1);
      await saveData(db, data);
      return send(200, { ok: true });
    }
  }
  return send(404, { error: "\u63A5\u53E3\u4E0D\u5B58\u5728" });
}
__name(handleAPI, "handleAPI");
var worker_default = {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const { pathname } = url;
      if (pathname.startsWith("/api/")) {
        return await handleAPI(request, env, pathname);
      }
      return new Response("404 Not Found", {
        status: 404,
        headers: Object.assign({ "Content-Type": "text/plain; charset=utf-8" }, SEC_HEADERS)
      });
    } catch (e) {
      console.error("[!] \u8BF7\u6C42\u5904\u7406\u5F02\u5E38:", e);
      try {
        return jsonResponse(500, { error: "\u670D\u52A1\u5668\u9519\u8BEF" });
      } catch {
        return new Response("\u670D\u52A1\u5668\u9519\u8BEF", { status: 500 });
      }
    }
  },
  /* 定时任务：按 wrangler.toml 里的 Cron 表达式分发（每分钟 TG 轮询、每小时提醒+
     自动签到、每 6 小时死链检测、每天 04:00 UTC GitHub 备份） */
  async scheduled(event, env, ctx) {
    const db = env.DB;
    try {
      if (event.cron === "* * * * *") {
        ctx.waitUntil(pollBotCommands(db));
      } else if (event.cron === "0 * * * *") {
        ctx.waitUntil((async () => {
          await runNotifyChecks(db);
          await runAutoSignins(db);
        })());
      } else if (event.cron === "0 */6 * * *") {
        ctx.waitUntil(checkLinks(db));
      } else if (event.cron === "0 4 * * *") {
        ctx.waitUntil(pushGithubBackup(db));
      }
    } catch (e) {
      console.error("[!] \u5B9A\u65F6\u4EFB\u52A1\u5F02\u5E38:", e.message);
    }
  }
};

// ../../.npm/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../../.npm/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    const body = JSON.stringify(error);
    const headers = {
      "Content-Type": "application/json",
      "MF-Experimental-Error-Stack": "true"
    };
    const encoded = encodeURIComponent(body);
    if (encoded.length <= 8192) {
      headers["MF-Experimental-Error-Stack-Payload"] = encoded;
    }
    return new Response(body, { status: 500, headers });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-GrxvPw/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = worker_default;

// ../../.npm/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-GrxvPw/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=worker.js.map
