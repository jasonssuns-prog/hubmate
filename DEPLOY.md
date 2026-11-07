# 🚀 部署到 Linux 服务器

整个项目是**纯 Node.js 零依赖**（不需要 npm install），一个文件夹拷上去就能跑。
已内置生产加固：安全响应头 + CSP、gzip 压缩、ETag 缓存协商、登录防爆破、
健康检查、优雅退出、一键备份下载、systemd 沙箱（低权限用户运行）。

下面以 Debian/Ubuntu + root 为例，CentOS 把 `apt` 换成 `yum/dnf` 即可。

## 1. 上传

**推荐：直接在服务器上拉代码（最快）：**

```bash
ssh root@服务器IP
git clone https://github.com/jasonssuns-prog/hubmate.git /opt/service-hub
```

没有 git 或想从本机传包时，用 tar/scp：

在 Windows 本机（Git Bash / 终端）执行：

```bash
tar czf service-hub.tar.gz service-hub
scp service-hub.tar.gz root@服务器IP:/opt/
ssh root@服务器IP
cd /opt && tar xzf service-hub.tar.gz
```

> 包里带着本机的 `data/data.json`，部署后你在本机记录的数据原样迁移过去。
> 想要全新开始：`rm -f /opt/service-hub/data/data.json`，首次访问会自动重建。

## 2. 一键部署（推荐）

```bash
cd /opt/service-hub
bash deploy/install.sh                       # 直连部署，监听 0.0.0.0:7788
```

想一步到位用 nginx 反代（推荐，只暴露 80/443）：

```bash
bash deploy/install.sh --nginx                              # server_name 自动取本机 IP
bash deploy/install.sh --nginx --domain hub.example.com     # 指定域名
```

其他选项：

```bash
bash deploy/install.sh --port 8080        # 换端口
bash deploy/install.sh --behind-nginx     # 已有 nginx，仅让应用监听 127.0.0.1
bash deploy/install.sh --help             # 查看全部参数
```

脚本会自动完成：
- 识别发行版（Debian/Ubuntu 用 apt，CentOS/RHEL/Rocky/Alma 用 dnf/yum）
- 检查 / 安装 Node.js 20（已有 v18+ 则跳过）
- 创建低权限运行用户 `servicehub`，数据目录收紧到 750 / 文件 600
- **升级前自动备份线上 `data.json`** 到 `/opt/service-hub-backups/`（保留最近 10 份）
- 安装并启动 systemd 服务（开机自启 + 崩溃自动重启 + 沙箱加固）
- 部署后健康检查（最多重试 15 秒，失败自动打印日志）
- 加 `--nginx` 时自动装 nginx、写入站点配置、`nginx -t` 校验后平滑 reload

浏览器访问 `http://服务器IP:7788`（或配了 nginx 就访问 80）能看到页面就 OK。
（云服务器需在安全组/防火墙放行对应端口）

> 升级新版本：本机重新打包上传解压后，再跑一遍 `bash deploy/install.sh` 即可
> —— 脚本是幂等的，**会自动保留线上 `data/` 数据目录并先备份**。

## 3. 手动部署（不想用脚本时）

```bash
apt update && apt install -y curl
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
node -v   # 要求 v18 及以上

useradd --system --no-create-home --shell /usr/sbin/nologin servicehub
chown -R servicehub:servicehub /opt/service-hub

cp /opt/service-hub/deploy/service-hub.service /etc/systemd/system/
# 如果 node 不在 /usr/bin/node：`which node` 查到路径后改 service 文件里的 ExecStart
systemctl daemon-reload
systemctl enable --now service-hub
systemctl status service-hub       # 看状态
# journalctl -u service-hub -f     # 看日志
```

## 4.（强烈推荐）nginx 反代 + HTTPS

最简单：`bash deploy/install.sh --nginx --domain 你的域名`（脚本会自动完成下面所有步骤）。

手动方式：

```bash
apt install -y nginx
cp /opt/service-hub/deploy/nginx.conf /etc/nginx/sites-available/service-hub
# 编辑该文件：把 server_name 换成你的域名（不用域名就填服务器 IP，别留 _ ）
ln -s /etc/nginx/sites-available/service-hub /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

> CentOS/Rocky 等没有 `sites-available` 的发行版，直接放到 `/etc/nginx/conf.d/service-hub.conf`。

然后编辑 `/etc/systemd/system/service-hub.service`，取消 `Environment=HOST=127.0.0.1` 的注释，
`systemctl restart service-hub`——这样 7788 只监听本机，外部只能走 nginx 的 80/443。
（此模式下服务会自动信任 nginx 传来的真实 IP 和 HTTPS 标记，Cookie 自动加 Secure）

nginx 配置已内置：登录接口限速防爆破、隐藏版本号、健康检查免日志、WebSocket 升级头。

有域名就上 HTTPS：

```bash
apt install -y certbot python3-certbot-nginx   # CentOS: dnf install -y certbot python3-certbot-nginx
certbot --nginx -d 你的域名
```

防火墙只留需要的口：

```bash
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw enable
```

## 5. 安全清单（重要）

- [ ] **第一件事：登录后点「改密码」**，初始默认密码等于裸奔（页面顶部也会一直红条提醒，改完才消失）
- [ ] 密码/密钥是明文存在服务器 `data/data.json` 里的——**别把最重要的密码放进来**，或确保服务器本身够安全
- [ ] 不用 nginx 的话，至少改个端口 + 强密码；千万别把 7788 裸暴露在公网还不改密码
- [ ] 定期备份：页面上点「备份」可下载完整数据；或命令行 `tar czf /root/hub-backup.tgz /opt/service-hub/data`

自动每日备份（`crontab -e` 添加）：

```
0 4 * * * tar czf /root/hub-backup-$(date +\%F).tgz /opt/service-hub/data
```

## 6. 日常维护

```bash
systemctl restart service-hub      # 改了文件后重启
systemctl stop service-hub         # 停止
journalctl -u service-hub -f       # 实时日志
curl http://127.0.0.1:7788/api/healthz   # 健康检查（可接监控/Uptime Kuma）
```

## 7. 内置加固一览

| 项 | 说明 |
|---|---|
| 安全响应头 | nosniff / DENY framing / Referrer-Policy / Permissions-Policy / COOP |
| CSP | 仅允许同源脚本样式，禁 object、禁被 iframe 嵌套 |
| 登录防爆破 | 服务端每 IP 10 分钟 10 次 + nginx 侧 5 次/分钟双重限速 |
| 压缩 | 文本类响应 >1KB 自动 gzip |
| 缓存 | 静态资源 ETag 协商缓存（更新即时生效，重复访问 304） |
| 会话 | HttpOnly + SameSite Cookie，反代 HTTPS 时自动加 Secure |
| 运行隔离 | systemd 低权限用户 + ProtectSystem/PrivateTmp/内存限额 |
| 超时 | 请求 30s / 头部 15s，防慢速攻击 |
