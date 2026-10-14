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
MISAKA_PRIVATE_NODE_URI=
```

MISAKA_PRIVATE_NODE_URI 可填要预置的完整节点分享链接，建议用双引号包住。它只在数据库首次创建或首次从旧 users.json 迁移时读取，种入 ID 为 misaka 的私有线路；留空也能启动，之后由 root 在「我的线路」导入并转为私有线路。已有 state.json 时，修改此环境变量不会覆盖线路，也不会恢复已删除的私有线路。不要将真实节点链接提交到公开仓库。

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
    └── state.json
```

state.json 是单一持久数据库，保存账号、加盐密码哈希、云端个人线路、私有线路及个人备注。无需安装 MySQL 或其他数据库。线路记录含连接凭据，只应由服务运行用户读取；不要把 data 目录配置为网站可下载的静态目录。备份时保留整个 data 目录与 .env。修改 .env 的初始密码不会覆盖已有用户；密码修改通过客户端或对应 API 完成。

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

## 5. 三种角色与私有线路分配

| 角色 | 自己修改密码 | 个人线路云同步 | 管理其他用户 | 管理和分配私有线路 |
| --- | --- | --- | --- | --- |
| root（admin 角色的内置超级管理员） | 可以 | 可以 | 可创建、管理 admin/user/shared | 可以 |
| 管理员 admin | 可以 | 可以 | 仅管理 user/shared，不能修改 root 或其他 admin | 不可以 |
| 普通用户 user | 可以 | 可以 | 不可以 | 仅使用 root 已授权的线路 |
| 共用用户 shared | 不可以 | 不可以，导入和备注仅保留本机 | 不可以 | 仅使用 root 已授权的线路 |

共用账号密码只能由管理员重置，这会让该账号的全部设备退出登录。root 本身不能删除、降权、停用或设置有效期。管理员仍可使用「个人中心」修改自己的密码。

root 在「我的线路」导入线路后，可将它转为私有线路；也可直接新增私有线路。支持多个私有线路。转为私有后保留线路 ID，但个人线路原记录不再重复出现。在用户管理中，为目标用户开启私有线路权限，并选中具体线路；开关和分配列表必须同时满足，用户才能获取连接配置。新创建的账号默认不开启私有线路权限；root 始终能管理所有私有线路。

私有线路列表只返回名称、备注等元数据，不返回分享链接。非共用用户可以给自己获授权的私有线路设置个人名称和备注，其他用户看到的内容不变。root 的全局编辑使用私有线路管理接口。个人线路仅由账号本人读取，其他管理员也不能读取其连接信息。

除共用账号外，手动导入的个人线路会保存到服务器，同一账号换电脑登录后即可读取。每个账号最多同步 200 条个人线路，每条名称最多 100 字符、备注最多 500 字符。相同分享链接（忽略末尾 #名称）不会重复保存。并行修改线路时由 revision 检测冲突，后保存的设备会得到 409，需刷新确认后再改，避免悄悄覆盖另一台电脑的修改。

## 6. 从 0.4 升级与备份

1. 在宝塔 PM2 停止旧进程，备份整个 data 目录和 .env。
2. 替换同目录的 server.js，保留原有 .env。如果需要把原来的默认节点纳入权限管理，在第一次启动 0.5 前填写 MISAKA_PRIVATE_NODE_URI。
3. 以 1 个 fork 实例启动，关闭 watch。服务器发现只有 data/users.json 时，自动迁移为 data/state.json，原 users.json 留在原处不删除。
4. 确认健康检查正常后，分发 0.5 客户端。root 登录后在「我的线路」和「用户管理」检查线路及授权。

迁移保留全部密码哈希和有效期，旧 root 的 role 改为 admin，isRoot=true。旧账号默认保留 privateNodeAccess=true、privateNodeIds=["misaka"] 的兼容授权；若未配置预置链接，不会产生可连接的默认线路。新安装创建的 user 账号和以后新建账号默认无私有线路权限，需要 root 分配。

有 state.json 后只使用 state.json，旧 users.json 不再更新。备份恢复应恢复整个 data，不能用旧 users.json 覆盖新数据库，否则会丢失后来保存的线路和改密。若旧入口是 server/index.cjs，首次升级前将其 server/data/users.json 复制到新 server.js 同级 data/users.json；已有目标数据时先核对备份，不要直接覆盖。

保存整个数据库使用临时文件、落盘和原子替换；写入失败时不会应用半套内存变更。删除私有线路会在同一次保存中移除用户分配和相关备注，删除用户也会同时删除其个人线路和备注。

## 7. 会话与连接权限

- 密码重置、修改角色、停用、变更有效期会立即撤销该账号全部 API 会话。到期账号的每次请求都会被拒绝。
- 修改私有线路开关或分配列表不会强制退出登录，但随后获取配置会立即按新授权校验。0.5 客户端连接前和测速前重新鉴权，已连接时定期检查权限，失去授权后断开。
- 会话最长有效 7 天，普通用户和管理员每个账号最多保留最近 10 个会话，共用账号最多保留最近 200 个会话，全服务最多 10000 个会话。会话只在内存中保存，重启服务后客户端需重新登录；账号和线路保留。
- 同一来源每 10 分钟最多允许 20 次登录尝试（成功也计入）；修改自身密码另有同等限流。JSON 请求上限 64 KiB。
- **API 授权不是 Hysteria2 等代理服务端凭据的撤销。** 客户端最终必须拿到凭据才能连接，已获得凭据的人及旧版本客户端不会因 API 开关而自动失去代理服务端访问权。要撤销旧凭据，需要在代理服务端更换凭据或实施独立用户认证，再更新私有线路；不要把隐藏复制按钮当作无法提取凭据的保证。

## API 对接

受保护端点使用 Authorization: Bearer <token>。safeUser 返回 username、role（admin/user/shared）、isRoot、privateNodeAccess、privateNodeIds、disabled、expiresAt、createdAt、updatedAt，以及 permissions={manageUsers,managePrivateNodes,changePassword,syncNodes}；不返回密码哈希或盐。

| 接口 | 请求 / 权限 | 响应 |
| --- | --- | --- |
| POST /api/login | {username,password} | {token,user} |
| GET /api/me | 当前有效会话 | {user} |
| POST /api/logout | 注销当前 token，可重复调用 | {ok:true} |
| POST /api/me/password | 非 shared，{currentPassword,password} | {ok:true,user,reLoginRequired:true} |
| GET /api/users | admin，普通管理员仅看到 user/shared | {users:[safeUser,...]} |
| POST /api/users | admin，{username,password,role?,disabled?,expiresAt?,privateNodeAccess?,privateNodeIds?} | 201，{user} |
| PATCH /api/users/:username/password | 有权管理该账号的 admin，{password} | {ok:true,user} |
| PATCH /api/users/:username | {role?,disabled?,expiresAt?,privateNodeAccess?,privateNodeIds?} | {ok:true,user} |
| DELETE /api/users/:username | 有权管理该账号的 admin | {ok:true} |
| GET /api/stats | admin；数量仅包含可管理账号 | {userCount,activeSessions,uptime} |
| GET /api/nodes | 当前账号可用线路 | {nodes:[node,...]} |
| POST /api/nodes | 非 shared，{uri,name?,note?} | 201 {node}；重复为 200 {node,existing:true} |
| PATCH /api/nodes/:id | 自己的个人线路，{name?,note?,revision} | {node} |
| DELETE /api/nodes/:id | 自己的个人线路 | {ok:true} |
| GET /api/nodes/:id/config | 每次重新验证账号与线路权限 | {uri,node}，node 不含 uri |
| POST /api/private-nodes | 仅 root，{sourceNodeId,name?,note?} 或 {uri,name?,note?} | 201 {node} |
| PATCH /api/private-nodes/:id | 仅 root，{name?,note?,revision} | {node} |
| DELETE /api/private-nodes/:id | 仅 root | {ok:true} |
| PATCH /api/node-annotations/:id | 非 shared，已授权私有线路，{name?,note?} | {node}，应用当前用户的名称和备注 |
| GET /api/health | 无需登录 | {ok:true,service,time} |

node 元数据为 id、name、note、protocol、private、updatedAt、revision；仅自己拥有的个人线路列表项包含 uri，所有私有线路列表项都不包含 uri。sourceNodeId 只能引用 root 自己的个人线路，转换后 ID 保持不变。名称留空按未命名线路处理，个人私有备注的空名称表示使用全局名称；空备注可用于清空自己的备注。

expiresAt 需包含时区，例如 2027-01-31T23:59:59+08:00，null 表示不限期。只有 root 可以创建 admin、编辑 admin，或写入 privateNodeAccess/privateNodeIds；其他管理员只能创建和管理 user/shared。角色变更为 shared 后已有个人线路保留但不可读取或写入，改回非 shared 后恢复可见。

常见状态：400 参数无效，401 会话失效，403 无权限，404 对象不存在，409 用户或私有线路重复/线路修订冲突，413 请求过大，429 限流。密码正确但账号停用或到期的登录请求返回 403。每个异步写请求读完请求体后会重新校验会话和权限。
