# qaletx link

面向客户的简洁桌面代理客户端：账号密码登录、选择线路、一键连接。Node.js 账号服务支持 root 创建、删除、停用用户，设置有效期和重置密码。当前版本 0.4.0。

## 宝塔部署

只上传 `server.js` 和 `.env`，**无需 package.json、node_modules 或 npm install**。服务端仅使用 Node.js 内置模块。

1. 复制 `.env.example` 为 `.env`，填写至少 32 字符的随机密钥和两个初始密码。
2. 宝塔 PM2 添加项目，启动文件选择 `server.js`，选择受维护的 Node.js LTS 版本，单实例 fork 模式，关闭 watch。
3. 访问 `/api/health`，返回 `ok: true` 即已启动。
4. 升级时先备份 `data/users.json`，覆盖 `server.js` 并重启 PM2；保留用户数据。修改 `.env` 初始密码不会覆盖已有账号。

完整图面字段、权限、HTTPS 反向代理与升级说明见 [宝塔部署说明](server/BAOTA-DEPLOY.md)。Node.js 18+ 可运行。首次启动自动创建 `data/users.json`，会话存在内存，重启后需要重新登录。

## 桌面功能

- 登录页仅展示账号和密码，服务器地址通过构建变量 `VITE_API_URL` 固定。
- 1020 × 700 默认窗口，自定义图标、系统托盘；关闭窗口收起到托盘，托盘退出或退出登录会断开。
- sing-box 配置先校验，再经节点完成实际请求，成功后才开启系统代理。
- 恢复连接前的系统代理、PAC 与绕过设置；若其他软件更改代理则保留其更改。
- 核心异常退出时清理代理，主进程异常退出由独立守护进程尝试恢复；恢复失败保留记录供下次启动处理。
- 真实会话上传、下载、连接时长，脱敏诊断日志；连接过程取消与连续切换串行处理。
- 全局代理 / 绕过局域网（私有 IP）。系统代理覆盖遵循系统代理设置的应用，不等于全设备 TUN；没有“中国大陆分流”的虚假开关。
- 私有主线路不向页面传递分享链接，不提供复制/导出；个人线路可多行导入、去重、保存与删除。
- root 用户管理、自助改密、账号停用与有效期；客户端每 60 秒检查登录会话，连接前再次验证。

## 支持的链接

Hysteria2、TUIC、Trojan、VLESS（含 Reality）、VMess、Shadowsocks（SIP002、旧格式与 2022）、SOCKS5、HTTP/HTTPS；相应协议支持 WS、gRPC、HTTP、HTTPUpgrade 等已实现传输。

未知参数和不支持的组合会说明原因并拒绝导入。SS 插件、XHTTP、mKCP、gRPC multi、Hysteria2 `pinSHA256` 等不在当前实现范围。不能承诺任意 Clash/V2Ray 配置均兼容。

## 构建

桌面开发使用 Node.js 22.12+，`npm ci` 安装锁定依赖。服务端部署无需安装这些依赖。

```sh
npm test
npm run build
node tests/electron-smoke.cjs
npm run dist:win
```

将原版 sing-box 1.14.3 核心放在 `core/`：Windows 使用 `sing-box.exe`（上游 legacy-windows-7 amd64 构建）；macOS 使用 `sing-box-amd64`（legacy-macos-10.13）与 `sing-box-arm64`。Windows 安装版与便携版分别输出 `setup` 和 `portable` 文件名。

通过环境变量 `QALETX_PRIVATE_NODE_URI` 注入私有节点；本地忽略文件 `electron/private-node.cjs` 可重复使用，源码仓库不提交它。云构建缺少 Secret 会明确失败，避免生成没有主线路的客户包。

macOS 工作流 [build-macos.yml](.github/workflows/build-macos.yml) 使用 GitHub macOS runner。配置仓库 Secret `QALETX_PRIVATE_NODE_URI` 与可选变量 `MISAKA_API_URL` 后，手动运行 Actions，在 Artifacts 下载 universal DMG。没有 Apple 开发者签名和公证时，macOS 会进行安全拦截，需要用户手动允许；客户分发前建议配置签名。

## 实际边界

内置凭据始终需要在客户电脑执行，隐藏复制入口不能阻止逆向提取。真正限制外部使用需要 Hysteria2 服务端按用户认证、发放可撤销凭据并执行额度。当前账号服务管理客户端登录，不负责代理服务器流量计费或撤销已有节点密码。

默认 API 配置沿用现有部署地址；对外使用请通过宝塔配置 HTTPS，并以 `VITE_API_URL` 重建客户端。当前 Windows x64 构建基于 Electron 22，以兼顾旧系统；没有 Win7 或 macOS 实机验证结果时，不应宣称所有系统已验收。Electron 22 已属旧运行时，旧系统兼容和运行时安全更新存在取舍。

第三方核心版本、源代码和许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
