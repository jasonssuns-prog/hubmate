/* v65 单元测试：服务端纯函数 + 前端纯函数（从源码抽取后跑在 Node 里）
   用法：node tests/v65.test.mjs
   退出码 0 = 全部通过；非 0 = 有失败。 */
import fs from 'node:fs';
import vm from 'node:vm';
import { randomBytes, createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';

let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  ok ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n    got:  ${g}\n    want: ${w}`); }
}
function ok(name, cond) {
  if (cond) { pass++; console.log(`  ok ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

/* ---------- 服务端纯函数：把 src/worker.js 去掉 import/export 后在 vm 里跑 ---------- */
function loadWorker() {
  let src = fs.readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
  src = src.replace(/^import \{ randomBytes, createHash \} from 'node:crypto';$/m, '');
  src = src.replace(/^import \{ Buffer \} from 'node:buffer';$/m, '');
  src = src.replace(/\nexport default \{[\s\S]*$/, '\n;globalThis.__worker = { buildMonthlyReport, uptimeInMonth, stalePasswordAccounts, sanitizeVaultAccount, resolveVaultAccounts, sanitizeAccount, parseDevice, prevMonthStr, checkCertExpiry, dayDiff, todayStr, cstDateTime, serviceAccounts };');
  const ctx = vm.createContext({
    console, crypto: globalThis.crypto, Buffer, fetch, Response, URL, AbortSignal,
    setTimeout, clearTimeout, randomBytes, createHash,
    Date, Math, JSON, Object, Array, Map, Set, Promise, Error, String, Number
  });
  vm.runInContext(src, ctx);
  return ctx.__worker;
}
const W = loadWorker();

console.log('== 服务端：buildMonthlyReport ==');
{
  // 2026-10 有 3 天签到（10-01 两次+全勤、10-02 一次、10-15 全勤），11 月 1 次不算
  const data = {
    history: {
      '2026-10-01': { c: 2, x: 5, all: true },
      '2026-10-02': { c: 1, x: 5 },
      '2026-10-15': { c: 1, all: true },
      '2026-11-01': { c: 1, x: 5 }
    },
    services: [
      { id: 'aa01', name: 'A站', registeredAt: '2026-10-05', expiresAt: '2026-10-20', checkins: ['2026-10-01', '2026-10-02', '2026-10-15'], linkHistory: [{ t: Date.UTC(2026, 9, 1, 12), ok: true }, { t: Date.UTC(2026, 9, 2, 12), ok: false }] },
      { id: 'aa02', name: 'B站', registeredAt: '2026-09-01', expiresAt: '2026-11-10', checkins: ['2026-10-01'], linkHistory: [{ t: Date.UTC(2026, 9, 1, 12), ok: true }, { t: Date.UTC(2026, 9, 2, 12), ok: true }, { t: Date.UTC(2026, 9, 3, 12), ok: true }] },
      { id: 'aa03', name: 'C站', registeredAt: '2026-10-20', expiresAt: '', checkins: [], linkHistory: [] }
    ]
  };
  const r = W.buildMonthlyReport(data, '2026-10');
  eq('月份', r.month, '2026-10');
  eq('签到天数', r.days, 3);
  eq('总签到次数', r.totalCk, 4);
  eq('签到攒的经验 (5+10 + 5 + 10)', r.xp, 30);
  eq('最常签到', r.topService, 'A站');
  eq('最常签到次数', r.topCount, 3);
  eq('新增服务数 (10-05, 10-20)', r.newServices, 2);
  eq('当月到期数', r.expiring, 1);
  eq('在线率最低', r.lowestUptime, [{ name: 'A站', rate: 50, count: 2 }, { name: 'B站', rate: 100, count: 3 }]);
  const empty = W.buildMonthlyReport({ history: {}, services: [] }, '2026-10');
  eq('空数据', [empty.days, empty.totalCk, empty.xp, empty.topService, empty.newServices, empty.expiring, empty.lowestUptime.length], [0, 0, 0, null, 0, 0, 0]);
}

console.log('== 服务端：uptimeInMonth ==');
{
  const svc = { linkHistory: [
    { t: Date.UTC(2026, 9, 1), ok: true },
    { t: Date.UTC(2026, 9, 15), ok: false },
    { t: Date.UTC(2026, 10, 1), ok: true }
  ] };
  eq('10 月 1/2', W.uptimeInMonth(svc, '2026-10'), { rate: 50, count: 2 });
  eq('11 月只有 1 条', W.uptimeInMonth(svc, '2026-11'), { rate: 100, count: 1 });
  eq('没记录返回 null', W.uptimeInMonth({ linkHistory: [] }, '2026-10'), null);
  eq('没字段返回 null', W.uptimeInMonth({}, '2026-10'), null);
}

console.log('== 服务端：stalePasswordAccounts ==');
{
  // 今天按 Beijing 2026-11-08 算（测试跑在 UTC 机器上时 todayStr() 仍是北京时间）
  const t = W.todayStr();
  const old = '2026-07-01'; // 100+ 天前
  const recent = '2026-10-20';
  const data = { services: [
    { id: 'aa01', name: 'A站', accounts: [
      { id: 'a1', label: '主号', username: 'u1', password: 'pw1', passwordChangedAt: old },
      { id: 'a2', label: '小号', username: 'u2', password: 'pw2', passwordChangedAt: recent },
      { id: 'a3', label: '老号', username: 'u3', password: 'pw3' } // 没字段 = 未知，不算
    ] }
  ] };
  const rows = W.stalePasswordAccounts(data, t);
  eq('只列出超 90 天的那一个', rows.map((r) => r.label), ['主号']);
  eq('超期天数 > 90', rows[0] && W.dayDiff(rows[0].changedAt, t) > 90, true);
}

console.log('== 服务端：sanitizeVaultAccount / resolveVaultAccounts ==');
{
  eq('空账号返回 null', W.sanitizeVaultAccount({ label: '', username: '', password: '' }), null);
  eq('非对象返回 null', W.sanitizeVaultAccount(null), null);
  const v = W.sanitizeVaultAccount({ label: '  我的邮箱  ', username: 'a@b.com', password: 'secret', notes: 'x', passwordChangedAt: '2026-11-01' });
  eq('裁剪 + 保留改密日期', [v.label, v.username, v.passwordChangedAt], ['我的邮箱', 'a@b.com', '2026-11-01']);
  const bad = W.sanitizeVaultAccount({ label: 'x', username: 'u', password: 'p', passwordChangedAt: 'not-a-date' });
  eq('非法日期被去掉', bad.passwordChangedAt, undefined);
  // 链接解析：库为准；库里删了就保留快照
  const data = {
    sharedAccounts: [{ id: 'v1', label: '库邮箱', username: 'new@x.com', password: 'newpw', notes: 'n', passwordChangedAt: '2026-11-07' }],
    services: [{ id: 'aa01', name: 'A站', accounts: [
      { id: 'a1', sharedId: 'v1', label: '旧标签', username: 'old@x.com', password: 'oldpw', notes: '', isDefault: true, checkins: ['2026-11-01'] },
      { id: 'a2', sharedId: 'v9', label: '已删的库账号', username: 'gone@x.com', password: 'gonepw', notes: '', isDefault: false, checkins: [] }
    ] }]
  };
  W.resolveVaultAccounts(data);
  const linked = data.services[0].accounts[0];
  eq('链接账号读时以库为准', [linked.username, linked.password, linked.label], ['new@x.com', 'newpw', '库邮箱']);
  eq('链接账号的签到记录不动', linked.checkins, ['2026-11-01']);
  const gone = data.services[0].accounts[1];
  eq('库里删了的账号保留快照', [gone.username, gone.password], ['gone@x.com', 'gonepw']);
}

console.log('== 服务端：sanitizeAccount 保留 sharedId / passwordChangedAt ==');
{
  const a = W.sanitizeAccount({ id: 'a1', label: '主号', username: 'u', password: 'p', sharedId: 'v1', passwordChangedAt: '2026-10-01', checkins: ['2026-11-01'] });
  eq('sharedId', a.sharedId, 'v1');
  eq('passwordChangedAt', a.passwordChangedAt, '2026-10-01');
  const b = W.sanitizeAccount({ id: 'a2', label: '号', username: 'u', password: 'p', passwordChangedAt: 'bad' });
  eq('非法日期去掉', b.passwordChangedAt, undefined);
  eq('没 sharedId 就是 undefined', b.sharedId, undefined);
}

console.log('== 服务端：parseDevice ==');
{
  eq('iPhone Safari', W.parseDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'), 'iPhone · Safari');
  eq('Windows Chrome', W.parseDevice('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'), 'Windows · Chrome');
  eq('Mac Edge', W.parseDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 Edg/120.0'), 'Mac · Edge');
  eq('空 UA', W.parseDevice(''), '未知设备');
}

console.log('== 服务端：prevMonthStr 格式 ==');
{
  ok('YYYY-MM 格式', /^\d{4}-\d{2}$/.test(W.prevMonthStr()));
}

/* ---------- 前端纯函数：从 public/app.js 抽取后跑 ---------- */
function extract(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`找不到 ${name}`);
  let i = src.indexOf('{', start), depth = 0, j = i;
  for (; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (!depth) break; }
  }
  return src.slice(start, j + 1);
}
function loadFrontend() {
  const src = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const rulesStart = src.indexOf('const CATEGORY_RULES =');
  const rulesEnd = src.indexOf('];', rulesStart) + 2;
  const pieces = [
    src.slice(rulesStart, rulesEnd),
    extract(src, 'dayDiff'),
    extract(src, 'accountSecurityScore'),
    extract(src, 'securityReasons'),
    extract(src, 'suggestCategory'),
    extract(src, 'monthlyUptime')
  ];
  const ctx = vm.createContext({
    console, Date, Math, JSON, Object, Array, Map, Set,
    todayStr: () => '2026-11-08' // 固定今天，测试才可重复
  });
  vm.runInContext(pieces.join('\n'), ctx);
  return {
    accountSecurityScore: ctx.accountSecurityScore,
    securityReasons: ctx.securityReasons,
    suggestCategory: ctx.suggestCategory,
    monthlyUptime: ctx.monthlyUptime
  };
}
const F = loadFrontend();

console.log('== 前端：accountSecurityScore ==');
{
  // 强密码：16 位、四类齐全、不复用、刚换过 = 原始分 5 → 100（和 Node 版同一口径）
  eq('强密码 100', F.accountSecurityScore({ password: 'Abc12345!@#$xyz9', passwordChangedAt: '2026-11-01' }, [{ password: 'Abc12345!@#$xyz9' }]).score, 100);
  // 短密码：5 位、只有小写 = 原始分 1 → 20
  eq('弱密码', F.accountSecurityScore({ password: 'abcde' }, [{ password: 'abcde' }]).score, 20);
  // 复用扣 3：14 位、四类齐全（原始分 5）再 -3 = 2 → 40
  eq('复用扣 3', F.accountSecurityScore({ password: 'Abcdef123456!@', passwordChangedAt: '2026-11-01' }, [{ password: 'Abcdef123456!@' }, { password: 'Abcdef123456!@' }]).score, 40);
  // 超 90 天没换扣 2：16 位四类齐全（原始分 5）再 -2 = 3 → 60
  eq('超 90 天扣 2', F.accountSecurityScore({ password: 'Abc12345!@#$xyz9', passwordChangedAt: '2026-07-01' }, [{ password: 'Abc12345!@#$xyz9' }]).score, 60);
  // 没改密日期不扣分
  eq('未知改密日期不扣', F.accountSecurityScore({ password: 'Abc12345!@#$xyz9' }, [{ password: 'Abc12345!@#$xyz9' }]).score, 100);
  // 没密码 0 分
  eq('没密码 0 分', F.accountSecurityScore({ password: '' }, []).score, 0);
  eq('弱点清单', F.securityReasons({ password: 'abcde' }, [{ password: 'abcde' }]), ['密码太短（不到 8 位）', '字符种类太少']);
  eq('复用弱点', F.securityReasons({ password: 'Abcdef123456!@', passwordChangedAt: '2026-11-01' }, [{ password: 'Abcdef123456!@' }, { password: 'Abcdef123456!@' }]), ['多处复用（2 个账号在用）']);
}

console.log('== 前端：suggestCategory ==');
{
  eq('github → 开发', F.suggestCategory('https://github.com/jasonssuns-prog/hubmate', 'hubmate'), { category: '开发', tags: ['开发', '代码'] });
  eq('vps 关键词 → VPS', F.suggestCategory('https://vps.example.com', '我的VPS'), { category: 'VPS/服务器', tags: ['VPS', '云服务'] });
  eq('ChatGPT → AI', F.suggestCategory('https://chatgpt.com', 'ChatGPT'), { category: 'AI', tags: ['AI'] });
  eq('游戏 → 游戏', F.suggestCategory('https://store.steampowered.com', 'Steam'), { category: '游戏', tags: ['游戏'] });
  eq('未知 → 其他', F.suggestCategory('https://example.com', '随便'), { category: '其他', tags: [] });
  eq('空 → null', F.suggestCategory('', ''), null);
  eq('邮箱', F.suggestCategory('https://mail.google.com', 'Gmail'), { category: '邮箱', tags: ['邮箱'] });
}

console.log('== 前端：monthlyUptime ==');
{
  const svc = { linkHistory: [
    { t: Date.UTC(2026, 10, 1), ok: true },
    { t: Date.UTC(2026, 10, 2), ok: false },
    { t: Date.UTC(2026, 9, 30), ok: true }
  ] };
  eq('11 月 1/2', F.monthlyUptime(svc, '2026-11'), { rate: 50, count: 2 });
  eq('10 月 1 条全通', F.monthlyUptime(svc, '2026-10'), { rate: 100, count: 1 });
  eq('没记录 null', F.monthlyUptime({ linkHistory: [] }, '2026-11'), null);
}

console.log(`\n${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
