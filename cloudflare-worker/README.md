# 自定义域名（Cloudflare Worker 反代）

[English](#custom-domain-cloudflare-worker-reverse-proxy) | 中文

这个 Worker 把你的域名反代到部署好的服务台，地址栏全程保持你的域名（不是跳转）。

## 用法

1. 把 `worker.js` 里的 `ORIGIN` 改成你部署好的服务地址（例如 `https://7788-xxxx.instabox.tech`）。
2. 在 Cloudflare Dashboard 创建一个 Worker，粘贴 `worker.js` 的内容，部署。
3. 在 Worker 的设置里绑定你的自定义域名（需要 www 的话再加 `www` 子域名），DNS 记录 Cloudflare 会自动建。
4. 打开你的域名，应该直接看到服务台首页；登录 Cookie 由浏览器存在你的域名下。

## 注意

- 这只是**反代**：服务本身还是跑在你自己的服务器上（VPS、家里电脑、instabox 等），Worker 只转发流量。
- 源站如果返回绝对地址的重定向，Worker 会把它换回你的域名，避免跳回长地址。
- 这不是“把服务部署到 Workers”：服务是 Node.js 服务端（监听端口 + 本地文件存数据），Workers 跑不了它。想一键部署到 Workers 需要把存储改成 KV / D1，那是另一个工程。

---

## Custom domain (Cloudflare Worker reverse proxy)

This Worker reverse-proxies your domain to a deployed service hub, keeping your domain in the address bar (not a redirect).

## Usage

1. In `worker.js`, set `ORIGIN` to your deployed service URL (e.g. `https://7788-xxxx.instabox.tech`).
2. Create a Worker in the Cloudflare Dashboard, paste the contents of `worker.js`, and deploy.
3. Bind your custom domain to the Worker in its settings (add the `www` subdomain too if you need it); Cloudflare creates the DNS records automatically.
4. Open your domain — you should see the hub's home page. The login cookie is stored by the browser under your domain.

## Notes

- This is only a **reverse proxy**: the service itself still runs on your own server (VPS, home machine, instabox, etc.); the Worker just forwards traffic.
- If the origin returns an absolute-URL redirect, the Worker rewrites it back to your domain so visitors never bounce to the long address.
- This does **not** deploy the service onto Workers: the service is a Node.js server (listens on a port, stores data in local files), which Workers cannot run. A one-click Workers deploy would need storage moved to KV / D1 — a separate, larger project.
