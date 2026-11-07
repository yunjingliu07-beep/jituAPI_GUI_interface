# image meow 域名配置

当前正式地址：**https://imagemeow.yoband.cn/**。

2026-11-07，生产站已从阿里云香港服务器迁移到腾讯云广州服务器，系统为 Ubuntu 24.04。旧域名 `imagemeow.top` 不再作为当前正式入口。GitHub 与 Sites 保存源码；暂停中的 Sites 镜像及其保留的旧域名绑定不代表生产 DNS 路由。迁移记录见 [生产迁移说明](production-migration.md)。

## 当前 DNS 记录

在管理 `yoband.cn` 的 DNS 平台中配置：

| 类型 | 主机记录 | 记录值 | TTL |
| --- | --- | --- | --- |
| A | `imagemeow` | `1.12.241.171` | 平台默认值 |

记录对应的完整主机名为 `imagemeow.yoband.cn`，不要把 `https://` 或路径填入主机记录、记录值。修改同名记录时核对是否有指向其他服务器的 CNAME 或 AAAA；邮箱和其他子域名记录独立维护。

这是直接解析到腾讯云服务器的 A 记录，不依赖 Sites 的自定义域名验证。更新本文件、推送 GitHub 或发布 Sites 均不会自动修改 DNS。

## Nginx 与 HTTPS

- 后端仅监听 `127.0.0.1:3000`，由 Nginx 代理公网请求。
- 公网入口使用 TCP 80、443；后端 3000 端口不需要对公网开放。
- Nginx 配置：`/etc/nginx/sites-available/image-meow.conf`。
- 运行配置中的来源：`PUBLIC_ORIGIN=https://imagemeow.yoband.cn`。
- 证书文件：`/etc/letsencrypt/live/imagemeow.yoband.cn/fullchain.pem`。
- 私钥文件：`/etc/letsencrypt/live/imagemeow.yoband.cn/privkey.pem`，只保存在服务器。
- ACME 验证目录：`/var/www/image-meow-acme`；Certbot 自动续期后，通过部署钩子重载 Nginx。

检查当前服务与 HTTPS：

```bash
sudo nginx -t
systemctl is-active image-meow
curl --fail --silent --show-error https://imagemeow.yoband.cn/healthz
systemctl list-timers certbot.timer
```

需要首次签发或配置恢复时，使用 [部署指南](ubuntu-deployment.md#生产域名与-https) 中带当前域名的命令。`deploy/ubuntu/cutover-domain.sh`、`check-root-https.sh` 属于旧域名的历史流程，不能直接用于这个子域名。

## 旧域名与历史快照

`imagemeow.top` 曾用于 Sites 和阿里云香港部署，相关历史流程保留在 [早期迁移说明](migration-cutover.md)。旧域名是否跳转到新站，需单独配置 DNS、HTTPS 和重定向；本次文档更新不代表已经设置跳转。

`docs/site-config.json` 是早期非敏感快照，其中的旧域名、平台 URL 和检查日期不作为当前生产配置。不要为新域名复用旧 Sites 绑定的验证记录。

## 源代码相关位置

- `public/index.html`：站点标题、canonical 与 Open Graph 的静态地址；本次仅更新 Markdown 部署说明，没有修改前端元信息。
- `public/site-icon.png`：登录弹窗、助手头像与 favicon 共用的原始爪印图片。`public/brand-mark.svg` 内嵌同图，保留旧地址兼容。
- `scripts/build.mjs`：将网页与品牌图片打包进 Worker，提供 PNG、ICO 与兼容 SVG 图标入口。
- `.openai/hosting.json`：暂停镜像的站点 ID、D1 和 R2 绑定，保留原值。
