// 把你的域名反代到部署好的服务台
// 部署到 Cloudflare Workers 后，把你的域名（需要 www 的话再加 www 子域名）
// 绑定为这个 Worker 的自定义域名即可，DNS 记录 Cloudflare 会自动建。
// 地址栏全程保持你的域名，登录 Cookie 由浏览器存在你的域名下。

const ORIGIN = 'https://YOUR-SERVER-URL'; // 改成你部署好的服务地址，例如 https://7788-xxxx.instabox.tech

// 不需要转发给源站的请求头：浏览器/边缘自己会重新生成。
const DROP_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'cf-connecting-ip',
  'cf-ipcountry',
  'cf-ray',
  'cf-visitor',
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-real-ip',
]);

// 不需要原样回给浏览器的响应头：让边缘重新处理编码/长度。
const DROP_RESPONSE_HEADERS = new Set([
  'content-length',
  'content-encoding',
  'connection',
]);

export default {
  async fetch(request) {
    const incoming = new URL(request.url);
    // 只保留路径和查询参数，换成源站主机，地址栏仍是 jasonsu.us。
    const target = new URL(ORIGIN);
    target.pathname = incoming.pathname;
    target.search = incoming.search;

    const headers = new Headers();
    for (const [name, value] of request.headers) {
      if (!DROP_REQUEST_HEADERS.has(name.toLowerCase())) {
        headers.set(name, value);
      }
    }
    // 告诉源站：真实访问是 HTTPS，登录 Cookie 才能带 Secure 正常工作。
    headers.set('host', target.host);
    headers.set('x-forwarded-proto', 'https');
    headers.set('x-forwarded-host', incoming.host);

    // 先读出 body 再转发：登录 POST 这类小请求这样最稳，流式 body 在不同运行时要求不一样。
    const body = ['GET', 'HEAD'].includes(request.method)
      ? undefined
      : await request.arrayBuffer();

    const response = await fetch(target.toString(), {
      method: request.method,
      headers,
      body,
      redirect: 'manual',
    });

    const outHeaders = new Headers();
    for (const [name, value] of response.headers) {
      if (!DROP_RESPONSE_HEADERS.has(name.toLowerCase())) {
        outHeaders.set(name, value);
      }
    }
    // 源站如果返回绝对地址的重定向，把它换回 jasonsu.us，避免跳回长地址。
    const location = outHeaders.get('location');
    if (location && location.startsWith(ORIGIN)) {
      outHeaders.set('location', location.replace(ORIGIN, `https://${incoming.host}`));
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: outHeaders,
    });
  },
};
