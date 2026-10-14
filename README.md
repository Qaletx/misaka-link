# qaletx link

qaletx link 是一个面向非技术用户的 Hysteria2 桌面客户端。客户端负责节点导入和连接，Node.js 服务端负责登录、账号和 root 管理。

服务端部署请看 [`server/BAOTA-DEPLOY.md`](server/BAOTA-DEPLOY.md)。

# qaletx link

## 宝塔服务器端（极简部署）

服务器端已经整理为单文件模式，只需要上传以下两个文件到同一个目录：

- `server.js`
- `.env`（可由 `.env.example` 复制后修改）

`.env` 示例：

```env
MISAKA_HOST=0.0.0.0
MISAKA_PORT=8787
MISAKA_TOKEN_SECRET=请填写随机长字符串
MISAKA_USER_PASSWORD=请填写user密码
MISAKA_ROOT_PASSWORD=请填写root密码
```

宝塔 PM2 管理器中添加项目，启动文件填写 `server.js`，项目目录填写这两个文件所在目录，Node.js 选择 18 或 20。服务端只使用 Node.js 内置模块，不需要 `npm install`。

启动后测试：

```text
http://服务器IP:8787/api/health
```

首次启动会自动创建 `data/users.json`，请保留这个文件，它保存用户和密码哈希。

## 桌面端核心与托盘

桌面端发布包会随附 sing-box 核心。点击连接时自动启动核心并打开系统代理 `127.0.0.1:10808`；断开、核心异常退出或从托盘选择「退出」时恢复原有系统代理。登录页只显示账号和密码，服务端地址固定在构建配置中。

当前客户端支持 Hysteria2、TUIC、VLESS（TCP/WS/gRPC/Reality 基础参数）、VMess、Trojan、Shadowsocks、SOCKS5 和 HTTP 分享链接。内置 qaletx 主节点由主进程按内部标识加载，前端不保存、不展示、不提供复制入口；导入的普通节点会保存在本机并可复制。系统代理只在真实核心成功启动后开启，核心校验失败会阻止连接。

构建安装包时通过 `QALETX_PRIVATE_NODE_URI` 注入主节点。这个变量不要提交到 GitHub；macOS Actions 使用仓库 Secret `QALETX_PRIVATE_NODE_URI`，本地 Windows 构建前在当前终端设置同名环境变量。未设置时仍可运行，但内置主节点不会建立连接。

