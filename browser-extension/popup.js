/* HubMate 助手 popup：保存设置（服务台地址 + API 令牌，只存本浏览器 chrome.storage.local），
   一键把当前标签页存为服务（走浏览器里服务台的登录会话）。 */
const $ = (id) => document.getElementById(id);
const msg = (text, cls = '') => {
  const el = $('msg');
  el.textContent = text;
  el.className = cls;
};
const normHub = (u) => String(u || '').trim().replace(/\/+$/, '');

chrome.storage.local.get(['hubUrl', 'hasToken'], (cfg) => {
  if (cfg.hubUrl) $('hub-url').value = cfg.hubUrl;
  if (cfg.hasToken) $('api-token').placeholder = '已保存，留空表示不改';
});

$('btn-save').addEventListener('click', () => {
  const hubUrl = normHub($('hub-url').value);
  if (hubUrl && !/^https?:\/\//i.test(hubUrl)) { msg('服务台地址要是 http(s) 开头', 'bad'); return; }
  const token = $('api-token').value.trim();
  const patch = { hubUrl };
  if (token) patch.hasToken = true;
  chrome.storage.local.set({ ...patch, ...(token ? { apiToken: token } : {}) }, () => {
    $('api-token').value = '';
    if (token) $('api-token').placeholder = '已保存，留空表示不改';
    msg(hubUrl ? '已保存设置' : '已清空服务台地址', 'ok');
  });
});

$('btn-open').addEventListener('click', () => {
  chrome.storage.local.get(['hubUrl'], (cfg) => {
    if (!cfg.hubUrl) { msg('先填服务台地址并保存', 'bad'); return; }
    chrome.tabs.create({ url: cfg.hubUrl });
  });
});

$('btn-add').addEventListener('click', async () => {
  const btn = $('btn-add');
  if (btn.disabled) return;
  btn.disabled = true;
  msg('正在保存…');
  try {
    const cfg = await chrome.storage.local.get(['hubUrl']);
    const hubUrl = normHub(cfg.hubUrl);
    if (!hubUrl) { msg('先填服务台地址并保存', 'bad'); return; }
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url || !/^https?:\/\//i.test(tab.url)) { msg('当前标签页不是一个网页', 'bad'); return; }
    const res = await fetch(hubUrl + '/api/services', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: (tab.title || tab.url).slice(0, 100), url: tab.url })
    });
    if (res.status === 401) { msg('还没登录服务台：先在浏览器里打开服务台登录一次，再回来点', 'bad'); return; }
    if (!res.ok) { msg('保存失败：HTTP ' + res.status, 'bad'); return; }
    msg('已存进服务台 ✓', 'ok');
  } catch (e) {
    msg('保存失败：' + (e.message || '服务台地址打不开'), 'bad');
  } finally {
    btn.disabled = false;
  }
});
