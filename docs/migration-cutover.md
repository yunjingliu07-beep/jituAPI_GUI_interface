# 从 Sites 迁移至香港服务器

工具由 `server/migration-transfer.mjs` 提供。导出包使用 AES-256-GCM 加密，再用目标服务器 RSA 公钥封装 AES 密钥；服务器私钥必须保留在 `/etc/image-meow/migration-private.pem`，不上传或提交 Git。迁移包不进入 GitHub。导入前必须核对操作者提供的 SHA-256 校验值。

## 快照与传输

1. 旧站 `MIGRATION_MODE=frozen` 并部署生效后，所有应用路由暂停，只有 `/api/migration-status` 返回冻结状态及迁移 ID。该检查发生在读取数据库之前，也会阻止 GET 查询任务和会话清理所引发的写入。旧部署在途请求需完成后才能采集最终快照。
2. 用 Sites 数据库读取工具逐表分页，严格使用每页返回的 `next_offset`，保留完整结构化结果。若出现截断的单元格、遗漏列或未能遍历的行，不能生成最终包。最终快照前后至少两次读取并比较整个内容，确认一致；不能把工具的模型投影遗漏误当成没有数据。
3. 迁移 `users`、`conversations`、`tasks`、`api_profiles` 及所有原参考图。包含原 API 加密主密钥，并验证它确实能解密 API 记录且与记录中的密钥哈希一致。原登录会话、验证码和限流计数不迁移，用户在新机重新登录。
4. 如快照出现参考图，需逐一获取原对象并校验大小及 SHA-256；缺少任何被引用的对象时，打包和导入会失败。生成结果的外部 URL/供应商保留时间不因迁移而延长。
5. 加密包下载后，通过 Workbench 文件管理上传至服务器 `/tmp/image-meow-migration.enc`。上传的只有密文。文件管理入口参见阿里云官方 Workbench 文件传输文档。

## 在服务器导入

先更新代码：

```bash
cd /opt/image-meow
sudo git pull --ff-only
```

确认上传文件及 SHA-256 后执行（将 `实际校验值` 换成操作者提供的 64 位值）：

```bash
sudo node server/migration-transfer.mjs import /tmp/image-meow-migration.enc 实际校验值
```

工具先解密并验证全部数据，在独立临时目录建库，校验行数、密码字段、外键、数据库完整性和原 API 解密能力。验证成功后才停止预览服务，将当前测试数据库、图片和配置移动至 root-only 的 `/var/backups/image-meow-migration-*`，安装旧站快照及原加密主密钥并重启。导入后的健康检查失败时自动尝试恢复备份；发生失败后应核对服务状态再重试。

成功输出包含 `ok: true`、各表行数、快照时间和备份目录。预览环境当前测试数据会保存在备份中，迁移后以旧站数据为准，不会把测试账号和旧账号混合覆盖。导入后使用原站账号登录，检查历史、API 列表和会话；不要在旧站和预览环境同时生成新数据。

## 根域名证书与切换

为避免修改 A 记录前没有根域名证书，先通过 DNS 验证申请证书：

```bash
sudo certbot certonly --manual --preferred-challenges dns --cert-name imagemeow.top -d imagemeow.top
```

按 Certbot 提示在原 DNS 面板添加 `_acme-challenge` TXT，确认解析值后继续。此时主站 A 记录保持不变。

数据验证通过且根域名证书就绪后：

```bash
cd /opt/image-meow
sudo bash deploy/ubuntu/cutover-domain.sh
```

脚本备份现有配置，将后端来源改为 `https://imagemeow.top`，启用根域名证书，并将 preview 的 HTTP/HTTPS 入口跳转至根域名。用 `--resolve` 在服务器本地验证根域名 HTTPS，无需先修改公网解析；检查失败会尝试恢复旧配置。

成功后在 DNS 将 `@` 的网站 A 记录改为新服务器公网 IP。原托管平台的两个 A 地址都要替换；核对同名 AAAA/CNAME 和线路记录，避免残留旧入口。保留其他邮箱/DNS 验证记录。`preview` 的 A 记录可继续指向同一服务器，作为跳转入口。

解析生效后验证根域名 HTTPS、原密码登录、API、历史及新任务，同时确认 preview 跳转后地址栏显示根域名。

## 改为自动续期

手动 DNS 签发的根域名证书目前不能靠定时任务自动续期。公网解析切换且各地验证已到新服务器后，重新使用 HTTP webroot 签发一次以保存可自动续期的配置：

```bash
sudo certbot certonly --webroot -w /var/www/image-meow-acme --cert-name imagemeow.top -d imagemeow.top --force-renewal
sudo nginx -t
sudo systemctl reload nginx
sudo certbot renew --dry-run
systemctl is-active certbot.timer
```

保留已安装的 Nginx 续期重载钩子。验证成功后可删除此次临时 `_acme-challenge` TXT；不要删除其他服务仍在使用的 TXT。

## 回退

旧站冻结期间其数据仍保留，未删除账号或历史。冻结可通过恢复旧环境变量并重新部署解除。新机导入和域名配置各有独立备份目录。

若切换后发生问题，先暂停新机写入并保存新增数据，再决定恢复配置和 DNS。仅切回旧站 DNS 会遗漏新机切换后新增的记录，不能视为完整回滚。
