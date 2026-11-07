#!/usr/bin/env node
/* HubMate —— 把 Node 版 data.json 导进 Workers 的 D1（v67 多用户版）
   用法：
     node tools/migrate-to-d1.mjs /path/to/data.json > migration-data.sql
     npx wrangler d1 execute hubmate --local  --file=migration-data.sql   # 先在本地试
     npx wrangler d1 execute hubmate --remote --file=migration-data.sql   # 再导到线上
   只跑一次，导进一个刚建好表（已跑过 migrations/0001_init.sql +
   migrations/0002_multiuser.sql）的空 D1。
   数据来源：线上 Node 版的 /opt/service-hub/data/data.json，或一份完整备份。
   不要用 /api/backup 导出的文件：它已经去掉了密码哈希和各种 Token，
   用它迁移会丢登录密码以外的配置（Telegram Token、API 令牌、二次验证密钥）。

   两种输入都认：
   (1) 旧版单用户 data.json（顶层就是 services/notes/username/passwordHash…）：
       唯一的那个用户升成管理员（isAdmin=1），全部业务数据归他。
   (2) 新版多用户 data.json（v67）：
       {
         "users": [{ "id", "username", "passwordHash", "passwordIsDefault",
                     "isAdmin", "banned", "createdAt", "lastLoginAt",
                     "totpSecret", "totpEnabled", "apiToken" }, ...],
         "userData": { "<userId>": { "services": [...], "notes": [...],
                       "xp", "achievements", "flags", "history", "categories",
                       "notify", "sharedAccounts", "monthlyReports",
                       "archivedLog", "loginHistory" } },
         "inviteCodes": [{ "code", "createdAt", "usedBy", "usedAt" }, ...],
         "githubBackup": { ... }
       }
       （users 里也可以直接带 services/notes 数组，脚本同样认。）

   ⚠️ 密码会重置：Node 版的密码哈希是 scrypt，Workers 免费套餐每请求只有 10ms
   CPU，同步 scrypt 验不过（会报 Error 1102），所以迁移脚本不搬旧密码哈希，
   而是把密码设成默认 jason123（PBKDF2 哈希），passwordIsDefault=true。
   迁移后第一次登录用原来的用户名 / jason123，登录后立即点右上角「改密码」换掉。
   如果 data.json 里已经是 Workers 版的 pbkdf2: 哈希，就原样保留，不重置。 */
import fs from 'node:fs';
import crypto from 'node:crypto';

const file = process.argv[2];
if (!file) {
  console.error('用法：node tools/migrate-to-d1.mjs /path/to/data.json > migration-data.sql');
  process.exit(1);
}
const data = JSON.parse(fs.readFileSync(file, 'utf8'));

const esc = (v) => String(v).replace(/'/g, "''");
const sqlVal = (v) => `'${esc(typeof v === 'string' ? v : JSON.stringify(v))}'`;
const out = [];
out.push('-- HubMate data.json → D1 迁移（v67 多用户，生成时间 ' + new Date().toISOString() + '）');
out.push('-- 用法：npx wrangler d1 execute hubmate --file=migration-data.sql（先 --local 试，再 --remote）');
out.push('-- 注意：本文件只含 INSERT OR REPLACE，跑进空 D1；密码已重置为默认 jason123，首次登录后请立即改密码。');

/* 密码：只认 Workers 的 pbkdf2: 格式；旧 scrypt 哈希或缺失都重置为默认 jason123 */
function pbkdf2OrDefault(hash, username) {
  if (typeof hash === 'string' && hash.startsWith('pbkdf2:')) return { hash, isDefault: undefined };
  const salt = crypto.randomBytes(16);
  const h = crypto.pbkdf2Sync('jason123', salt, 100000, 32, 'sha256');
  console.error(`[!] 用户 ${username} 的密码已重置为默认 jason123（旧 scrypt 哈希无法在 Workers 里验），首次登录后请立即改密码。`);
  return { hash: `pbkdf2:${salt.toString('hex')}:${h.toString('hex')}`, isDefault: true };
}

const USER_META = ['xp', 'achievements', 'flags', 'history', 'categories', 'notify', 'sharedAccounts', 'monthlyReports', 'archivedLog', 'loginHistory'];
function userMetaEntries(uid, src) {
  const entries = [];
  for (const k of USER_META) {
    if (src[k] === undefined) continue;
    let v = src[k];
    if (k === 'xp') v = String(v || 0);
    else if (k === 'monthlyReports') v = JSON.stringify(Array.isArray(v) ? v.slice(-12) : []);
    else if (k === 'archivedLog' || k === 'loginHistory') v = JSON.stringify(Array.isArray(v) ? v.slice(-50) : []);
    else v = JSON.stringify(v);
    entries.push([`u:${uid}:${k}`, v]);
  }
  return entries;
}

const meta = [];
const userRows = [];
const svcRows = [];
const noteRows = [];
const inviteRows = [];
let svcCount = 0, noteCount = 0;

function addUser(u, fallback) {
  const id = String(u.id || fallback);
  const username = String(u.username || 'jason');
  const pw = pbkdf2OrDefault(u.passwordHash, username);
  const isDefault = pw.isDefault !== undefined ? pw.isDefault : (u.passwordIsDefault !== false);
  userRows.push([id, username, pw.hash, isDefault ? 1 : 0, u.isAdmin ? 1 : 0, u.banned ? 1 : 0,
    String(u.createdAt || ''), String(u.lastLoginAt || ''),
    String(u.totpSecret || ''), u.totpEnabled ? 1 : 0, String(u.apiToken || '')]);
  return id;
}
function addUserData(uid, src) {
  for (const [k, v] of userMetaEntries(uid, src || {})) meta.push([k, v]);
  const svcs = Array.isArray(src.services) ? src.services : [];
  for (const s of svcs) svcRows.push([String(s.id), JSON.stringify(s), uid]);
  svcCount += svcs.length;
  const notes = Array.isArray(src.notes) ? src.notes : [];
  for (const n of notes) noteRows.push([String(n.id), String(n.title || ''), String(n.content || ''), String(n.createdAt || ''), String(n.updatedAt || ''), uid]);
  noteCount += notes.length;
}

if (Array.isArray(data.users) && data.users.length) {
  /* 新版多用户格式 */
  const userData = (data.userData && typeof data.userData === 'object') ? data.userData : {};
  for (const u of data.users) {
    const id = addUser(u, `u${userRows.length + 1}`);
    const src = userData[id] || {};
    /* users 里直接带 services/notes 的也认 */
    if (Array.isArray(u.services)) src.services = u.services;
    if (Array.isArray(u.notes)) src.notes = u.notes;
    addUserData(id, src);
  }
  if (Array.isArray(data.inviteCodes)) {
    for (const c of data.inviteCodes) {
      if (c && typeof c.code === 'string') {
        inviteRows.push([String(c.code), String(c.createdAt || ''), String(c.usedBy || ''), String(c.usedAt || '')]);
      }
    }
  }
} else if (Array.isArray(data.services)) {
  /* 旧版单用户格式：唯一的那个用户升成管理员 */
  const adminId = 'admin-' + crypto.randomBytes(4).toString('hex');
  const username = String(data.username || 'jason');
  const pw = pbkdf2OrDefault(data.passwordHash, username);
  const isDefault = pw.isDefault !== undefined ? pw.isDefault : (data.passwordIsDefault !== false);
  userRows.push([adminId, username, pw.hash, isDefault ? 1 : 0, 1, 0, '', '',
    String(data.totpSecret || ''), data.totpEnabled ? 1 : 0, String(data.apiToken || '')]);
  addUserData(adminId, data);
} else {
  console.error('这个文件不对：里面既没有服务列表，也没有用户列表');
  process.exit(1);
}

/* 全局 GitHub 备份配置（管理员配，Token 留着——迁移用的本来就是完整数据） */
if (data.githubBackup && typeof data.githubBackup === 'object') {
  meta.push(['githubBackup', JSON.stringify(data.githubBackup)]);
}

/* users */
for (let i = 0; i < userRows.length; i += 40) {
  const part = userRows.slice(i, i + 40);
  out.push(`INSERT OR REPLACE INTO users (id, username, passwordHash, passwordIsDefault, isAdmin, banned, createdAt, lastLoginAt, totpSecret, totpEnabled, apiToken) VALUES ${part.map((r) => `(${r.map(sqlVal).join(', ')})`).join(', ')};`);
}
/* invite_codes */
for (let i = 0; i < inviteRows.length; i += 40) {
  const part = inviteRows.slice(i, i + 40);
  out.push(`INSERT OR REPLACE INTO invite_codes (code, createdAt, usedBy, usedAt) VALUES ${part.map((r) => `(${r.map(sqlVal).join(', ')})`).join(', ')};`);
}
/* meta（per-user 键 + 全局 githubBackup） */
for (let i = 0; i < meta.length; i += 40) {
  const part = meta.slice(i, i + 40);
  out.push(`INSERT OR REPLACE INTO meta (key, value) VALUES ${part.map(([k, v]) => `(${sqlVal(k)}, ${sqlVal(v)})`).join(', ')};`);
}
/* services：每服务一行整 JSON + userId */
for (let i = 0; i < svcRows.length; i += 30) {
  const part = svcRows.slice(i, i + 30);
  out.push(`INSERT OR REPLACE INTO services (id, data, userId) VALUES ${part.map(([id, js, uid]) => `(${sqlVal(id)}, ${sqlVal(js)}, ${sqlVal(uid)})`).join(', ')};`);
}
/* notes */
for (let i = 0; i < noteRows.length; i += 16) {
  const part = noteRows.slice(i, i + 16);
  out.push(`INSERT OR REPLACE INTO notes (id, title, content, createdAt, updatedAt, userId) VALUES ${part.map((r) => `(${r.map(sqlVal).join(', ')})`).join(', ')};`);
}

console.error(`[*] 共 ${userRows.length} 个用户、${svcCount} 个服务、${noteCount} 条记事、${inviteRows.length} 个邀请码、${meta.length} 个配置键。`);
console.error('[*] 先本地试：npx wrangler d1 execute hubmate --local --file=migration-data.sql');
console.log(out.join('\n'));
