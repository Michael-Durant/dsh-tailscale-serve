# dsh-tailscale-serve

把你的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）网页控制台暴露给**自己的设备**——并且**只走 Tailscale**。

不用端口映射、不用公网域名、不监听 `0.0.0.0`、也不自己再造一套登录鉴权。

    手机(Tailscale) ──tailnet WireGuard──▶ <tailnet IP>:8081
                                            │  裸 TCP 转发
                                            ▼
                                  127.0.0.1:<DSH 端口>  (DSH + 你选的配对门禁)

另一条可选路径：`tailscale serve` 发布 `https://<机器>.<tailnet>.ts.net`（仅 tailnet 内可达），同样代理到本机回环端口。

## 为什么不是「又一个远程访问插件」

同类插件通常监听 `0.0.0.0` 并让你在路由器上开洞，于是同一局域网的任何设备、以及扫到你公网 IP 的人都能访问。本插件只允许绑定 Tailscale 地址（`100.64.0.0/10` 或 `fd7a:115c:a1e0::/48`），其他地址一律启动失败，而不是打个警告继续跑。

它也**不自带鉴权**：凭据校验仍然只由 DSH 的配对门禁负责，所以装它不会悄悄降低原有安全性；反过来，如果探测不到门禁，它默认拒绝监听。

## 安全模型

| 保证 | 实现方式 | 如何关闭 |
| --- | --- | --- |
| 只绑 tailnet 地址 | `listen()` 前用 `isTailnetAddress()` 拒绝 `0.0.0.0`、局域网、回环与公网地址 | `allowNonTailnet: true` |
| 没有门禁就不暴露（fail closed） | 探测 `/pair-app`，没有 200 HTML 外壳就不启动监听 | `allowUnpaired: true`（会打 SECURITY 警告）或 `pairingCheck: "off"` |
| 可选设备白名单 | `allowedPeers` 支持精确 IP 与 CIDR；写错的条目不会放大权限 | 留空 = 整个 tailnet 可连 |
| 不自持凭据 | 插件不生成、不存储、不转发任何 token | – |
| 限制暴露面 | `maxConnections` 限制并发连接数 | – |

它**保护不了**的情况：tailnet 账号本身被攻破（协调服务器可以授权新设备）、你自己的 tailnet 里有别的设备而 `allowedPeers` 为空、或者配对插件被错误配置成把 token 发给错误的主机。真正的强保证要靠 tailnet ACL + 设备审批，见 [SECURITY.md](./SECURITY.md)。

## 安装

```bash
# 在 DSH profile 目录下，例如 ~/.dsh/profiles/desktop
pnpm add dsh-tailscale-serve      # 或 npm i dsh-tailscale-serve
```

然后在 profile 的 `cordis.patch.yml` 中启用：

```yaml
- insert:
    - id: ts-serve
      name: dsh-tailscale-serve
      config:
        port: 8081            # tailnet 侧端口
        serve: true           # 同时发布 https://<机器>.<tailnet>.ts.net
        allowedPeers: []      # 例如 ["100.119.175.27"] 只放行手机
        allowUnpaired: false  # 保持 false：有门禁才暴露
```

重启 DSH。冷启动时插件可能要等一会儿：DSH 通常比 `tailscaled` 认证完成更早启动，前几次尝试会记 `no Tailscale IPv4 address yet` 并自动重试（默认 400 × 1.5 秒 ≈ 10 分钟）。由于桌面端看不到插件 stdout，日志同时写入 `~/.dsh/logs/dsh-tailscale-serve.log`。

日志会明确告诉你结果：

```
[dsh-tailscale-serve] forwarder listening on 100.79.98.33:8081 -> 127.0.0.1:51741
[dsh-tailscale-serve] ready: http://100.79.98.33:8081  gate=paired  peers=any-tailnet-device
```

## 配置项

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `port` | `8081` | tailnet 侧 TCP 端口 |
| `serve` | `true` | 是否执行 `tailscale serve --bg` |
| `pairingCheck` | `"auto"` | `"auto"` 探测 `/pair-app`；`"off"` 跳过探测（你自己负责门禁） |
| `allowUnpaired` | `false` | 无门禁也启动（危险，会告警） |
| `allowNonTailnet` | `false` | 允许绑定非 tailnet 地址 |
| `allowedPeers` | `[]` | 允许连接的精确 IP / CIDR；空 = 整个 tailnet |
| `tailscaleBin` | `""` | CLI 路径；空 = 自动探测 |
| `maxConnections` | `64` | 并发连接上限 |
| `retries` / `retryMs` | `6` / `3000` | `tailscale serve` 重试策略 |
| `startAttempts` / `startRetryMs` | `400` / `1500` | 启动重试窗口（约 10 分钟）：DSH 与 Tailscale 各自独立启动，`tailscaled` 可能一段时间处于 `NoState` |
| `logFile` | `""` | `""` = `~/.dsh/logs/dsh-tailscale-serve.log`；填路径可改位置；`false` 关闭文件日志 |

## 上手验证

```bash
node scripts/selfcheck.js --port <DSH 端口>
```

自检是只读的：输出版本、tailnet 地址、门禁是否应答。再从另一台 tailnet 设备实测：

```
curl -i http://<tailnet IP>:8081/pair-app     # 装了门禁应返回 200
curl -i http://<tailnet IP>:8081/             # DSH 核心应返回 401
```

## 常见问题

**必须有配对插件吗？** 不必须。插件与门禁解耦，只检查 `/pair-app` 是否有人应答。你可以用 `@linxin666/dsh-remote-web-ui`、自己的反代鉴权，或者 `pairingCheck: "off"` + `allowUnpaired: true` 直接暴露裸 DSH（不建议）。

**会改我的 Tailscale 配置吗？** `serve: true` 时只会执行 `tailscale serve --bg`，用 `tailscale serve reset` 清除；不动 ACL、密钥与出口节点。

**Windows 支持？** 在 Windows 11 + Tailscale 1.104.7 上验证；会自动探测 `C:\\Program Files\\Tailscale\\tailscale.exe`。

## 许可

MIT
