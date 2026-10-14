# 宝塔部署 0.6 与 Hysteria2 真实流量接管

账号服务仍只需要 `server.js` 和 `.env`，无需 package.json 或 npm install。新增接管功能还需要修改你已经运行的 Hysteria2 服务配置，不需要另装一个 Node 项目。

## 1. 更新账号服务

在宝塔 PM2 停止项目，备份原 `.env` 与整个 `data/` 目录，再覆盖 `server.js`。保留原密钥、密码、端口和数据。选择 Node.js 18+，单实例 fork，关闭 watch。数据库版本 2 会自动备份后迁移到版本 3；升级并重启账号服务后需重新登录。

先不启用接管时，新增参数使用以下默认值，现有静态节点仍按原方式连接：

```dotenv
MISAKA_HY2_SERVICES=[]
MISAKA_HY2_AUTH_PORT=8788
MISAKA_HY2_POLL_MS=5000
```

## 2. 配置节点统计密钥

生成一个至少 16 位、无换行的随机密钥；同一个密钥填写到下述两个位置。可以使用你安装的 Node 执行：

```sh
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

账号服务的 `.env` 改为一行 JSON（把示例密钥换成刚生成的值）：

```dotenv
MISAKA_HY2_SERVICES=[{"id":"primary","statsUrl":"http://127.0.0.1:9999","secret":"填写刚生成的随机密钥"}]
MISAKA_HY2_AUTH_PORT=8788
MISAKA_HY2_POLL_MS=5000
```

在已有 Hysteria2 YAML 增加下面的统计配置，保留原监听端口、证书、TLS、伪装等配置；然后重启节点服务和账号服务：

```yaml
trafficStats:
  listen: 127.0.0.1:9999
  secret: 填写刚生成的随机密钥
```

8788 和 9999 都只用于本机服务之间通信，**不映射域名、不放行公网端口**。示例适用于账号服务与 Hysteria2 在同一台服务器；多个本机服务使用不同统计端口，并在 JSON 数组中配置不同 `id`。远程节点需先通过安全隧道将其统计接口映射至本机，再使用同样配置。

## 3. 加入节点启动钩子

每次 Hysteria2 进程启动前，必须调用启动登记接口，防止重启后累计计数器重复或漏算。先重启 PM2 账号项目，确认健康接口正常，再设置钩子。

若节点使用 systemd，先查看实际服务名称：

```sh
systemctl list-units --type=service --all
```

以下以 `hysteria-server.service` 为例；你的服务名不同就替换为实际名称：

```sh
systemctl edit hysteria-server.service
```

填入：

```ini
[Service]
ExecStartPre=/usr/bin/curl -fsS --max-time 5 -X POST -H "Content-Type: application/json" -d "{}" http://127.0.0.1:8788/boot/primary
```

确认 `/usr/bin/curl` 存在；若路径不同使用实际路径。保留已有的其他启动命令。重载配置并重启节点：

```sh
systemctl daemon-reload
systemctl restart hysteria-server.service
```

采用其他进程管理器时，将同一个 POST 调用放在 Hysteria2 启动前，成功后才启动。多服务的 URL 最后一段使用对应的服务 `id`。内部登记失败返回 503，启动钩子会阻止错误代次下启动节点。

## 4. 切换为按会话鉴权

在已有 Hysteria2 YAML 中，替换原 `auth` 段为：

```yaml
auth:
  type: http
  http:
    url: http://127.0.0.1:8788/auth/primary
```

不要同时保留旧共享密码作为备用鉴权，否则仍能绕过按账号计量。

在新版客户端用 root 登录，打开“我的线路”，找到对应 Hysteria2 私有线路，点击“服务端接管”，绑定 `primary`。重启 Hysteria2 后，使用已获得该线路授权的账号连接，并在“管理概览”确认出现最新采样与真实流量。

建议选择维护窗口完成这一步：切换期间连接可能短暂中断，原共享密码会停止使用。新服务端仍兼容原客户端的登录及配置获取接口，但新功能与恢复提示需要 0.6 客户端。多个入口对应不同物理 Hysteria2 服务时，要绑定相应的 `id`。

## 5. 用户额度与设备

- “用户管理 → 流量与设备”：默认不限额；关闭不限流量后，输入每月 GB 额度。1 GB = 1,000,000,000 字节，上传和下载相加。
- 超额后拒绝新鉴权并对已有统计身份执行踢除；Hysteria2 的踢除在后续流量处理时生效。应用授权检查也会断开，不能靠自动切线避开该账号的受管额度。
- 北京时间每月 1 日进入新周期，不需要 cron。管理员提前重置只清零“已使用额度”的基线，保留原始流量总计。
- 解除超额、重新授予权限或进入新周期时使用新的统计身份，避免旧踢除标记影响恢复。
- “退出会话”撤销对应设备的应用令牌与受管节点身份。共用账号的所有会话共同消耗该账号额度，普通共用用户不能退出其他人的会话。
- 采样间隔默认 5 秒，会有数秒超额窗口。统计断开超过 30 秒时，受限账号停止获取新的节点配置及鉴权；管理概览会显示异常，已有连接的撤销会持续重试。不要依赖客户端会话计数作为服务器限额。
- 数据覆盖已接管的代理载荷，不含 QUIC 开销或服务器其他业务；节点异常退出可能损失最后一个采样窗口。不要调用 `/traffic?clear=1`，其他工具清空计数器会破坏增量计算。
- 内部 HTTP 鉴权端口只绑定回环地址，不提供公网访问。统计密钥、原节点凭据和 `.env` 不应放入 GitHub。

## 回滚

先停止账号服务与 Hysteria2，恢复旧 Hysteria2 YAML，移除新增启动钩子；再恢复升级前 `server.js`、`.env` 和完整 `data/` 备份。重载 systemd，先启动旧节点服务，再启动旧账号项目。仅恢复旧 `server.js` 而保留版本 3 数据不能完成回滚。

参考：[Hysteria2 服务端配置](https://v2.hysteria.network/docs/advanced/Full-Server-Config/)、[Traffic Stats API](https://v2.hysteria.network/docs/advanced/Traffic-Stats-API/)。
