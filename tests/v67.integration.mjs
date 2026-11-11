/* v67 集成测试：wrangler dev + 本地 D1，全新空库走完整多用户流程
   用法：
     rm -rf .wrangler/state/v3/d1            # 全新空 D1
     npx wrangler dev --port 8787 &           # 另开终端先跑起来
     node tests/v67.integration.mjs           # 再跑这个
   退出码 0 = 全部通过；非 0 = 有失败。
   注意：登录限流是每 IP 10 分钟 10 次，本地 cf-connecting-ip 都取不到所以
   全算一个 IP——全程登录/注册请求刻意控制在 10 次以内，别多加登录步骤。 */
const BASE = process.env.BASE || 'http://127.0.0.1:8787';

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

async function req(method, path, { body, cookie } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  const setCookie = res.headers.get('set-cookie') || '';
  const m = setCookie.match(/session=([^;]+)/);
  return { status: res.status, json, text, cookie: m ? `session=${m[1]}` : null };
}

/* 验证码：SVG 里 4 个 <text> 各含一个字符，按顺序拼起来就是答案 */
async function captcha() {
  const r = await req('GET', '/api/captcha');
  if (r.status !== 200) throw new Error('拿验证码失败: ' + r.status);
  const chars = [...r.json.svg.matchAll(/>([A-Z0-9])<\/text>/g)].map((x) => x[1]);
  if (chars.length !== 4) throw new Error('验证码 SVG 解析失败: ' + r.json.svg.slice(0, 200));
  return { id: r.json.id, code: chars.join('') };
}
async function login(username, password) {
  const c = await captcha();
  return await req('POST', '/api/login', { body: { username, password, captchaId: c.id, captcha: c.code } });
}
async function register(username, password, inviteCode) {
  const c = await captcha();
  return await req('POST', '/api/register', { body: { username, password, inviteCode, captchaId: c.id, captcha: c.code } });
}

/* 等 wrangler dev 起好 */
for (let i = 0; i < 60; i++) {
  try {
    const r = await req('GET', '/api/healthz');
    if (r.status === 200) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 1000));
  if (i === 59) { console.log('FAIL wrangler dev 没起来（http://127.0.0.1:8787）'); process.exit(1); }
}

console.log('== 全新安装：默认管理员 jason，公开页只含管理员服务 ==');
{
  const pub = await req('GET', '/api/public');
  eq('公开页状态', pub.status, 200);
  eq('公开页用户名是 jason', pub.json.username, 'jason');
  ok('公开页有 2 条示例服务', Array.isArray(pub.json.services) && pub.json.services.length === 2);
  const meta = await req('GET', '/api/meta');
  eq('未登录 meta 401', meta.status, 401);
}

console.log('== 管理员登录（jason/jason123，密码默认） ==');
let adminCookie;
{
  const r = await login('jason', 'jason123');
  eq('登录状态', r.status, 200);
  eq('isAdmin', r.json.isAdmin, true);
  ok('拿到 session cookie', !!r.cookie);
  adminCookie = r.cookie;
  const me = await req('GET', '/api/me', { cookie: adminCookie });
  eq('/api/me 用户名', me.json.username, 'jason');
  eq('/api/me isAdmin', me.json.isAdmin, true);
  const meta = await req('GET', '/api/meta', { cookie: adminCookie });
  eq('meta isAdmin', meta.json.isAdmin, true);
  eq('密码默认标记', meta.json.passwordIsDefault, true);
}

console.log('== 邀请码：生成、列表、注册消耗、一次用完 ==');
let inviteCode;
{
  const g = await req('POST', '/api/invite-codes', { cookie: adminCookie });
  eq('生成邀请码', g.status, 200);
  ok('码格式 HUB-XXXX-XXXX-XXXX', /^HUB-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(g.json.code));
  inviteCode = g.json.code;
  const list = await req('GET', '/api/invite-codes', { cookie: adminCookie });
  eq('列表 1 条', list.json.codes.length, 1);
  eq('未使用', !!list.json.codes[0].usedBy, false);
  /* 注册：好码成功，自动登录 */
  const reg = await register('alice', 'alice123', inviteCode);
  eq('alice 注册成功', reg.status, 200);
  ok('注册后自动登录（有 cookie）', !!reg.cookie);
  var aliceCookie = reg.cookie;
  /* 同一个码再用 → 400 */
  const reuse = await register('bob', 'bob12345', inviteCode);
  eq('邀请码重复用 400', reuse.status, 400);
  /* 错码 → 400 */
  const bad = await register('bob', 'bob12345', 'HUB-AAAA-BBBB-CCCC');
  eq('错邀请码 400', bad.status, 400);
  /* 重名 → 400（先另生成一个码） */
  const g2 = await req('POST', '/api/invite-codes', { cookie: adminCookie });
  const dup = await register('alice', 'alice123', g2.json.code);
  eq('重名注册 400', dup.status, 400);
  /* 码已被 alice 消耗 */
  const list2 = await req('GET', '/api/invite-codes', { cookie: adminCookie });
  eq('码被 alice 用了', list2.json.codes.find((c) => c.code === inviteCode).usedBy, 'alice');
  /* 作废未用的码 */
  const rv = await req('POST', `/api/invite-codes/${encodeURIComponent(g2.json.code)}/revoke`, { cookie: adminCookie });
  eq('作废未用码', rv.status, 200);
  const list3 = await req('GET', '/api/invite-codes', { cookie: adminCookie });
  eq('作废后列表只剩 1 条', list3.json.codes.length, 1);
  const rv2 = await req('POST', `/api/invite-codes/${encodeURIComponent(inviteCode)}/revoke`, { cookie: adminCookie });
  eq('已用的码不能作废 400', rv2.status, 400);
}

console.log('== 数据隔离：alice 看不到管理员的服务；管理员看不到 alice 的 ==');
let aliceSvcId;
{
  const a = await req('GET', '/api/services', { cookie: aliceCookie });
  eq('alice 服务数 0', a.json.length, 0);
  const c = await req('POST', '/api/services', { cookie: aliceCookie, body: { name: 'Alice站', url: 'https://alice.example.com', category: 'relay' } });
  eq('alice 新建服务', c.status, 200);
  aliceSvcId = c.json.id;
  const a2 = await req('GET', '/api/services', { cookie: aliceCookie });
  eq('alice 服务数 1', a2.json.length, 1);
  eq('alice 的服务名', a2.json[0].name, 'Alice站');
  const j = await req('GET', '/api/services', { cookie: adminCookie });
  eq('管理员仍是 2 条示例服务', j.json.length, 2);
  ok('管理员看不到 Alice站', !j.json.some((s) => s.name === 'Alice站'));
  /* 公开页 / 日历只含管理员服务 */
  const pub = await req('GET', '/api/public');
  ok('公开页没有 Alice站', !pub.json.services.some((s) => s.name === 'Alice站'));
  const ics = await req('GET', '/api/calendar.ics', { cookie: aliceCookie });
  eq('日历 200', ics.status, 200);
  ok('日历不含 Alice站', !ics.text.includes('Alice站'));
}

console.log('== 非管理员调管理接口 → 403 ==');
{
  const u = await req('GET', '/api/admin/users', { cookie: aliceCookie });
  eq('alice 看用户列表 403', u.status, 403);
  const g = await req('POST', '/api/invite-codes', { cookie: aliceCookie });
  eq('alice 生成邀请码 403', g.status, 403);
  const b = await req('GET', '/api/backup', { cookie: aliceCookie });
  eq('alice 下备份 403', b.status, 403);
  const gh = await req('GET', '/api/github-backup/status', { cookie: aliceCookie });
  eq('alice 看 GitHub 备份配置 403', gh.status, 403);
}

console.log('== 管理员直接建用户 bob（密码留空=自动生成），改名、改密码、封禁、解封、删除 ==');
let bobId, bobTemp;
{
  const c = await req('POST', '/api/admin/users', { cookie: adminCookie, body: { username: 'bob', password: '' } });
  eq('建 bob', c.status, 200);
  bobId = c.json.id;
  bobTemp = c.json.tempPassword;
  ok('返回临时密码（12 位）', typeof bobTemp === 'string' && bobTemp.length === 12);
  const list = await req('GET', '/api/admin/users', { cookie: adminCookie });
  eq('用户列表 3 人（jason+alice+bob）', list.json.users.length, 3);
  eq('bob 默认密码标记', list.json.users.find((u) => u.username === 'bob').passwordIsDefault, true);
  ok('用户列表不含密码哈希', !JSON.stringify(list.json).includes('passwordHash'));
  /* bob 用临时密码登录 */
  const lb = await login('bob', bobTemp);
  eq('bob 登录成功', lb.status, 200);
  eq('bob 不是管理员', lb.json.isAdmin, false);
  /* 管理员改 bob 的名 → bob2（登录次数已到 6，改名只验接口响应，不再登录验证） */
  const rn = await req('POST', `/api/admin/users/${bobId}/rename`, { cookie: adminCookie, body: { newUsername: 'bob2' } });
  eq('管理员改名 bob→bob2', rn.status, 200);
  const list2 = await req('GET', '/api/admin/users', { cookie: adminCookie });
  ok('列表里是 bob2', list2.json.users.some((u) => u.username === 'bob2'));
  /* 改名到已存在的用户名 → 400 */
  const dup = await req('POST', `/api/admin/users/${bobId}/rename`, { cookie: adminCookie, body: { newUsername: 'alice' } });
  eq('改名重名 400', dup.status, 400);
  /* bob2 自己改名（要当前密码）→ bobby */
  const self = await req('POST', '/api/username', { cookie: lb.cookie, body: { newUsername: 'bobby', password: bobTemp } });
  eq('bob2 自己改名 bobby', self.status, 200);
  eq('改名后用户名', self.json.username, 'bobby');
  /* 管理员重置 bobby 的密码 */
  const rs = await req('POST', `/api/admin/users/${bobId}/reset-password`, { cookie: adminCookie });
  eq('重置密码', rs.status, 200);
  const newTemp = rs.json.tempPassword;
  ok('新临时密码 12 位', typeof newTemp === 'string' && newTemp.length === 12);
  const oldLogin = await login('bobby', bobTemp);
  eq('旧密码登不进 401', oldLogin.status, 401);
  const newLogin = await login('bobby', newTemp);
  eq('新临时密码能登', newLogin.status, 200);
  /* 封禁 → 登录拒绝“账号已被封禁” */
  const ban = await req('POST', `/api/admin/users/${bobId}/ban`, { cookie: adminCookie });
  eq('封禁', ban.status, 200);
  const bannedLogin = await login('bobby', newTemp);
  eq('被封禁登录 401', bannedLogin.status, 401);
  eq('封禁提示', bannedLogin.json.error, '账号已被封禁，请联系管理员');
  /* 解封 → 能登（第 10 次登录/注册请求，刚好在限流内） */
  const unban = await req('POST', `/api/admin/users/${bobId}/unban`, { cookie: adminCookie });
  eq('解封', unban.status, 200);
  const okLogin = await login('bobby', newTemp);
  eq('解封后能登', okLogin.status, 200);
  /* 不能删自己 / 不能封自己 */
  const me = await req('GET', '/api/me', { cookie: adminCookie });
  const adminList = await req('GET', '/api/admin/users', { cookie: adminCookie });
  const adminId = adminList.json.users.find((u) => u.username === 'jason').id;
  const delSelf = await req('DELETE', `/api/admin/users/${adminId}`, { cookie: adminCookie });
  eq('不能删自己 400', delSelf.status, 400);
  const banSelf = await req('POST', `/api/admin/users/${adminId}/ban`, { cookie: adminCookie });
  eq('不能封自己 400', banSelf.status, 400);
  /* 删除 bobby：账号 + 数据一起没（列表里没了；他建的服务也不会再出现） */
  const del = await req('DELETE', `/api/admin/users/${bobId}`, { cookie: adminCookie });
  eq('删除 bobby', del.status, 200);
  const list3 = await req('GET', '/api/admin/users', { cookie: adminCookie });
  eq('删除后用户列表 2 人', list3.json.users.length, 2);
  ok('列表里没 bobby', !list3.json.users.some((u) => u.username === 'bobby'));
}

console.log('== 备份 v2：管理员能下，含所有用户，不含任何密码哈希；v1 旧备份能恢复进管理员 ==');
{
  const b = await req('GET', '/api/backup', { cookie: adminCookie });
  eq('备份 200', b.status, 200);
  eq('备份格式 v2', b.json.version, 2);
  eq('备份用户数 2', b.json.users.length, 2);
  ok('备份含 alice 的服务', Object.values(b.json.userData).some((d) => (d.services || []).some((s) => s.name === 'Alice站')));
  ok('备份全文不含 passwordHash', !b.text.includes('passwordHash'));
  ok('备份全文不含 totpSecret', !b.text.includes('totpSecret'));
  ok('备份全文不含 apiToken', !b.text.includes('apiToken'));
  /* v1 旧备份恢复进管理员自己的数据 */
  const v1 = { services: [{ id: 'bb0001', name: '恢复来的站', category: 'relay', url: 'https://restored.example.com' }], categories: [], xp: 5 };
  const r = await req('POST', '/api/backup', { cookie: adminCookie, body: { data: v1 } });
  eq('v1 恢复', r.status, 200);
  const j = await req('GET', '/api/services', { cookie: adminCookie });
  eq('管理员恢复后 1 条服务', j.json.length, 1);
  eq('恢复的服务名', j.json[0].name, '恢复来的站');
  const a = await req('GET', '/api/services', { cookie: aliceCookie });
  eq('alice 的服务没受影响（仍 1 条）', a.json.length, 1);
  eq('alice 的仍是 Alice站', a.json[0].name, 'Alice站');
}

console.log('== 前端 v67 资产：?v=20261111-w6，含注册/用户管理/邀请码入口 ==');
{
  const html = await req('GET', '/');
  ok('首页 200', html.status === 200);
  ok('app.js?v=20261111-w6', html.text.includes('app.js?v=20261111-w6'));
  ok('style.css?v=20261111-w6', html.text.includes('style.css?v=20261111-w6'));
  ok('注册入口', html.text.includes('id="link-register"'));
  ok('注册弹窗', html.text.includes('id="register-overlay"'));
  ok('我的账号面板', html.text.includes('id="sec-account"'));
  ok('用户管理面板', html.text.includes('id="sec-users"'));
  ok('邀请码面板', html.text.includes('id="sec-invites"'));
  const js = await req('GET', '/app.js?v=20261111-w6');
  ok('app.js 200', js.status === 200);
  ok('app.js 含 renderUsers', js.text.includes('renderUsers'));
  ok('app.js 含 renderInvites', js.text.includes('renderInvites'));
  ok('app.js 含 openRegister', js.text.includes('openRegister'));
}

console.log(`\n${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
