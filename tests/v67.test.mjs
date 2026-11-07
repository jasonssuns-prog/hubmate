/* v67 单元测试：多用户——邀请码生成、用户名校验、账号信息脱敏
   用法：node tests/v67.test.mjs
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
  src = src.replace(/\nexport default \{[\s\S]*$/, '\n;globalThis.__worker = { genInviteCode, validUsername, publicUser };');
  const ctx = vm.createContext({
    console, crypto: globalThis.crypto, Buffer, fetch, Response, URL, AbortSignal,
    setTimeout, clearTimeout, randomBytes, createHash,
    Date, Math, JSON, Object, Array, Map, Set, Promise, Error, String, Number
  });
  vm.runInContext(src, ctx);
  return ctx.__worker;
}
const W = loadWorker();

console.log('== genInviteCode：格式 HUB-XXXX-XXXX-XXXX，不可猜 ==');
{
  const codes = new Set();
  for (let i = 0; i < 200; i++) codes.add(W.genInviteCode());
  eq('200 个码全不重复', codes.size, 200);
  let badFormat = 0, badChar = 0;
  for (const c of codes) {
    if (!/^HUB-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(c)) badFormat++;
    if (/[IO01]/.test(c)) badChar++; /* 易混淆字符 I/O/0/1 不许出现 */
  }
  eq('格式全对', badFormat, 0);
  eq('无易混淆字符', badChar, 0);
  ok('长度 18（HUB- + 12 码 + 两杠）', [...codes][0].length === 18);
}

console.log('== validUsername：2–32 位，首尾字母/数字/中文/下划线 ==');
{
  ok('jason', W.validUsername('jason'));
  ok('2 位 ab', W.validUsername('ab'));
  ok('中文名', W.validUsername('中文名'));
  ok('中文+数字 名字1', W.validUsername('名字1'));
  ok('中间空格 a b', W.validUsername('a b'));
  ok('中间点 a.b', W.validUsername('a.b'));
  ok('中间横杠 a-b', W.validUsername('a-b'));
  ok('下划线 a_b', W.validUsername('a_b'));
  ok('32 位', W.validUsername('a'.repeat(32)));
  ok('1 位 a 拒绝', !W.validUsername('a'));
  ok('33 位拒绝', !W.validUsername('a'.repeat(33)));
  ok('空拒绝', !W.validUsername(''));
  ok('首空格拒绝', !W.validUsername(' a'));
  ok('尾空格拒绝', !W.validUsername('a '));
  ok('首横杠拒绝', !W.validUsername('-ab'));
  ok('尾横杠拒绝', !W.validUsername('ab-'));
  ok('斜杠拒绝', !W.validUsername('a/b'));
  ok('非字符串拒绝', !W.validUsername(null));
  ok('首点拒绝', !W.validUsername('.ab'));
}

console.log('== publicUser：只返回账号信息，绝不含密码哈希/TOTP/API 令牌 ==');
{
  const u = {
    id: 'u1', username: 'alice', passwordHash: 'pbkdf2:abc:def', passwordIsDefault: false,
    isAdmin: 0, banned: 0, createdAt: '2026-11-08 10:00:00', lastLoginAt: '2026-11-08 11:00:00',
    totpSecret: 'JBSWY3DPEHPK3PXP', totpEnabled: 1, apiToken: 'tok123'
  };
  const p = W.publicUser(u);
  eq('id', p.id, 'u1');
  eq('username', p.username, 'alice');
  eq('passwordIsDefault', p.passwordIsDefault, false);
  eq('isAdmin', p.isAdmin, false);
  eq('banned', p.banned, false);
  eq('createdAt', p.createdAt, '2026-11-08 10:00:00');
  eq('lastLoginAt', p.lastLoginAt, '2026-11-08 11:00:00');
  ok('没有 passwordHash', !('passwordHash' in p));
  ok('没有 totpSecret', !('totpSecret' in p));
  ok('没有 apiToken', !('apiToken' in p));
  ok('没有 totpEnabled', !('totpEnabled' in p));
  eq('只剩 7 个键', Object.keys(p).length, 7);
  eq('空用户', W.publicUser(null), null);
}

console.log(`\n${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
