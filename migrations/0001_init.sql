-- HubMate Workers 原生版 —— D1 建表（0001_init）
-- 用法：
--   本地：npx wrangler d1 migrations apply DB --local
--   远端：npx wrangler d1 migrations apply DB --remote
-- 注意：Worker 首次收到请求时也会自动执行同一份 DDL（见 src/worker.js 的
-- ensureSchema），所以 Deploy to Cloudflare 一键部署后不用手动建表也能用；
-- 这个 migration 文件是给 wrangler 工作流和文档准备的，两边内容要保持一致。

-- meta：单用户配置，一行一个键（对象值存 JSON 字符串）
--   username / passwordHash / passwordIsDefault / xp / apiToken /
--   totpSecret / totpEnabled / achievements / flags / history /
--   categories / notify / githubBackup
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- services：一个服务一行，整条服务 JSON（accounts / tags / customFields /
-- linkHistory / renewHistory / checkins / autoSignin 等全在里面，和 data.json
-- 里的服务对象一模一样，迁移时原样搬过来）
CREATE TABLE IF NOT EXISTS services (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL
);

-- notes：记事本（登录后才用，不进公开接口）
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  createdAt TEXT NOT NULL DEFAULT '',
  updatedAt TEXT NOT NULL DEFAULT ''
);

-- sessions：登录会话（30 天有效，过期自动清理）
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  created INTEGER NOT NULL
);

-- captchas：登录图形验证码（一次性，5 分钟过期，用完即删）
CREATE TABLE IF NOT EXISTS captchas (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  expiresAt INTEGER NOT NULL
);

-- login_throttle：登录防爆破（每 IP 10 分钟最多 10 次）
CREATE TABLE IF NOT EXISTS login_throttle (
  ip TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  resetAt INTEGER NOT NULL
);

-- backups：恢复备份前自动存的当前数据快照（只留最近 5 份）
CREATE TABLE IF NOT EXISTS backups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  createdAt TEXT NOT NULL,
  data TEXT NOT NULL
);
