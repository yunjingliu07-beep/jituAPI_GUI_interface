# Ubuntu 24.04 自托管部署

适用于香港轻量应用服务器、小规模使用。此部署与现有 Sites 托管并行，安装脚本不会修改主站 DNS 或现有线上数据库。先使用 `preview.imagemeow.top` 验证；新数据库最初为空，**部署成功不等于旧账号、会话和参考图已经迁移**。

## 已安装运行环境后的操作

需要 Node.js 24、Nginx、Git、curl。后端仅监听 `127.0.0.1:3000`，轻量应用服务器防火墙对外开放 TCP 80、443；无需对外开放 3000。

在服务器的远程终端执行：

```bash
sudo git clone https://github.com/yunjingliu07-beep/jituAPI_GUI_interface.git /opt/image-meow
cd /opt/image-meow
sudo bash deploy/ubuntu/install.sh preview.imagemeow.top
```

若目标目录已经存在，先确认内容及 Git 状态，不要清空目录或覆盖未知文件。克隆若要求 GitHub 凭据且您没有访问权限，应先由仓库所有者授权，不能把令牌或密码写进克隆 URL。

成功时返回 `{"ok":true}`。安装器新建无登录权限的 `image-meow` 服务账号，初始化 SQLite，配置 systemd 开机运行，并配置 Nginx 的健康检查和证书校验入口。首次安装随机生成独立加密主密钥，文件为 root-only，不会输出密钥。重复执行保留密钥、数据库和已有 HTTPS 配置。

此阶段 HTTP 的网页入口返回 `HTTPS setup pending.` 属于正常状态；登录 Cookie 要求 HTTPS，证书部署完成后才开放页面。

## 临时域名与 HTTPS

1. 在阿里云 DNS 为 `imagemeow.top` 新增 A 记录：主机记录 `preview`，记录值为该服务器公网 IPv4。现有主机记录 `@` 的记录暂时保持。
2. 在轻量服务器防火墙开放 TCP 80、443，若系统启用了 UFW，也需放行这两个端口。保留已有的远程管理通道；不要在不清楚 SSH 端口时重置防火墙。
3. 等待 `http://preview.imagemeow.top/healthz` 返回 `{"ok":true}`。
4. 安装证书工具并签发证书：

```bash
sudo apt-get install -y certbot
sudo certbot certonly --webroot -w /var/www/image-meow-acme -d preview.imagemeow.top
```

按提示填写用于证书通知的邮箱，并同意证书条款。证书签发需要域名已指向服务器且 80 端口可访问。

5. 启用 HTTPS：

```bash
cd /opt/image-meow
sudo bash deploy/ubuntu/enable-https.sh preview.imagemeow.top
```

6. 添加续期后重载钩子，验证续期与定时任务：

```bash
sudo install -d -m 0755 /etc/letsencrypt/renewal-hooks/deploy
sudo install -m 0755 deploy/ubuntu/reload-nginx.sh /etc/letsencrypt/renewal-hooks/deploy/image-meow-nginx
sudo certbot renew --dry-run
systemctl list-timers certbot.timer
```

然后访问 `https://preview.imagemeow.top`，使用测试账号验证注册、登录、新手教程、会话操作、API 切换、文字/参考图生图和重新编辑。真实生图会使用供应商额度，按实际需求验证。

## 文件位置与维护

| 路径 | 用途 |
| --- | --- |
| `/opt/image-meow` | GitHub 源代码，root 管理，服务账号不应拥有写权限 |
| `/etc/image-meow/server.env` | 公网来源、端口、数据目录及 API 加密主密钥，权限 0600 |
| `/var/lib/image-meow/studio.sqlite` | 账号、会话、任务及加密 API 记录 |
| `/var/lib/image-meow/references` | 账号私有原参考图、遮罩 |
| `/etc/nginx/sites-available/image-meow.conf` | 网站域名和 TLS 反向代理配置 |

`API_VAULT_KEY` 是本站加密密钥，不是即图 API Key。不要发到聊天、截图或 GitHub；不要随意更换。备份时必须同时保留它，单独恢复数据库无法解密已保存的 API。

查看状态：

```bash
systemctl is-active image-meow
sudo journalctl -u image-meow -n 30 --no-pager
sudo nginx -t
```

更新代码前先备份。正常更新使用 `sudo git pull --ff-only`，再重新运行安装器（域名必须与 `server.env` 中相同）。备份应在短暂停止服务期间同时复制数据目录与配置文件到私有备份存储；SQLite 在 WAL 模式下不能只复制一个正在使用的 `.sqlite` 文件。不要把备份放到网页目录或 Git 仓库。

## 迁移旧站与切换主域名（尚未执行）

当前 Sites 的正式数据库为 D1，参考图在 R2；GitHub 不包含它们，服务器初始密钥也与旧站不同。

必须在切换主站前单独完成：

- 获取完整、未截断的 D1 数据导出及 R2 参考图对象；现有工具的分页查看结果不是完整备份。
- 安全迁移原 `API_VAULT_KEY`。若平台不提供该密钥导出，需制定保存密钥记录的替代迁移方案，或明确让用户重新添加 API，不能承诺仅复制数据库即可保留 API 使用。
- 核对用户/会话/任务/参考图数量，验证原密码和已保存 API 能否使用；不得把测试用户数据库覆盖到正式数据上。
- 为最终迁移安排短暂停写窗口，保存最终一致快照；避免 DNS 生效期间两个后端同时产生独立记录。
- 在新机签发 `imagemeow.top` 证书，调整 Nginx 的域名/证书与 `PUBLIC_ORIGIN=https://imagemeow.top`，验证后才将根域名的网站 A 记录切至新服务器。检查同名 AAAA、CNAME 等记录以免残留旧入口。
- 保留旧站和备份用于回退；切换后产生的新数据需要一并考虑，不能只切回 DNS 就假定数据已回退。

这些步骤需要另行操作。安装预览服务不会自动执行数据迁移、修改原 Sites 配置、切换主域名或删除旧站。
