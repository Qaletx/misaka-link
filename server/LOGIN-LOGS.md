# 登录日志

更新根目录 `server.js` 并在宝塔 PM2 中重启账号服务即可开启。无新增依赖，不用修改已有 `.env` 或数据库，现有 Windows / macOS 客户端均可使用。账号服务重启后，原内存会话失效，客户端需要重新登录。

## 在宝塔查看

1. PM2 管理器 → `qaletx_link` → 运行日志，搜索 `LOGIN_AUDIT`。每条记录都包含唯一 `requestId`。
2. 文件管理器 → 服务端目录 → `logs` → `login-2026-10-25.jsonl`（日期是北京时间）。每行是一条 JSON 记录。

当前部署目录为 `/www/wwwroot/qaletx_link`，因此日志保存在 `/www/wwwroot/qaletx_link/logs/`。PM2 运行日志为 `/www/wwwlogs/pm2/qaletx_link-out.log`。

JSONL 文件默认保留最近 30 天；同一天单个文件达到 5 MiB 后轮转为 `.1.jsonl`、`.2.jsonl`，默认每天最多 3 个文件。超过每日文件数量或保留天数的最旧记录会删除。文件日志的轮转不改变宝塔/PM2 自身的日志保留规则。

## 记录字段

| 字段 | 含义 |
| --- | --- |
| `beijingTime` / `time` | 北京时间（带 `+08:00`）/ UTC 时间 |
| `requestId` | 服务端生成的唯一请求 ID，与响应头 `X-Qaletx-Request-Id` 一致；失败响应也带同名 JSON 字段 |
| `username` | 请求中的账号，去除首尾空白并转小写；尚未读取请求体时为空 |
| `deviceName` / `deviceId` | 客户端报告的电脑名及设备标识 |
| `platform` / `clientVersion` | `win32`、`darwin` 等系统名及客户端版本 |
| `deviceReported` | 请求是否提供了设备信息；未提供时明确显示“未提供设备名称” |
| `clientIp` / `peerIp` | 按受信代理规则计算的来源 IP / 实际 TCP 对端 IP |
| `trustedProxy` | TCP 对端是否是 `.env` 明确配置的受信代理；未受信的 `X-Forwarded-For` 不会冒充来源 IP |
| `event` | `login_attempt` 是登录请求；`login_preflight` 是浏览器预检，预检通过不代表已登录 |
| `result` / `authentication` | 请求成功或失败 / 账号验证结果（`success`、`failure`、`not_checked`） |
| `httpStatus` / `reasonCode` / `reason` | HTTP 状态码 / 稳定原因编码 / 中文原因 |
| `durationMs` | 本次请求处理耗时 |
| `responseFinished` | 服务端是否完成响应写入；这不证明客户端一定收到响应 |
| `inputHints` | 仅记录输入异常提示，例如密码含首尾空白或非 ASCII 字符，不记录密码内容或长度 |
| `origin` / `userAgent` | 浏览器来源及客户端标识，用于判断预检、旧版客户端和请求链路差异 |

电脑名、设备 ID、系统、版本来自客户端报告，可用于排查，不能当作不可伪造的身份凭证。日志只选取白名单字段，过滤控制字符和本次提交的密码；不写入完整请求体、密码、Authorization、登录令牌、密码哈希、盐或节点配置。

## 常见原因

| `reasonCode` | 含义 |
| --- | --- |
| `SUCCESS` | 账号密码校验成功，服务端已完成成功响应 |
| `BAD_PASSWORD` | 账号存在，但密码不匹配 |
| `ACCOUNT_NOT_FOUND` | 账号不存在；对外仍与错误密码返回同一提示，不向匿名客户端暴露账号列表 |
| `ACCOUNT_DISABLED` / `ACCOUNT_EXPIRED` | 停用 / 过期 |
| `RATE_LIMITED` | 同一来源 10 分钟内超过 20 次登录尝试 |
| `INVALID_INPUT` / `INVALID_DEVICE` | 账号密码或设备信息格式不符合要求 |
| `INVALID_JSON` / `BODY_TOO_LARGE` | JSON 无效 / 超过 64 KiB |
| `CORS_BLOCKED` | Origin 不在允许列表中 |
| `PREFLIGHT_OK` | 预检通过，尚未验证账号密码 |
| `REQUEST_ABORTED` / `CLIENT_DISCONNECTED` | 请求或响应完成前连接中断 |
| `SESSION_LIMIT` / `INTERNAL_ERROR` | 会话达到上限 / 服务端内部错误 |

限流、CORS 拒绝、损坏或未传完的请求可能在读取 JSON 前就被拒绝，因此这类记录可能没有账号和电脑名；仍会保留 IP、时间和原因。限流策略保持不变。

请求根本没有到达本服务（例如断网、DNS 失败、被代理或防火墙拦截）时，不会生成服务端日志。日志里只有预检、没有对应 POST，也可以帮助判断失败发生在哪一阶段。启动时恢复已有会话的 `GET /api/me` 和日常心跳不会冒充新的密码登录请求。

日志目录不可写时，登录仍可正常工作；记录继续写入 PM2，错误日志会提示 `LOGIN_AUDIT_WRITE_FAILED`。登录文件只由服务端写入，不提供公开下载接口。不要把后端目录作为静态网站根目录公开发布。

## 可选配置

已有部署使用默认值即可。需要调整时在原 `.env` 末尾增加并重启服务：

```dotenv
MISAKA_LOGIN_LOG_RETENTION_DAYS=30
MISAKA_LOGIN_LOG_MAX_MB=5
MISAKA_LOGIN_LOG_FILES_PER_DAY=3
```

支持范围依次为 1–365 天、每个文件 1–50 MiB、每天 1–10 个文件。只修改这些配置，不要覆盖原来的密钥或数据库。
