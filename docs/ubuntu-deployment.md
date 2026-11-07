# Ubuntu 24.04 自托管部署

当前生产站已于 **2026-11-07 迁移至腾讯云广州服务器**，正式地址为 **https://imagemeow.yoband.cn/**，系统为 Ubuntu 24.04。生产数据使用本机 SQLite 和文件目录；Sites 仅保留暂停的源码镜像。迁移记录见 [生产迁移说明](production-migration.md)。

本文的首次安装步骤只适用于全新实例。当前生产已完成数据恢复，日常维护直接使用下方的更新流程，不要用首次安装创建空数据库或重新生成原加密主密钥。

## 全新实例首次安装

需要 Node.js 24、Nginx、Git、curl。后端仅监听 `127.0.0.1:3000`，轻量应用服务器防火墙对外开放 TCP 80、443；无需对外开放 3000。

仅在已准备好运行环境的全新实例上执行；当前已迁移的生产服务器不需要重复执行：

```bash
sudo git clone https://github.com/yunjingliu07-beep/jituAPI_GUI_interface.git /opt/image-meow &&
cd /opt/image-meow &&
sudo bash deploy/ubuntu/install.sh imagemeow.yoband.cn
```

若目标目录已经存在，先确认内容及 Git 状态，不要清空目录或覆盖未知文件。克隆若要求 GitHub 凭据且您没有访问权限，应先由仓库所有者授权，不能把令牌或密码写进克隆 URL。

成功时返回 `{"ok":true}`。安装器新建无登录权限的 `image-meow` 服务账号，初始化 SQLite，配置 systemd 开机运行，并配置 Nginx 的健康检查和证书校验入口。首次安装随机生成独立加密主密钥，文件为 root-only，不会输出密钥。重复执行保留密钥、数据库和已有 HTTPS 配置。

此阶段 HTTP 的网页入口返回 `HTTPS setup pending.` 属于正常状态；登录 Cookie 要求 HTTPS，证书部署完成后才开放页面。

## 生产域名与 HTTPS

1. 在 `yoband.cn` 的 DNS 平台添加 A 记录：主机记录 `imagemeow`，记录值 `1.12.241.171`。完整记录为 `imagemeow.yoband.cn`，详见 [域名配置](custom-domain.md)。
2. 在腾讯云防火墙或安全组开放 TCP 80、443；若系统启用了 UFW，也需放行这两个端口。保留已有的远程管理通道；不要在不清楚 SSH 端口时重置防火墙。
3. 确认 Nginx 可通过 HTTP 提供 `/.well-known/acme-challenge/` 文件。后端已启动时，`http://imagemeow.yoband.cn/healthz` 应返回 `{"ok":true}`；迁移恢复阶段可以先保持后端停止，只验证证书入口。
4. 安装证书工具并签发证书：

```bash
sudo apt-get install -y certbot &&
sudo certbot certonly --webroot -w /var/www/image-meow-acme --cert-name imagemeow.yoband.cn -d imagemeow.yoband.cn
```

按提示填写用于证书通知的邮箱，并同意证书条款。证书签发需要域名已指向服务器且 80 端口可访问。

5. 启用 HTTPS：

```bash
cd /opt/image-meow &&
sudo bash deploy/ubuntu/enable-https.sh imagemeow.yoband.cn
```

6. 添加续期后重载钩子，验证续期与定时任务：

```bash
sudo install -d -m 0755 /etc/letsencrypt/renewal-hooks/deploy &&
sudo install -m 0755 /opt/image-meow/deploy/ubuntu/reload-nginx.sh /etc/letsencrypt/renewal-hooks/deploy/image-meow-nginx &&
sudo certbot renew --dry-run
systemctl list-timers certbot.timer
```

然后访问 `https://imagemeow.yoband.cn`，验证原账号登录、历史、图片读取和 API 列表；迁移到新域名后需要重新登录。注册、邮件及实际生图按需另行验收，真实生图会使用供应商额度。

## 文件位置与维护

| 路径 | 用途 |
| --- | --- |
| `/opt/image-meow` | GitHub 源代码，root 管理，服务账号不应拥有写权限 |
| `/etc/image-meow/server.env` | 公网来源、端口、数据目录及 API 加密主密钥，权限 0600 |
| `/var/lib/image-meow/studio.sqlite` | 账号、会话、任务及加密 API 记录 |
| `/var/lib/image-meow/references` | 账号私有原参考图、遮罩 |
| `/var/lib/image-meow/generated` | 账号私有生成结果图片，计入个人空间配额 |
| `/etc/nginx/sites-available/image-meow.conf` | 网站域名和 TLS 反向代理配置 |
| `/etc/letsencrypt/live/imagemeow.yoband.cn/` | 当前域名的证书与私钥，私钥不进入仓库 |

`API_VAULT_KEY` 是本站加密密钥，不是即图 API Key。不要发到聊天、截图或 GitHub；不要随意更换。备份时必须同时保留它，单独恢复数据库无法解密已保存的 API。

查看状态：

```bash
systemctl is-active image-meow
sudo journalctl -u image-meow -n 30 --no-pager
sudo nginx -t
```

日常更新由你在服务器手动执行，GitHub 推送不会自动拉取代码：

```bash
cd /opt/image-meow &&
sudo git pull --ff-only origin main &&
sudo bash deploy/ubuntu/update.sh
```

`Already up to date` 只表示 Git 没有新提交，不能作为服务正常的判断。更新脚本会打印停服、备份、迁移、启动和健康检查五个阶段；停服可能需要等待已有请求完成（最多 120 秒），备份耗时取决于数据大小。执行期间保持终端连接，不要同时启动第二次更新。

备份在服务停止时将整个数据目录与配置文件保存至 `/var/backups/image-meow-update-*`，SQLite 在 WAL 模式下不能只复制一个正在使用的 `.sqlite` 文件。不要把备份放到网页目录或 Git 仓库。若更新失败或收到 HUP/INT/TERM，脚本保留非零退出码、备份和错误阶段，并尝试启动原本处于运行状态的服务；这不是代码或数据回滚，也不能保证错误的新代码能启动。强制结束进程或服务器断电时无法保证执行恢复。

若更新命令已经退出，且确认没有更新或迁移进程仍在运行，但服务显示 `inactive (dead)`，先启动服务并检查日志：

```bash
sudo systemctl start image-meow
sudo systemctl status image-meow --no-pager -l
sudo journalctl -u image-meow -n 50 --no-pager
```

如果服务能启动且数据库已完成迁移，纯前端样式更新只需拉取代码并重启，不必再次停服备份和迁移：

```bash
cd /opt/image-meow &&
sudo git pull --ff-only origin main &&
sudo systemctl restart image-meow
```

## 已完成的生产迁移

2026-11-07，旧阿里云香港 Ubuntu 服务器的数据与原版本源码已迁移到腾讯云广州服务器，正式域名更换为 `imagemeow.yoband.cn`。本次为 Ubuntu → Ubuntu 迁移，保留整个数据库、参考图、生成图片、原加密主密钥及邮件配置，不重新执行 Sites 的四表导入流程。迁移过程和恢复要求见 [生产迁移记录](production-migration.md)。

早期 Sites → 香港服务器的步骤保留在 [历史迁移说明](migration-cutover.md)。其中硬编码 `imagemeow.top` 的 `cutover-domain.sh`、`check-root-https.sh` 不适用于当前子域名；当前 HTTPS 使用上方带域名参数的 `enable-https.sh`。

旧服务器保持停服并保留备份，Sites 镜像保持暂停。新站开始写入后，回退需要处理新增数据，不能只切回 DNS 或启动旧服务。


邀请码注册需要先完成数据库迁移及首位站长设置，见 [邀请码上线步骤](invitations.md#ubuntu-首次上线)。新成员使用有效邀请码和注册邮箱验证码；已有账号无需邀请码。
