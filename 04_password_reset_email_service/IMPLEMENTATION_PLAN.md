# 密码重置邮件服务实现方案

本文档供后续实现 AI 使用，不包含真实 API Key。

## 一、现有系统约束

- 后端：Express + Redis DB 5，代码位于 `01_backend_server/server.js`。
- 桌面端：Electron，认证 IPC 位于 `03_desktop_app/main.js` 和 `preload.js`，界面逻辑位于 `renderer.js`。
- 当前用户结构只有 `username`、`passwordHash`、`token`、`role`，没有邮箱。
- Resend 域名 `auth.yeyeziblog.eu.org` 已验证，发送功能已开启。
- Resend API Key 已保存在项目根目录 `.env`，不得输出到日志、聊天或 Git。

## 二、推荐产品流程

采用“邮件发送 6 位验证码，用户回到 Electron 输入验证码和新密码”的方案。它不依赖额外 Web 重置页面或 Electron Deep Link，当前项目最容易稳定落地。

### 新用户

1. 注册时增加邮箱字段。
2. 后端验证邮箱格式，并确保邮箱唯一。
3. 用户记录保存规范化邮箱（trim + lowercase）。
4. 额外保存邮箱到用户名的索引，便于通过邮箱查找用户。

### 旧用户

1. 登录后在账户信息页增加“绑定邮箱”。
2. 绑定操作必须携带有效登录 Token。
3. 最好先向新邮箱发送绑定验证码，验证成功后才正式绑定。
4. 未绑定邮箱的旧用户不能使用自动找回，需要人工处理或先登录绑定。

### 忘记密码

1. 用户输入邮箱，请求验证码。
2. 无论邮箱是否注册，接口统一返回“如果邮箱存在，验证码已发送”，防止枚举账号。
3. 已注册邮箱收到 6 位验证码，有效期建议 15 分钟。
4. 用户提交邮箱、验证码、新密码。
5. 验证成功后更新 bcrypt 密码哈希、删除验证码、使旧登录 Token 失效。
6. 用户使用新密码重新登录。

## 三、建议接口

```text
POST /api/auth/register
{ username, email, password }

POST /api/user/email/request-code
{ token, email }

POST /api/user/email/confirm
{ token, email, code }

POST /api/auth/password-reset/request
{ email }

POST /api/auth/password-reset/confirm
{ email, code, newPassword }
```

密码重置请求接口必须使用固定的通用响应，不得返回“用户不存在”。

## 四、Redis 建议结构

继续使用现有 `biodl:` 前缀：

```text
biodl:user:{username}                 用户 JSON，新增 email 字段
biodl:email:{normalizedEmail}         对应 username
biodl:email-bind:{normalizedEmail}    邮箱绑定验证码记录，TTL 15 分钟
biodl:password-reset:{normalizedEmail} 密码重置验证码记录，TTL 15 分钟
```

验证码记录建议包含：

```json
{
  "username": "...",
  "codeHash": "...",
  "attempts": 0,
  "createdAt": "ISO 时间"
}
```

不要明文保存验证码。使用服务端秘密进行 HMAC-SHA256，比较时使用恒定时间比较。连续输错 5 次后删除记录。

## 五、安全要求

- 密码至少 8 位，继续使用 bcrypt。
- 验证码使用 `crypto.randomInt(100000, 1000000)`，不要使用 `Math.random()`。
- 请求验证码按 IP 和邮箱双重限流，例如每 15 分钟最多 5 次、60 秒内不可重复发送。
- 验证码只能使用一次，成功后立即删除。
- 修改密码后让旧 Token 失效，同时保留用户已有流量套餐和到期时间，不能重置成新用户试用额度。
- 邮件接口超时应设置为约 15 秒，日志只记录 Resend 邮件 ID，不记录 API Key、验证码或完整邮箱。
- `.env` 只保存在开发机/服务器，部署脚本不得提交或打印它。

## 六、Resend 配置

推荐环境变量：

```dotenv
RESEND_API_KEY=由用户保存的密钥
MAIL_FROM=BioDownloader <no-reply@auth.yeyeziblog.eu.org>
PASSWORD_RESET_SECRET=单独生成的高强度随机字符串
```

API Key 权限已经限定为 `Sending access` 和域名 `auth.yeyeziblog.eu.org`。

## 七、桌面端改动点

- `index.html`：注册区域增加邮箱输入；增加“忘记密码”入口和验证码/新密码表单；账户页增加绑定邮箱区域。
- `renderer.js`：注册传递邮箱；实现请求验证码、确认重置和绑定邮箱的交互；所有错误提示避免泄露账号存在性。
- `preload.js`：暴露对应的最小 IPC 方法。
- `main.js`：转发新增后端接口，不在渲染进程中放 Resend 密钥或调用 Resend。

Resend API Key 必须只存在于服务器端，绝不能打包进 Electron 应用。

## 八、必须覆盖的测试

- 新用户使用有效邮箱注册成功。
- 重复用户名、重复邮箱、非法邮箱被拒绝。
- 未注册邮箱请求重置时仍返回通用成功消息，但不发送邮件。
- 正确验证码能够修改密码。
- 错误、过期、重复使用的验证码均失败。
- 连续输错达到上限后验证码失效。
- 修改密码后旧密码和旧 Token 失效，新密码可登录。
- 密码重置不改变流量余额、套餐和到期时间。
- Resend 超时/失败不会导致服务崩溃，也不会泄露内部错误或账号状态。

## 九、上线顺序

1. 先完成后端和自动化测试。
2. 使用测试邮箱验证真实邮件发送。
3. 给旧用户增加邮箱绑定入口。
4. 再上线新注册邮箱字段和忘记密码界面。
5. 观察 Resend Logs 和服务端错误率。
6. 最后再考虑 HTML 重置网页或 Deep Link。

## 十、现有代码安全债务

检查发现 `01_backend_server/server.js` 中存在多项硬编码的生产敏感配置，包括 Redis 凭据、支付配置、管理员密钥和订阅地址。实现密码重置前后都应把它们迁移到环境变量，并轮换已经进入源码或 Git 历史的密钥。迁移时不要在提交信息、日志或聊天中再次粘贴真实值。
