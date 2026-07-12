# 步骤 3：桌面客户端开发说明 (Electron App)

本项目客户端采用 **Electron** 框架，旨在提供一个高度稳定、交互华丽且极速的多线程加速生信原始数据下载环境。

---

## 主要特性

1. **多协议生信源智能解析与大小核对**：
   - **SRA Raw**：检验 AWS S3 SRA 路径并拉取文件大小。
   - **EBI Raw**：拉取 EBI fastq_ftp 地址，如 EBI 数据库查无此项，回退拉取 AWS SRA 保证下载成功率。
   - **GEO Suppl**：爬取 GEO supplementary 文件链接并提取下载地址与大小。
   - **Target Links**：支持直接输入 HTTP/HTTPS 下载链接。
2. **Clash 代理守护进程化**：
   - 在用户开启下载时，本地后台自动根据用户 token 从云端鉴权服务器（端口 13000）获取专属 Clash 节点配置。
   - 动态拷贝 GeoIP/GeoSite 数据库，多进程启动并健康监控本地 `7890` 端口代理服务。
   - 用户注销或关闭客户端时，自动关闭 Clash 守护进程，杜绝端口残留或资源浪费。
3. **Axel 16线程加速与进度实时回调**：
   - 组装系统代理环境变量为 `http://127.0.0.1:7890`。
   - 多线程子进程启动内置的 `axel -n 16` 执行高速并行下载。
   - 实时解析 stdout 输出进度 `[ 48%]` 与速度 `[ 20.3 KB/s]` 并实时渲染至 Electron UI 界面。
   - 下载结束后，向云端服务器自动上报该文件的最终实际体积，实现精确扣除流量额度。
4. **易支付与开发者调试模拟充值**：
   - 支持 Alipay/WeChatPay 套餐选择。
   - 开启 `ENABLE_MOCK_PAYMENT` 时，订单支持调用模拟支付接口直接秒速完成余额充值，极大加速开发环境自测试。

---

## 运行与编译说明

### 本地开发运行
1. 安装依赖：
   ```bash
   cd 03_desktop_app
   npm install
   ```
2. 启动开发模式：
   ```bash
   npm start
   ```

### 打包打包分发
本应用使用 `electron-builder` 进行打包。应用已经配置了 `extraResources`，在打包时会自动把 `bin` 目录下的 Clash & Axel 的 Mac 与 Windows 二进制程序包打进最终的文件中：
* **打包为 macOS (dmg)**:
  ```bash
  npm run dist
  ```
* **打包为 Windows (exe)**:
  需要在 Windows 环境下执行并运行对应的 npm run dist 指令，确保 msys axel DLL 按照步骤 2 的 README 完整拷贝到位。

---

## 报错与解决途径

### 1. 运行 `npm start` 提示 `Electron failed to start`
* **原因**：网络问题导致 node_modules 内的 Electron 二进制文件下载不完整。
* **解决**：在 `03_desktop_app` 根目录下执行：
  ```bash
  export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
  npm install electron --save-dev
  ```

### 2. 下载开始后提示 `Axel binary not found` 或权限被拒绝
* **原因**：打包后的二进制文件在不同系统环境下由于安全策略，丢失了 `chmod +x` 的执行权限。
* **解决**：主进程已增加了动态的权限自修复机制：在每次启动 Axel/Clash 时，自动调用 `fs.chmodSync(path, '755')`，避免执行报错。
