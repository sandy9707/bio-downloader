# 步骤 1：后端服务器开发说明

本项目后端服务器负责管理用户注册登录、流量计费套餐订单、流量消耗上报，以及通过 Token 认证分发 Clash 代理配置。

---

## 部署信息

* **部署服务器**：配置于 `.env` 文件的 `DEPLOY_SERVER` 变量
* **工作目录**：`/home/tenney/app/bio-downloader-server`
* **绑定端口**：`13000`
* **PM2 进程名**：`bio-downloader-server`

---

## 核心设计原理

### 1. 并发 Axel 引擎与代理控制
* 每次启动下载时，前端请求 `/api/user/info` 核对 Token 状态与可用流量。
* 状态有效时，客户端自动在本地 43289 端口启动 Clash 子进程，代理转发规则分流：生信数据库连接（EBI/NCBI）走代理高速出海；其他连接直连，不消耗服务器流量。
* 调用本地 `axel` 引擎启动最高 16 线程的并发块下载。

### 2. 流量限额与到期机制
* 注册赠送：默认赠送 `200MB` 的免费测试额度，有效期 `2` 天。
* 用户消费额度通过 `trafficLimit` (流量限制，单位字节) 和 `trafficConsumed` (已消耗流量，单位字节) 进行追踪。
* 客户端完成每次 Axel 下载任务后，计算下载文件的实际字节大小，并向 `/api/user/consume` 上报以从额度中扣除。

### 3. Clash 订阅反代安全拦截
* 用户请求 `http://<your_server_ip>:13000/speedup?token=USER_TOKEN` 来拉取 Clash 配置。
* 接口首先验证 `USER_TOKEN` 存在、未过期且有剩余额度。
* 校验通过后，服务器向底层的开发者高带宽 Clash 订阅拉取配置并返给客户端；校验不通过直接拦截并返回 `403 Forbidden`。**这完美隐藏了开发者本身的 Clash 订阅链接（内含高速节点账号密码）**。

---

## 接口规范 (API Docs)

### 1. 认证接口
* **注册**
  * `POST /api/auth/register`
  * 请求参数: `{ "username": "xxx", "password": "xxx" }`
  * 响应: `{ "success": true, "token": "xxx", "expireAt": "xxx" }`
* **登录**
  * `POST /api/auth/login`
  * 请求参数: `{ "username": "xxx", "password": "xxx" }`
  * 响应: `{ "success": true, "token": "xxx", "expireAt": "xxx", "trafficLimit": 209715200, "trafficConsumed": 0 }`

### 2. 业务与流量上报接口
* **获取用户信息**
  * `GET /api/user/info?token=xxx`
  * 响应: `{ "success": true, "username": "xxx", "expireAt": "xxx", "trafficLimit": 209715200, "trafficConsumed": 0, "isActive": true }`
* **上报流量消耗**
  * `POST /api/user/consume`
  * 请求参数: `{ "token": "xxx", "bytes": 1024555 }`
  * 响应: `{ "success": true, "trafficLimit": 209715200, "trafficConsumed": 1024555 }`

### 3. 支付模块 (易支付 & 模拟支付)
* **获取套餐**
  * `GET /api/pay/packages`
  * 响应套餐列表，包含 100G (10元, 60天) 及 100MB 测试包。
* **创建订单**
  * `POST /api/pay/create`
  * 请求参数: `{ "token": "xxx", "packageId": "pkg_100g", "payType": "alipay" }`
  * 响应: `{ "success": true, "checkoutUrl": "..." }`
* **易支付回调通知**
  * `ALL /api/pay/notify`
* **模拟支付确认 (供调试)**
  * `POST /api/pay/mock-confirm`
  * 请求参数: `{ "orderId": "..." }`

---

## 报错与解决途径

### 1. PM2 部署提示 `SCRIPT NOT FOUND`
* **原因**：第一次运行 PM2 start 时指定的路径问题。
* **解决**：在 `deploy.sh` 中增加删除原有同名进程的操作，直接使用 `pm2 start server.js --name bio-downloader-server` 进行绝对名称启动。

### 2. 模拟收银台无法访问
* **原因**：由于运行在端口 13000，需要确保服务器外网端口已开放。
* **解决**：如无法直接开启端口，可在 VPS 层面检查防火墙，本服务器已验证可以正常监听并外网通信。
