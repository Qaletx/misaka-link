# Misaka Link

Misaka Link 是一个面向非技术用户的 Hysteria2 桌面客户端。它把节点导入、选择、连接和状态展示收在一个页面里，并通过一个轻量联网服务提供账号登录和 root 管理能力。

## 当前能力

- Windows 7+ 客户端：已生成 `release/Misaka-Link-0.2.0-x64.exe`（便携版/安装器构建目标均已配置）。
- macOS Intel 与 Apple Silicon：`npm run dist:mac` 已配置为 universal DMG 构建命令，需要在 macOS 机器上执行 Electron 打包。
- 内置默认 Hysteria2 节点，可导入更多 `hysteria2://` 分享链接。
- 登录服务器后，普通账号使用连接中心；root 账号可创建/删除普通用户、查看账号数量与活跃会话、修改 `user` 密码。
- Hysteria2 核心适配层会读取 `core/hysteria(.exe)`；未放入核心时仍可预览 UI 和演示连接流程。

## 联网部署

在服务器上运行：

```powershell
$env:MISAKA_TOKEN_SECRET = "换成一段随机长字符串"
$env:MISAKA_USER_PASSWORD = "设置 user 初始密码"
$env:MISAKA_ROOT_PASSWORD = "设置 root 初始密码"
npm run server
```

服务默认监听 `0.0.0.0:8787`。客户端登录页可以修改服务器地址；构建正式包时也可以通过 `VITE_API_URL=https://你的域名` 注入默认地址。生产部署建议使用 Nginx/Caddy 终止 HTTPS，并只把 8787 暴露在内网或反向代理之后。

`server/data/users.json` 首次启动自动生成，保存的是 scrypt 加盐哈希，不保存明文密码。服务器迁移时请同时迁移这个文件。
