# CLI与GUI统一入口（开发中，尚未发布）

`biodl gui-get ebi ERR164407 -o Z:\11` 将任务提交给同账户已登录GUI，使用相同下载器、代理、空间预检、中转与历史。`biodl gui-status`返回状态；accepted不代表下载完成。

桌面主进程在127.0.0.1随机端口提供认证桥接，配置文件位于GUI userData，随机令牌不输出。拒绝浏览器Origin及无凭证请求。CLI不启动第二个Mihomo。任务由现有renderer登记与执行，CLI退出后继续，但关闭GUI仍会影响任务；不是独立系统服务。

首版一次提交一批，忙时拒绝。保留传统get作为GUI未启动时的独立前台下载，二者不隐式切换。Mac/Windows支持Electron GUI；Linux无桌面包仍使用原Web/CLI，不虚构Linux GUI服务。

当前发布2.2.5与2.2.6-preview.1无此命令，不能仅修改Skill让旧软件获得功能。更新前须功能探测。

验收：check-desktop-command.js验证回环/凭据/无效任务拒绝；check-desktop-download.js真实通过HTTP桥接提交本地源下载并在GUI完成记录中可见，且模拟官网心跳命令完成同样传输并确认。后端tests/desktop-control.test.js验证账号隔离和命令确认。当前仅Mac源码及隔离API验收，尚无公网全链路或网吧Windows成品验收和新发布。
