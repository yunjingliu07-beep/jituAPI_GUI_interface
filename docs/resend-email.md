# Resend 注册验证与找回密码

当前正式站点使用 Ubuntu 的 `image-meow` systemd 服务。生产邮件配置读取 `/etc/image-meow/server.env`；不要把生产密钥写进 Git、网页代码或旧 Sites 站点。

## 1. 验证发件域名

打开 https://resend.com/domains ，添加 `imagemeow.top`。若已存在，打开现有条目即可。启用 Sending，按照 Resend 面板给出的实际记录，在阿里云 DNS 添加 DKIM、SPF/Return-Path 等必需的发送记录，直到 Sending 状态显示 Verified。

- DNS 的主机名、类型、值、优先级和区域相关值必须照当前 Resend 面板填写，不能复用示例值。
- 阿里云主机记录通常填写相对名称，例如 Resend 显示 `resend._domainkey.imagemeow.top` 时填写 `resend._domainkey`；以当前 DNS 面板说明为准。
- 保留现有网站 A 记录、证书验证和已有邮箱记录。Resend 的发送 MX 通常属于它指定的 Return-Path 子域名，不要替换根域名原有收件 MX。
- 注册和找回密码只需要发送事务邮件，无需开启 Receiving 或更换邮箱收件服务。
- 可选的 DMARC 记录如已存在，应调整现有策略，不要重复添加同名策略。

验证通过后可以使用 `image meow <noreply@imagemeow.top>`。若选择验证子域名，发件地址和密钥域名范围都必须与该子域名一致。

## 2. 新建专用密钥

打开 https://resend.com/api-keys ，创建名为 `image-meow-production` 的 Key，权限使用 Sending access，并限制为刚验证的发件域名。旧 Key 的值无法重新查看；无需为了新建 Key 先删除旧 Key。新 Key 完整显示时保存到密码管理器；确认新配置成功并核对旧 Key 未被其他服务使用后，再删除不用的旧 Key。

## 3. 配置 Ubuntu

先将此变更合并到 GitHub 主分支。服务器上按既有备份流程备份代码、数据及配置，再更新：

```bash
cd /opt/image-meow
sudo git pull --ff-only
sudo nano /etc/image-meow/server.env
```

在现有配置末尾添加下列两项；如果已有同名项，替换它们，保持每项只有一行。以下密钥是占位符，须替换为新创建的真实 Key：

```dotenv
RESEND_API_KEY=re_replace_with_your_real_key
EMAIL_FROM="image meow <noreply@imagemeow.top>"
```

保留原有 `PUBLIC_ORIGIN`、`DATA_DIR`、`PORT` 和 `API_VAULT_KEY`。尤其不要重新生成 `API_VAULT_KEY`，否则已有 API 配置无法解密。不要执行会将配置文件完整打印出来的命令，也不要把配置内容粘贴进聊天。

```bash
sudo chmod 600 /etc/image-meow/server.env
sudo systemctl restart image-meow
systemctl is-active image-meow
curl --fail --silent --show-error https://imagemeow.top/api/config
```

配置就绪时响应包含 `emailCodeEnabled: true`、`passwordResetEnabled: true` 和 `registrationRequiresEmailCode: true`。这些字段只表示服务器已加载必要配置，不代表 Resend 域名、密钥权限或实际投递已验证。若缺少邮件配置，已有账号仍可密码登录，注册与找回密码会停用。邮件验证码仍使用 `email_codes` 表；当前邀请码功能还需应用 `0005_invitations.sql`，详见 [邀请码说明](invitations.md)。

服务器需要能通过 HTTPS 访问 `api.resend.com:443`。不需要开放 SMTP 端口。Node 生产入口已把两项邮件环境变量传递到后端；仅修改配置而不更新代码不会启用此功能。

## 4. 实际验收

1. 使用你控制的一个未注册邮箱，切换「注册账号」，填写管理员提供的有效邀请码后点击发送验证码，检查收件箱和垃圾邮件后完成注册。不能跳过邮箱验证码直接注册。
2. 退出登录，点击「忘记密码」，用同一邮箱获取新的找回密码验证码并设置新密码。
3. 确认旧密码无法登录、新密码可登录、其他已登录设备会话失效。
4. 在 Resend Emails 中核对投递事件；API 接受发送不等于已经进入收件箱。若失败，核对 Sending 是否 Verified、Key 的域名范围、发件地址及账号发送限制。

验证码为六位数字，10 分钟有效，最多尝试 5 次且仅能消费一次；注册和找回密码不能混用。重发后旧码失效。相同邮箱每 60 秒最多请求一次、每小时最多 5 次，IP 每小时最多 20 次。验证码不返回给浏览器，不以明文或简单 SHA 保存；数据库保存使用现有服务器秘密密钥计算的 HMAC。发信失败时作废该次验证码，不向客户端暴露供应商原始错误或密钥。

## 官方参考

- https://resend.com/docs/dashboard/domains/introduction
- https://resend.com/docs/dashboard/api-keys/introduction
- https://resend.com/docs/api-reference/emails/send-email
