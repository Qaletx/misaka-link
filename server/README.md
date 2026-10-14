# qaletx link Server

这是 qaletx link 的 Node.js 登录服务。极简部署入口为项目根目录的 `server.js`，同目录放置 `.env` 即可启动。默认监听 `0.0.0.0:8787`，密码使用 Node.js `scrypt` 加盐哈希保存。

宝塔 PM2 部署步骤请看 `BAOTA-DEPLOY.md`。


