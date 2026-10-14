# qaletx link Server

这是 qaletx link 的 Node.js 登录服务。入口文件为 `server/index.cjs`，默认监听 `0.0.0.0:8787`，密码使用 Node.js `scrypt` 加盐哈希保存。

宝塔 PM2 部署步骤请看 `BAOTA-DEPLOY.md`。

