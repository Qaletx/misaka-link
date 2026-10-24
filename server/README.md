# qaletx link Server

这是 qaletx link 的 Node.js 登录服务。极简部署入口为项目根目录的 `server.js`，同目录放置 `.env` 即可启动。默认监听 `0.0.0.0:8787`，密码使用 Node.js `scrypt` 加盐哈希保存。

宝塔 PM2 部署步骤请看 `BAOTA-DEPLOY.md`。

服务端现在自动记录详细登录日志：账号、电脑名、系统/版本、来源 IP、成功/失败及原因；密码和令牌不会记录。查看位置和轮转配置见 [登录日志](LOGIN-LOGS.md)。

