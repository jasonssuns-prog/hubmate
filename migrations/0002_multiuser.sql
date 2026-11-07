-- HubMate Workers 原生版 —— D1 多用户（v67，0002_multiuser）
-- 用法：
--   本地：npx wrangler d1 migrations apply DB --local
--   远端：npx wrangler d1 migrations apply DB --remote
-- 注意：Worker 首次收到请求时也会自动执行同一份 DDL（见 src/worker.js 的
-- ensureSchema），所以 Deploy to Cloudflare 一键部署后不用手动建表也能用；
-- 这个 migration 文件是给 wrangler 工作流和文档准备的，两边内容要保持一致。
--
-- 多用户模型（v67）：
--   users：账号（用户名唯一；isAdmin=1 的是第一个默认用户，唯一能建邀请码、
--     管用户、配 GitHub 备份的账号；banned=1 的登录时拒绝）。
--   invite_codes：邀请码（HUB-XXXX-XXXX-XXXX，只能用一次；usedBy/usedAt
--     记谁用了、什么时候用的）。
--   services / notes / sessions：各加 userId 列，按用户隔离。
--   per-user 配置（经验/成就/分类/通知/共享账号库/月度报告/归档记录/登录历史）
--   存在 meta 表里，键名前缀 u:<userId>:；GitHub 备份配置是全局的，仍用
--   不带前缀的 githubBackup 键。
-- 旧库迁移：Worker 首次收到请求时自动做（src/worker.js 的 ensureUsers）——
--   旧版单用户库的唯一用户升成管理员，全部业务数据归他；全新安装则建默认
--   管理员 jason/jason123 + 两条示例数据。

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  passwordHash TEXT NOT NULL,
  passwordIsDefault INTEGER NOT NULL DEFAULT 1,
  isAdmin INTEGER NOT NULL DEFAULT 0,
  banned INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL DEFAULT '',
  lastLoginAt TEXT NOT NULL DEFAULT '',
  totpSecret TEXT NOT NULL DEFAULT '',
  totpEnabled INTEGER NOT NULL DEFAULT 0,
  apiToken TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS invite_codes (
  code TEXT PRIMARY KEY,
  createdAt TEXT NOT NULL DEFAULT '',
  usedBy TEXT NOT NULL DEFAULT '',
  usedAt TEXT NOT NULL DEFAULT ''
);

ALTER TABLE services ADD COLUMN userId TEXT NOT NULL DEFAULT '';
ALTER TABLE notes ADD COLUMN userId TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN userId TEXT NOT NULL DEFAULT '';
