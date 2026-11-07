# GitHub、Gitee、Sites 与服务器的维护流程

生产网站已于 2026-11-07 迁移到腾讯云广州的 Ubuntu 24.04 服务器，正式地址为 `https://imagemeow.yoband.cn`。`imagemeow.top` 为旧域名。当前部署及迁移说明见 [生产迁移记录](production-migration.md)。Sites 平台中的旧域名绑定记录仍可能保留，不能据此判断公网 DNS 指向。

Sites 项目 `appgprj_6ad3602eac1c8191beccd3a66e796b09` 作为完整源码副本，保留原迁移暂停状态。此次同步包括界面、Worker、Node 服务、迁移、测试和部署脚本；不恢复旧站访问，不复制服务器上的账号、会话、图片或密钥。

## 仓库分工与同步方向

| 位置 | 地址 | 用途 |
| --- | --- | --- |
| GitHub 主仓库 | `https://github.com/yunjingliu07-beep/jituAPI_GUI_interface` | 统一提交代码和文档，以 `main` 为准 |
| Gitee 国内镜像 | `https://gitee.com/Texas0601Blaze/jituAPI_GUI_interface.git` | 自动从 GitHub 单向同步，供生产服务器拉取 |
| Sites 源码镜像 | `appgprj_6ad3602eac1c8191beccd3a66e796b09` | 保留完整源码和暂停状态，每次维护后同步、保存并发布 |
| 腾讯云生产服务器 | `/opt/image-meow` | `origin` 指向 Gitee，由用户手动拉取并按变更类型部署 |

后续无论用户还是助手修改，都遵循：**GitHub → Gitee 自动镜像 → 生产服务器手动拉取**。GitHub 是主仓库；Gitee 只作为读取镜像，不直接编辑或提交，也不配置反向或双向同步。GitHub → Gitee 的自动镜像由平台配置，不代表服务器已经安装自动拉取或自动部署任务。

可从 Sites 项目发起修改，无需每次另行指定 GitHub 地址。维护时检查 GitHub `main` 是否出现较新提交，完成修改后把相同源码树同步至 GitHub 和 Sites，并保存、发布对应的 Sites 版本，保留两端提交历史。开发工作区的 `origin` 可继续指向 GitHub；只有生产服务器使用 Gitee `origin`，不要把开发提交误推到镜像。

提交后记录 GitHub 的目标提交 SHA，确认 Gitee `main` 已同步该提交，再通知用户更新服务器。镜像同步可能有延迟；若受网络或权限限制无法验证，应明确说明，并让用户在服务器核对，不要把推送 GitHub、导入 Gitee 或发布 Sites 当作生产已经更新。

## 生产服务器的拉取地址

生产服务器直连 GitHub 曾出现 443 连接超时，因此使用 Gitee 镜像。以下命令仅在腾讯云生产服务器执行，用于核对地址和镜像的 `main` 提交：

```bash
cd /opt/image-meow &&
sudo git remote get-url origin &&
sudo git ls-remote origin refs/heads/main
```

地址应为 `https://gitee.com/Texas0601Blaze/jituAPI_GUI_interface.git`，提交 SHA 应与本次要部署的 GitHub 提交一致。如果服务器仍指向 GitHub，可一次性切换：

```bash
cd /opt/image-meow &&
sudo git remote set-url origin https://gitee.com/Texas0601Blaze/jituAPI_GUI_interface.git
```

以上配置不修改开发工作区的 GitHub 远端，不需要重新克隆网站或传输数据库、图片。

## 按变更类型更新服务器

仅同步 Markdown 等文档时，拉取即可，无需重启：

```bash
cd /opt/image-meow &&
sudo git pull --ff-only origin main
```

构建配置和运行代码若有变化，按其实际影响重新构建或重启；若存在尚未应用的数据库迁移，则使用备份更新脚本：

**服务器拉取代码必须使用 `sudo git pull`。** `/opt/image-meow` 由 root 管理，普通登录用户直接运行 `git pull` 会遇到所有权检查或 `.git/FETCH_HEAD: Permission denied`。`safe.directory` 只处理 Git 的信任检查，不授予写权限。后续任务提供服务器命令时应保留 `sudo`，并用 `&&` 连接依赖步骤，确保拉取失败时停止。不要通过更改源码目录所有者或放宽权限来解决；服务账号应保持无源码写权限。

```bash
cd /opt/image-meow &&
sudo git pull --ff-only origin main &&
sudo bash deploy/ubuntu/update.sh
```

没有数据库变更的纯前端更新，且服务器已完成此前迁移时：

```bash
cd /opt/image-meow &&
sudo git pull --ff-only origin main &&
sudo systemctl restart image-meow
```

服务器显示 `Already up to date` 仅表示与当前 Gitee 镜像一致，不能证明 Gitee 已同步 GitHub 的最新提交，也不代表服务健康。核对提交 SHA 后再按 [部署指南](ubuntu-deployment.md#文件位置与维护) 检查服务。

## 自动镜像的维护

Gitee 仓库的「管理 → 仓库镜像管理」使用 Pull 方向（GitHub → Gitee），并启用「自动从 GitHub 同步仓库」。镜像失败时查看平台状态，核对绑定仓库、授权和令牌有效期。GitHub 私人令牌到期或撤销后，需要在 Gitee 安全配置中更新；令牌不写入 Git、远端 URL、服务器配置示例或聊天。

源码同步只传代码和文档差异，不包含生产数据库和图片，也不会自动重启网站；正式数据备份独立执行。

## 数据库兼容

Ubuntu 已执行的 `drizzle/0006_owner_activity.sql` 包含历史调用记录回填，保持原样。Sites 的新迁移只变更 schema，因此构建时用 `drizzle/sites/0006_owner_activity.sql` 替换部署包中的同名文件；此前的迁移和 journal 保持一致。该覆盖文件只移除历史回填，保留相同的表、索引与触发器；它不会把服务器的调用历史带入 Sites。后续真实新调用仍按业务代码记录，但目前 Sites 保持暂停。

数据库、上传文件、加密主密钥与邮件配置由两种部署独立管理。除非另外获得明确指令，不迁移数据、不解除暂停、不改变 DNS，也不改服务器配置。

## Sites 构建与打包

构建后运行 `node scripts/package-sites.mjs /绝对路径/deployment.tar.gz`。打包脚本将 `.openai/hosting.json`、`dist/server/index.js` 和 schema-only 的 `drizzle/` 放到部署包根目录。平台不会从 `dist/drizzle/` 查找迁移，因此不能直接把整个 dist 目录打包后就视为数据库已升级；部署后应核对 schema。源码必须先推送，再用该提交保存版本和发布，保持原暂停与运行配置不变。
