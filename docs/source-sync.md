# GitHub、Sites 与服务器的维护流程

`imagemeow.top` 的生产网站运行在 Ubuntu 服务器上。Sites 平台中的域名绑定记录仍可能保留，不能据此判断公网 DNS 指向。

Sites 项目 `appgprj_6ad3602eac1c8191beccd3a66e796b09` 作为完整源码副本，保留原迁移暂停状态。此次同步包括界面、Worker、Node 服务、迁移、测试和部署脚本；不恢复旧站访问，不复制服务器上的账号、会话、图片或密钥。

后续可从此 Sites 项目发起修改，无需每次另行指定 GitHub 地址。维护时仍需检查 GitHub `main` 是否出现较新提交，完成修改后将相同源码树同步至 GitHub 和 Sites，并保存、发布对应的 Sites 版本。两套仓库的提交历史可不同，但最终文件应一致。这是每次维护时执行的同步流程，没有安装自动拉取、定时部署或 webhook。

GitHub 仓库：`https://github.com/yunjingliu07-beep/jituAPI_GUI_interface`。服务器由用户手动拉取更新；发布 Sites 不更新生产服务器。仅同步维护文档、构建配置时，在服务器拉取代码即可；若运行代码有变化，需重启，若存在尚未应用的迁移则使用更新脚本：

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

## 数据库兼容

Ubuntu 已执行的 `drizzle/0006_owner_activity.sql` 包含历史调用记录回填，保持原样。Sites 的新迁移只变更 schema，因此构建时用 `drizzle/sites/0006_owner_activity.sql` 替换部署包中的同名文件；此前的迁移和 journal 保持一致。该覆盖文件只移除历史回填，保留相同的表、索引与触发器；它不会把服务器的调用历史带入 Sites。后续真实新调用仍按业务代码记录，但目前 Sites 保持暂停。

数据库、上传文件、加密主密钥与邮件配置由两种部署独立管理。除非另外获得明确指令，不迁移数据、不解除暂停、不改变 DNS，也不改服务器配置。

## Sites 构建与打包

构建后运行 `node scripts/package-sites.mjs /绝对路径/deployment.tar.gz`。打包脚本将 `.openai/hosting.json`、`dist/server/index.js` 和 schema-only 的 `drizzle/` 放到部署包根目录。平台不会从 `dist/drizzle/` 查找迁移，因此不能直接把整个 dist 目录打包后就视为数据库已升级；部署后应核对 schema。源码必须先推送，再用该提交保存版本和发布，保持原暂停与运行配置不变。
