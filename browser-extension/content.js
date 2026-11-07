/* HubMate 助手 content script：只在有密码框的登录页出现。
   点浮动按钮后，用 API 令牌调服务台的 /api/accounts/by-domain（v62+ 才有），
   只取当前域名的账号，选一个填进账号/密码框。令牌和地址只存在本浏览器里。 */
(() => {
  const pw = document.querySelector('input[type="password"]');
  if (!pw || window.top !== window.self) return; // 只在顶层页面、只有密码框的页才出现

  const btn = document.createElement('button');
  btn.textContent = '🔑 从服务台填充';
  btn.type = 'button';
  Object.assign(btn.style, {
    position: 'fixed', right: '16px', bottom: '16px', zIndex: '2147483647',
    padding: '10px 14px', border: '0', borderRadius: '999px', cursor: 'pointer',
    background: '#7c3aed', color: '#fff', font: '600 13px/1 -apple-system, sans-serif',
    boxShadow: '0 4px 16px rgba(0,0,0,.35)'
  });
  document.body.appendChild(btn);

  const panel = document.createElement('div');
  Object.assign(panel.style, {
    position: 'fixed', right: '16px', bottom: '64px', zIndex: '2147483647',
    width: '280px', maxHeight: '300px', overflowY: 'auto', display: 'none',
    background: '#fff', color: '#222', border: '1px solid #ddd', borderRadius: '12px',
    boxShadow: '0 8px 28px rgba(0,0,0,.3)', padding: '8px',
    font: '13px/1.6 -apple-system, sans-serif'
  });
  document.body.appendChild(panel);

  function findUserField() {
    const form = pw.closest('form') || document;
    const cands = [...form.querySelectorAll('input')].filter((el) =>
      el !== pw && el.type !== 'password' && el.type !== 'hidden' && el.type !== 'checkbox' &&
      el.type !== 'submit' && el.type !== 'button' && !el.disabled && el.offsetParent !== null);
    const scored = cands.map((el) => {
      const hay = `${el.name || ''} ${el.id || ''} ${el.autocomplete || ''} ${el.placeholder || ''}`.toLowerCase();
      let score = 0;
      if (/user|account|login|email|mail|phone|tel/.test(hay)) score += 3;
      if (el.type === 'email' || el.type === 'tel') score += 2;
      if (el === cands[0]) score += 1;
      return { el, score };
    }).sort((a, b) => b.score - a.score);
    return scored.length ? scored[0].el : null;
  }
  function fillField(el, value) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  btn.addEventListener('click', async () => {
    if (panel.style.display === 'block') { panel.style.display = 'none'; return; }
    panel.style.display = 'block';
    panel.innerHTML = '<div style="padding:8px">正在取账号…</div>';
    try {
      const cfg = await chrome.storage.local.get(['hubUrl', 'apiToken']);
      const hub = String(cfg.hubUrl || '').trim().replace(/\/+$/, '');
      if (!hub || !cfg.apiToken) {
        panel.innerHTML = '<div style="padding:8px">先在扩展弹窗里填好服务台地址和 API 令牌（服务台侧栏“🔑 API 令牌”里生成）。</div>';
        return;
      }
      const res = await fetch(`${hub}/api/accounts/by-domain?domain=${encodeURIComponent(location.hostname)}`, {
        headers: { 'Authorization': 'Bearer ' + cfg.apiToken }
      });
      if (res.status === 401) {
        panel.innerHTML = '<div style="padding:8px">令牌不对或已作废：去服务台重新生成一个，填进扩展弹窗。</div>';
        return;
      }
      if (!res.ok) { panel.innerHTML = `<div style="padding:8px">取账号失败：HTTP ${res.status}（服务台要 v62 以上才有这个接口）。</div>`; return; }
      const j = await res.json();
      const list = j.accounts || [];
      if (!list.length) {
        panel.innerHTML = `<div style="padding:8px">这个域名（${location.hostname}）在服务台里没有录账号。</div>`;
        return;
      }
      panel.innerHTML = list.map((a, i) =>
        `<button data-i="${i}" style="display:block;width:100%;text-align:left;background:none;border:0;border-radius:8px;padding:8px 10px;cursor:pointer;font:inherit"><b>${a.username.replace(/</g, '&lt;')}</b><br><span style="color:#666">${(a.serviceName || '').replace(/</g, '&lt;')} · ${(a.label || '').replace(/</g, '&lt;')}</span></button>`).join('');
      panel.querySelectorAll('[data-i]').forEach((b) => b.addEventListener('click', () => {
        const a = list[Number(b.dataset.i)];
        const userEl = findUserField();
        if (userEl) fillField(userEl, a.username || '');
        fillField(pw, a.password || '');
        panel.style.display = 'none';
      }));
    } catch (e) {
      panel.innerHTML = '<div style="padding:8px">取账号失败：服务台地址打不开，先检查扩展弹窗里的地址对不对。</div>';
    }
  });
})();
