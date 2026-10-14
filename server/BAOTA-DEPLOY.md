# qaletx link 服务端：宝塔 PM2 部署

服务端是 **Node.js CommonJS 服务**，入口文件是 `server/index.cjs`，不是 PHP，也不是 Electron。宝塔里推荐使用 Node.js 20 LTS（Node 18+ 也可以）。服务端只依赖 Node 内置模块，不需要安装 Express、数据库或其他运行库。

## 1. 准备项目目录

把项目上传到服务器，例如：

```text
/www/wwwroot/qaletx-link
```

如果只部署服务端，至少上传：

```text
server/index.cjs
server/data/
package.json
```

首次启动会自动创建 `server/data/users.json`，里面保存的是加盐后的密码哈希。

## 2. 在宝塔安装 Node.js

打开「软件商店 → Node.js 版本管理」，安装 Node.js 20 LTS。确认版本：

```bash
node -v
npm -v
```

## 3. 用 PM2 添加项目

打开「软件商店 → PM2 管理器 → 添加项目」，填写：

- 项目名称：`qaletx-link-server`
- 启动文件：`server/index.cjs`
- 项目目录：`/www/wwwroot/qaletx-link`
- 运行端口：`8787`
- Node 版本：`20`

如果宝塔界面有「环境变量」输入框，加入：

```text
MISAKA_HOST=0.0.0.0
MISAKA_PORT=8787
MISAKA_TOKEN_SECRET=请替换为随机长字符串
MISAKA_USER_PASSWORD=你提供的user初始密码
MISAKA_ROOT_PASSWORD=你提供的root初始密码
```

不要把真实密码写进 GitHub 仓库或截图。保存后启动项目。

## 4. 检查服务是否运行

在服务器命令行执行：

```bash
curl http://127.0.0.1:8787/api/health
```

看到 `"ok":true` 就说明 Node 服务正常。PM2 日志可以查看登录失败、端口占用和启动错误：

```bash
pm2 logs qaletx-link-server
```

如果外部客户端直接连接 `http://服务器IP:8787`，需要在宝塔「安全」和云服务器安全组放行 TCP 8787。

## 5. 推荐的正式配置：反向代理 + HTTPS

更推荐在宝塔「网站」中新建一个 API 域名，例如 `link-api.example.com`，申请 SSL 后设置反向代理：

```text
目标 URL：http://127.0.0.1:8787
```

然后在客户端登录页填写：

```text
https://link-api.example.com
```

这样账号密码会通过 HTTPS 传输，不需要对公网暴露 8787。

## 6. 修改初始密码

首次启动完成后，root 登录客户端的「用户管理」即可创建普通用户、删除普通用户、修改 `user` 密码。服务器端的 `server/data/users.json` 要保留，删除它会重新按环境变量创建初始账号。

