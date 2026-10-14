# Misaka Link Server

这是给桌面客户端使用的轻量登录服务。默认监听 `0.0.0.0:8787`，数据写入 `server/data/users.json`，密码使用 Node.js `scrypt` 加盐哈希保存。

## 启动

```powershell
$env:MISAKA_TOKEN_SECRET = "换成一段随机长字符串"
$env:MISAKA_USER_PASSWORD = "设置 user 初始密码"
$env:MISAKA_ROOT_PASSWORD = "设置 root 初始密码"
node server/index.cjs
```

首次启动会创建 `server/data/users.json`。服务器上线后请在防火墙放行 8787，生产环境建议在 Nginx/Caddy 后面启用 HTTPS，并把客户端的 `VITE_API_URL` 指向 HTTPS 地址。
