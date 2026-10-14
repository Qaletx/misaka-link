# qaletx link 服务端：两文件宝塔部署

只需上传同一目录下的两个文件：**server.js** 和 **.env**。不需要 package.json、node_modules、npm install 或单独数据库。服务端使用 Node.js 内置模块；Node.js 18+ 可运行，实际部署请选择宝塔提供的仍受维护的 LTS 版本。

## 1. 上传并编辑配置

在宝塔「文件」中新建目录，例如 /www/wwwroot/qaletx-link-api，把 server.js 上传进去，把 .env.example 改名为 .env 后一起上传。编辑 .env：

```text
MISAKA_HOST=0.0.0.0
MISAKA_PORT=8787
MISAKA_TOKEN_SECRET=请替换为至少32字符的随机密钥
MISAKA_USER_PASSWORD=填写user的初始密码
MISAKA_ROOT_PASSWORD=填写root的初始密码
MISAKA_CORS_ORIGIN=null
MISAKA_TRUSTED_PROXIES=
```

两个初始密码需为 8-256 字符。随机密钥至少 32 字符，可在安装了 Node.js 的终端执行以下命令生成后填入：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

.env 自动按 server.js 所在目录读取，不受 PM2 启动工作目录影响。引号中的 #、= 和中文会原样保留；不要在配置值末尾添加行内注释。已有 PM2 环境变量优先于 .env，如果修改 .env 没生效，请检查并移除旧的同名 PM2 环境变量后重新启动。

## 2. 宝塔 PM2 添加项目

在「PM2 管理器 → 添加项目」选择：

| 字段 | 填写内容 |
| --- | --- |
| 名称 | qaletx-link-server |
| 启动文件 | /www/wwwroot/qaletx-link-api/server.js |
| 项目目录 | /www/wwwroot/qaletx-link-api |
| Node 版本 | 已安装的 LTS 版本 |
| 端口 | 8787 |
| 实例数 / 模式 | 1 / fork |
| 文件监听 watch | 关闭 |

配置已写在 .env 中，无需再在 PM2 重复填写。运行用户（通常为 www）需要能读取 .env、server.js，并有权在该目录创建和写入 data。权限报错时通过宝塔「文件 → 权限」调整拥有者，不要设为所有人可写。

命令行启动同样只需：

```bash
node /www/wwwroot/qaletx-link-api/server.js
```

仅运行一个进程；此版本使用本地 JSON 文件存储，不支持多个 PM2 实例同时写入。关闭 watch 可避免写入用户数据时反复重启。

## 3. 检查健康状态

在宝塔终端执行：

```bash
curl http://127.0.0.1:8787/api/health
```

响应含 "ok":true 说明 API 启动成功。根路径 / 不是管理网页；用桌面客户端的 root 账号进入用户管理。

首次启动自动生成：

```text
qaletx-link-api/
├── server.js
├── .env
└── data/
    └── users.json
```

users.json 保存用户信息与加盐密码哈希。备份并保留此文件。修改 .env 的初始密码不会覆盖已有用户；密码修改通过客户端或对应 API 完成。

## 4. HTTPS 与客户端地址

在宝塔「网站」为 API 域名创建站点，配置 DNS 指向服务器并申请 SSL，设置反向代理：

```text
目标 URL：http://127.0.0.1:8787
```

使用同机 Nginx 代理时，可将 .env 改为：

```text
MISAKA_HOST=127.0.0.1
MISAKA_TRUSTED_PROXIES=127.0.0.1,::1
```

Nginx 必须按实际连接来源覆盖 X-Forwarded-For，建议在代理配置使用：

```nginx
proxy_set_header X-Forwarded-For $remote_addr;
```

这样外部只访问 HTTPS，8787 无需对公网开放。使用不同机器的代理时，只列出确实由你控制的代理 IP，不支持 * 或网段；未配置可信代理时，服务端忽略 X-Forwarded-For，以实际 TCP 来源限流。经过代理但不设可信代理会把所有客户统计在代理的同一个来源地址下。

**当前桌面登录页只有账号和密码，不能填写服务器地址。** API 地址在构建客户端时通过 VITE_API_URL 设置，例如 https://link-api.example.com。更换 API 地址后，需要使用该地址重新构建并分发客户端；只改服务端 .env 不会改变已安装客户端的地址。使用原有内置地址的客户端，需要服务器继续在该地址提供服务。

CORS 配置指的是**发起请求的页面来源**，不是 API 域名。打包的 Electron 页面由 file:// 加载，其 Origin 为 null，保留 MISAKA_CORS_ORIGIN=null 即可；如果请求由 Electron 主进程发送且没有 Origin 头，也可正常调用。需要兼容网页开发时可设置 null,http://127.0.0.1:5173。HTTPS 保护账号密码的传输，CORS 本身不代替登录鉴权。

## 5. 账号、会话和升级

- root 可创建、删除普通账号，重置密码，停用账号和设置到期时间。root 本身不可删除、停用或设到期。
- 普通用户可用当前密码修改自己的密码，成功后需重新登录。
- 密码重置、删除、停用、变更有效期会立即撤销该账号的全部 API 会话。到期账号每次请求都会被拒绝，客户端应退出登录并断开连接。
- 会话最长有效 7 天，每个账号最多保留最近 10 个会话。会话仅在内存中保存，重启服务后所有客户端需要重新登录；账号与修改后的密码保留。
- 同一来源每 10 分钟最多允许 20 次登录尝试（成功也计入），修改自身密码另有同等限流。遇到 429 时等待后重试。JSON 请求上限 64 KiB。
- 保存用户数据使用临时文件与原子替换；写入失败不会把未保存的用户状态应用到内存中。仍应定期备份 data。
- 升级时停止旧进程，备份 .env 和 data，替换 server.js 后启动。旧版用户记录会自动补齐 disabled=false、expiresAt=null。若从旧入口 server/index.cjs 迁移，请把原来的 server/data/users.json 复制到新 server.js 同级的 data/users.json，已有目标数据时先核对备份，不要直接覆盖。
- **这些限制控制的是账号 API 权限，并不撤销 Hysteria2 服务端的节点凭据。** 真正阻止已获取节点凭据的人在其他软件使用，需要在 Hysteria2 服务端实施独立认证或更换凭据；隐藏客户端复制按钮不等于服务端撤销。

## API 对接

所有受保护端点使用 Authorization: Bearer <token>。safeUser 的字段为 username、role、disabled、expiresAt、createdAt、updatedAt，不返回密码哈希或盐。

| 接口 | 请求 / 权限 | 响应 |
| --- | --- | --- |
| POST /api/login | {username,password} | {token,user} |
| GET /api/me | 当前有效会话 | {user}，完整 safeUser |
| POST /api/logout | 注销当前 token，可重复调用 | {ok:true} |
| POST /api/me/password | {currentPassword,password} | {ok:true,user,reLoginRequired:true} |
| GET /api/users | root | {users:[safeUser,...]} |
| POST /api/users | root，{username,password} | 201，{user}，只创建 user 角色 |
| PATCH /api/users/:username/password | root，{password} | {ok:true,user} |
| PATCH /api/users/:username | root，{disabled?:boolean,expiresAt?:ISO字符串或null} | {ok:true,user} |
| DELETE /api/users/:username | root | {ok:true} |
| GET /api/stats | root | {userCount,activeSessions,uptime} |
| GET /api/health | 无需登录 | {ok:true,service,time} |

expiresAt 需要包含时区，例如 2027-01-31T23:59:59+08:00，null 表示不限期。PATCH 至少提供一个允许字段，其他字段会被拒绝；返回时间统一为 UTC ISO 格式。请求类型或格式不正确返回 400、无效会话返回 401、权限不足返回 403、用户不存在返回 404、用户名重复返回 409、内容过大返回 413、限流返回 429。密码正确但账号停用或到期的登录请求返回 403。

