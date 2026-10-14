# qaletx link proxy core

发布安装包时，将对应平台的 sing-box 核心放在此目录：

- Windows 7/10/11 x64：`sing-box.exe`
- macOS Intel：`sing-box-amd64`
- macOS Apple Silicon：`sing-box-arm64`

sing-box 负责真正建立代理连接。客户端连接时启动核心并打开 `127.0.0.1:10808` 系统代理，断开或退出时恢复系统原有代理设置。

支持的分享链接包括 Hysteria2、TUIC、VLESS（TCP/WS/gRPC/Reality 基础参数）、VMess、Trojan、Shadowsocks、SOCKS5 和 HTTP。核心文件需要从官方发行版下载后再打包，项目不会把外部二进制直接提交到源码仓库。
