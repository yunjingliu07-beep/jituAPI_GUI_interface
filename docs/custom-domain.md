# image meow 域名配置

主站地址：https://imagemeow.top/

站点仍运行于 Sites；本次是绑定自定义域名，没有迁移到阿里云服务器。域名由用户在阿里云 DNS 配置。站点访问范围由 Sites 的访问策略决定，不会因域名绑定而自动公开。

## 已配置的 DNS 记录

在 `imagemeow.top` 的解析设置中添加以下记录。主机记录为阿里云面板中的相对名称，TTL 与解析线路保持默认。

| 类型 | 主机记录 | 记录值 |
| --- | --- | --- |
| A | `@` | `162.159.143.30` |
| A | `@` | `172.66.3.26` |
| TXT | `_openai-site-verification` | `openai-site-verification=I7gq6c7dotl0uZeoy4cNs2n1UMZLqFA_8WJbETwTz0k` |
| TXT | `_cf-custom-hostname` | `5b8a987d-b3b3-472c-8ed3-ed097b57249d` |

这两条 TXT 是域名验证用公开记录，不是 API 密钥。它们属于当前绑定，不应复用到其他项目或新的域名绑定。平台当前仍返回的验证记录为 `_openai-site-verification`，早期添加的 `_cf-custom-hostname` 记录一并保留。

2026-10-18 确认：域名状态 active、平台状态 active、HTTPS 证书状态 active，无错误。后续状态以 Sites 管理工具的实时返回为准，本文不是实时监控。

## 恢复与变更

- 保留当前站点 ID，使用 Sites 的自定义域名管理能力检查绑定；不要仅修改 GitHub 文件就认为域名已绑定。
- 域名绑定若被删除，应对同一站点重新添加 `imagemeow.top`，以平台新返回的 A/CNAME 与 TXT 记录为准，不要假设验证值始终不变。
- DNS 变更后，刷新域名验证状态，等待域名与 HTTPS 均为 active。
- 当前绑定仅包含根域名 `imagemeow.top`。如需 `www.imagemeow.top`，需要独立添加主机名并按平台返回设置记录。
- 若迁移到其他服务器，需要同时更新托管配置、DNS、HTTPS 和数据库迁移方案。

## 源代码相关位置

- `public/index.html`：canonical、Open Graph URL、站点标题、品牌标志引用。
- `public/brand-mark.svg`：可编辑的猫咪 SVG 标志。
- `scripts/build.mjs`：将网页与标志打包进 Worker，同时提供 `/favicon.svg`。
- `.openai/hosting.json`：站点 ID 和数据库绑定，保留原 ID 与 `DB` 数据库。
- `docs/site-config.json`：非敏感部署信息快照，供维护者核对。
