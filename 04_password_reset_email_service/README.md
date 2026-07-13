# 重置密码自动邮件服务

本目录用于实现“用户申请重置密码后，系统自动发送重置邮件”的独立服务。

## 当前状态

前期方案使用 **Resend + Cloudflare DNS**，发信子域名为：

```text
auth.yeyeziblog.eu.org
```

以下三条发送域名 DNS 记录已经能够通过 `1.1.1.1` 正常查询：

- DKIM：`resend._domainkey.auth.yeyeziblog.eu.org`
- MAIL FROM MX：`send.auth.yeyeziblog.eu.org`
- SPF：`send.auth.yeyeziblog.eu.org`

Cloudflare 侧配置和公网传播已经完成。2026-07-13 14:18（Asia/Shanghai）通过 Chrome 确认 Resend 控制台状态为 **verified**，页面提示域名已经可以发送邮件；DKIM、MX、SPF 均为 `verified`，`Enable Sending` 已开启。

2026-07-13 已创建 Resend API Key `password-reset-production`：权限为 `Sending access`，仅绑定 `auth.yeyeziblog.eu.org`。密钥值未写入聊天或仓库，需要从 Resend 当前的一次性显示页面复制到部署环境。

## 下一步

1. 从 Resend 当前的一次性显示页面复制 API Key，并保存到服务器环境变量。
2. 使用 `no-reply@auth.yeyeziblog.eu.org` 发送一封开发环境测试邮件。
3. 实现申请重置密码接口，避免泄露邮箱是否已注册。
4. 生成一次性、短时有效、数据库中仅保存摘要的重置令牌。
5. 实现重置邮件模板、重置页面与密码更新接口。
6. 增加按 IP/邮箱限流、令牌单次使用、密码修改后会话失效和审计日志。
7. 完成成功、过期、重复使用、未注册邮箱和发送失败等场景测试。

建议的环境变量（密钥不要提交到 Git）：

```dotenv
RESEND_API_KEY=re_你的密钥
MAIL_FROM=叶子博客 <no-reply@auth.yeyeziblog.eu.org>
```

## 资料

- [聊天归档](./docs/chat-history.md)
- [原始公开分享页](https://chatgpt.com/share/6a548372-8a14-83ea-b074-70e536e39800)

> 说明：公开聊天中的两个上传文件无法从页面正文还原，本地归档保留了“Uploaded a file”标记及其后的讨论内容。
