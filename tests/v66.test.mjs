/* v66 单元测试：续期一律从今天起算（提前续期不保留剩余天数）
   用法：node tests/v66.test.mjs
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

/* ---------- 服务端纯函数：把 src/worker.js 去掉 import/export 后在 vm 里跑 ---------- */
function loadWorker() {
  let src = fs.readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
  src = src.replace(/^import \{ randomBytes, createHash \} from 'node:crypto';$/m, '');
  src = src.replace(/^import \{ Buffer \} from 'node:buffer';$/m, '');
  src = src.replace(/\nexport default \{[\s\S]*$/, '\n;globalThis.__worker = { renewDates, addYear, addDays };');
  const ctx = vm.createContext({
    console, crypto: globalThis.crypto, Buffer, fetch, Response, URL, AbortSignal,
    setTimeout, clearTimeout, randomBytes, createHash,
    Date, Math, JSON, Object, Array, Map, Set, Promise, Error, String, Number
  });
  vm.runInContext(src, ctx);
  return ctx.__worker;
}
const W = loadWorker();

console.log('== 服务端：renewDates（v66 续期一律从今天起算） ==');
{
  // 用户例子：今天 2026-11-08，服务还有 15 天到期（2026-11-23），周期 20 天
  // 提前续期 → 新到期日 = 今天 + 20 天 = 2026-11-28（不是 2026-11-23 + 20 天 = 12-13）
  eq('提前续期：15 天后到期、周期 20 天 → 今天 + 20 天', W.renewDates('2026-11-08', 20), { registeredAt: '2026-11-08', expiresAt: '2026-11-28' });
  // 已过期续期：今天 2026-11-08，服务已过期（2026-10-01），周期 20 天 → 同样今天 + 20 天
  eq('已过期续期：周期 20 天 → 今天 + 20 天', W.renewDates('2026-11-08', 20), { registeredAt: '2026-11-08', expiresAt: '2026-11-28' });
  // 365 天按加一年
  eq('365 天：今天 + 1 年', W.renewDates('2026-11-08', 365), { registeredAt: '2026-11-08', expiresAt: '2027-11-08' });
  // 闰年 2 月 29 日加一年 → 2 月 28 日
  eq('365 天：2028-02-29 + 1 年 → 2029-02-28', W.renewDates('2028-02-29', 365), { registeredAt: '2028-02-29', expiresAt: '2029-02-28' });
  // 跨年
  eq('跨年：2026-12-20 + 20 天 → 2027-01-09', W.renewDates('2026-12-20', 20), { registeredAt: '2026-12-20', expiresAt: '2027-01-09' });
  // 1 天
  eq('1 天：今天 + 1 天', W.renewDates('2026-11-08', 1), { registeredAt: '2026-11-08', expiresAt: '2026-11-09' });
}

console.log(`\n${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
