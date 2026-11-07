# 生产迁移记录：腾讯云广州与新域名

## 当前生产环境

2026-11-07，image meow 的生产服务器已从阿里云香港迁移至腾讯云广州，正式域名由 `imagemeow.top` 更换为 **https://imagemeow.yoband.cn/**。

| 项目 | 当前配置 |
| --- | --- |
| 云厂商与地域 | 腾讯云，广州 |
| 操作系统 | Ubuntu 24.04，x86_64 |
| 公网 IPv4 | `1.12.241.171` |
| 正式主机名 | `imagemeow.yoband.cn` |
| 运行环境 | Node.js 24、Nginx、systemd、SQLite |
| 源码目录 | `/opt/image-meow`，由 root 管理 |
| 生产拉取远端 `origin` | `https://gitee.com/Texas0601Blaze/jituAPI_GUI_interface.git` |
| 应用服务 | `image-meow.service`，使用无登录权限的 `image-meow` 账号 |
| 后端监听 | `127.0.0.1:3000` |
| 数据目录 | `/var/lib/image-meow` |
| 配置文件 | `/etc/image-meow/server.env`，root 管理、权限 0600 |
| 网站来源 | `PUBLIC_ORIGIN=https://imagemeow.yoband.cn` |

Sites 项目 `appgprj_6ad3602eac1c8191beccd3a66e796b09` 继续作为暂停中的完整源码镜像，与 GitHub 同步。发布 Sites 不会部署到腾讯云，不会复制服务器数据，也不会解除镜像暂停。

## 本次数据迁移

- 旧服务停服后取得冷备份，保留完整 SQLite 数据库及其日志中的已提交数据，不只导出部分用户表。
- 保留整个数据目录，包括账号、权限、邀请码、会话、任务、API 配置、运营记录、存储配额、参考图、遮罩和已保存生成图片。
- 保留原 `API_VAULT_KEY`、`RESEND_API_KEY`、`EMAIL_FROM` 及其他原配置；已保存的 API 继续使用原加密主密钥。
- 传输后核对压缩包 SHA-256；解压后验证数据库完整性、外键、原 API 解密与逐文件校验；恢复到正式目录后比较原始数据和配置。
- 恢复相同版本源码，补齐原 Git 历史和远端关联，并将 `PUBLIC_ORIGIN` 改为新域名。迁移与功能升级、数据库 schema 变更分别处理。
- 为新域名单独申请 HTTPS 证书；旧域名证书不用于新域名。

备份、数据库、配置、图片、Git 凭据和证书私钥均不进入 GitHub 或 Sites 源码仓库。原备份在迁移验收完成前保留。当前生产使用本机 SQLite 和文件目录，不读取 Sites 的 D1/R2 数据。

## DNS 与 HTTPS

在 `yoband.cn` 的解析平台配置 A 记录：主机记录 `imagemeow`，记录值 `1.12.241.171`。Nginx 对外提供 80/443，后端 3000 端口仅监听回环地址。证书位于 `/etc/letsencrypt/live/imagemeow.yoband.cn/`，Certbot 自动续期后使用部署钩子重载 Nginx。完整配置见 [域名说明](custom-domain.md) 和 [部署指南](ubuntu-deployment.md)。

旧域名是否重定向需另行配置。本次域名变更不自动修改 Resend 发件域名或验证记录，也不会迁移浏览器 Cookie；用户需在新域名重新登录。

## 后续维护

GitHub 为唯一修改入口，Gitee 从 GitHub 单向自动同步，腾讯云服务器从 Gitee 手动拉取。生产服务器直连 GitHub 曾超时，不应再把其 `origin` 改回 GitHub；开发工作区仍可使用 GitHub。修改人和助手均应先提交 GitHub，核对 Gitee 的目标提交 SHA，再提供服务器更新命令。配置与故障排查见 [源码同步说明](source-sync.md)。

仅更新 Markdown 等文档时，在服务器拉取即可，无需重启：

```bash
cd /opt/image-meow &&
sudo git pull --ff-only origin main
```

涉及运行代码或数据库迁移时，按 [源码同步说明](source-sync.md) 和 [部署指南](ubuntu-deployment.md#文件位置与维护) 执行对应的重启或备份更新脚本。不要直接运行首次安装器覆盖已迁移数据，也不要重新初始化站长。

上线与维护检查：

```bash
systemctl is-active image-meow
sudo nginx -t
curl --fail --silent --show-error https://imagemeow.yoband.cn/healthz
systemctl list-timers certbot.timer
```

在浏览器中另行验证原账号登录、权限、历史、图片读取、已保存 API 列表和邮件投递；实际生图按需验证，会使用供应商额度。

## 历史与回退

旧阿里云服务器保持停服，避免两端分别写入。新站开始产生数据后，回退前先保存并处理新增数据，不能只恢复旧域名解析或启动旧服务。

[早期 Sites → 香港迁移说明](migration-cutover.md) 仅供历史追溯，其中的四表导入流程和旧域名切换脚本不适用于本次 Ubuntu → Ubuntu 迁移。`docs/site-config.json` 保留早期快照，当前生产信息以本文为准。
