#!/usr/bin/env node
/* HubMate —— 把 Node 版 data.json 导进 Workers 的 D1
   用法：
     node tools/migrate-to-d1.mjs /path/to/data.json > migration-data.sql
     npx wrangler d1 execute hubmate --local  --file=migration-data.sql   # 先在本地试
     npx wrangler d1 execute hubmate --remote --file=migration-data.sql   # 再导到线上
   只跑一次，导进一个刚建好表（已跑过 migrations/0001_init.sql）的空 D1。
   数据来源：线上 Node 版的 /opt/service-hub/data/data.json，或一份完整备份。
   不要用 /api/backup 导出的文件：它已经去掉了密码哈希和各种 Token，
   用它迁移会丢登录密码以外的配置（Telegram Token、API 令牌、二次验证密钥）。

   ⚠️ 密码会重置：Node 版的密码哈希是 scrypt，Workers 免费套餐每请求只有 10ms
   CPU，同步 scrypt 验不过（会报 Error 1102），所以迁移脚本不搬旧密码哈希，
   而是把密码设成默认 jason123（PBKDF2 哈希），passwordIsDefault=true。
   迁移后第一次登录用 jason / jason123，登录后立即点右上角「改密码」换掉。
   如果 data.json 里已经是 Workers 版的 pbkdf2: 哈希，就原样保留，不重置。 */
import fs from 'node:fs';
import crypto from 'node:crypto';

const file = process.argv[2];
if (!file) {
  console.error('用法：node tools/migrate-to-d1.mjs /path/to/data.json > migration-data.sql');
  process.exit(1);
}
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
if (!data || !Array.isArray(data.services)) {
  console.error('这个文件不对：里面没有服务列表');
  process.exit(1);
}

const esc = (v) => String(v).replace(/'/g, "''");
const sqlVal = (v) => `'${esc(typeof v === 'string' ? v : JSON.stringify(v))}'`;
const out = [];
out.push('-- HubMate data.json → D1 迁移（生成时间 ' + new Date().toISOString() + '）');
out.push('-- 用法：npx wrangler d1 execute hubmate --file=migration-data.sql（先 --local 试，再 --remote）');
out.push('-- 注意：本文件只含 INSERT OR REPLACE，跑进空 D1；密码已重置为默认 jason123，首次登录后请立即改密码。');

/* meta */
const meta = [];
meta.push(['username', String(data.username || 'jason')]);
/* 密码：只认 Workers 的 pbkdf2: 格式；旧 scrypt 哈希或缺失都重置为默认 jason123 */
if (typeof data.passwordHash === 'string' && data.passwordHash.startsWith('pbkdf2:')) {
  meta.push(['passwordHash', data.passwordHash]);
  meta.push(['passwordIsDefault', JSON.stringify(data.passwordIsDefault !== false)]);
} else {
  const salt = crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync('jason123', salt, 100000, 32, 'sha256');
  meta.push(['passwordHash', `pbkdf2:${salt.toString('hex')}:${hash.toString('hex')}`]);
  meta.push(['passwordIsDefault', 'true']);
  console.error('[!] 密码已重置为默认 jason123（旧 scrypt 哈希无法在 Workers 里验），首次登录后请立即改密码。');
}
meta.push(['xp', String(data.xp || 0)]);
meta.push(['achievements', JSON.stringify(data.achievements || {})]);
meta.push(['flags', JSON.stringify(data.flags || {})]);
meta.push(['history', JSON.stringify(data.history || {})]);
meta.push(['categories', JSON.stringify(Array.isArray(data.categories) ? data.categories : [])]);
meta.push(['notify', JSON.stringify(data.notify || {})]);
meta.push(['githubBackup', JSON.stringify(data.githubBackup || {})]);
meta.push(['totpEnabled', JSON.stringify(!!data.totpEnabled)]);
if (data.apiToken) meta.push(['apiToken', data.apiToken]);
if (data.totpSecret) meta.push(['totpSecret', data.totpSecret]);
/* 同步配置（syncToken/syncPeers/syncLast）故意不搬：Workers 是全球一份部署，不需要多服务器同步 */
for (let i = 0; i < meta.length; i += 40) {
  const part = meta.slice(i, i + 40);
  out.push(`INSERT OR REPLACE INTO meta (key, value) VALUES ${part.map(([k, v]) => `(${sqlVal(k)}, ${sqlVal(v)})`).join(', ')};`);
}

/* services：每服务一行整 JSON（accounts/tags/customFields/linkHistory/renewHistory/checkins 全在里面） */
const svcRows = data.services.map((s) => [String(s.id), JSON.stringify(s)]);
for (let i = 0; i < svcRows.length; i += 40) {
  const part = svcRows.slice(i, i + 40);
  out.push(`INSERT OR REPLACE INTO services (id, data) VALUES ${part.map(([id, js]) => `(${sqlVal(id)}, ${sqlVal(js)})`).join(', ')};`);
}

/* notes */
const notes = Array.isArray(data.notes) ? data.notes : [];
for (let i = 0; i < notes.length; i += 16) {
  const part = notes.slice(i, i + 16);
  out.push(`INSERT OR REPLACE INTO notes (id, title, content, createdAt, updatedAt) VALUES ${part.map((n) => `(${sqlVal(n.id)}, ${sqlVal(n.title || '')}, ${sqlVal(n.content || '')}, ${sqlVal(n.createdAt || '')}, ${sqlVal(n.updatedAt || '')})`).join(', ')};`);
}

console.error(`[*] 共 ${data.services.length} 个服务、${notes.length} 条记事、${meta.length} 个配置键。`);
console.error('[*] 先本地试：npx wrangler d1 execute hubmate --local --file=migration-data.sql');
console.log(out.join('\n'));
