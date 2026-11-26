# 在你自己的一堆机器上跑 DSH

这份文档记录的是本插件最初要解决的场景：**两三台电脑加一部手机，同处一个 tailnet，每台机器各自跑自己的 DSH，彼此都能访问对方。** 它讲的是「多机协作」，不是把任何东西发布到公网——整套东西在 tailnet 之外不可达。

下面全部使用占位符，请替换成你自己的值：

| 占位符 | 含义 |
| --- | --- |
| `100.x.y.z` | 某台机器的 Tailscale IPv4（`tailscale ip -4`） |
| `<host>.<tailnet>.ts.net` | 该机器的 MagicDNS 名称（`tailscale status --json` 里的 `.Self.DNSName`） |
| `8081` | 本插件在 tailnet 侧监听的端口 |
| `<dsh-port>` | DSH 本次启动随机拿到的回环端口 |

## 拓扑

    机器 A（DSH + 插件）                     机器 B（DSH + 插件）
    ├─ 127.0.0.1:<dsh-port>  DSH            ├─ 127.0.0.1:<dsh-port>  DSH
    ├─ 100.x.y.1:8081        转发器          ├─ 100.x.y.2:8081        转发器
    └─ tailscale serve ──▶ 回环             └─ tailscale serve ──▶ 回环
              ▲                                        ▲
              └──────────── tailnet（WireGuard）───────┘
                        手机 / 笔记本浏览器

每台机器都是一个**自给自足的端点**：自己的 DSH、自己的插件实例、自己的配对门禁。没有中心机，没有「一台机器上做反向代理」，机器之间也不共享密钥。所谓访问，就是「在浏览器里打开对方的 `http://100.x.y.z:8081/pair-app`」。

正因为拓扑是对称的，那**三个关键配置必须在每台机器上都正确**。跨机故障绝大多数是「一台机器配了、另一台没配」。

## 每台机器都需要的东西

1. **Tailscale 在线且登录同一个 tailnet**——`tailscale status` 能看到其它机器，`tailscale ip -4` 有地址。
2. **profile 里装了 DSH + 本插件**，并在 `cordis.patch.yml` 里启用了 bundle。
3. **一个配对门禁**（可选但强烈建议），例如 `@linxin666/dsh-remote-web-ui`，并配置成配对基址为 tailnet authority，而不是局域网地址。
4. **主机信任**：核心的 `connection.trustedHosts` 与门禁自己的 `trustedHosts` 都要列出 `<host>.<tailnet>.ts.net` 和 `100.x.y.z`。
5. **`8081` 的防火墙规则**，只对真正要用的 peer 地址放行。

## 加一台机器的步骤

顺序很重要，一步解锁下一步。

1. 装 Tailscale、登录，确认 `tailscale status` 里有其它机器。
2. **先关掉 DSH**，再装 profile 依赖（原因见下面 **L3**）。装之前先在 profile 的 `pnpm-workspace.yaml` 里设 `autoInstallPeers: false` 与 `nodeLinker: hoisted`（见 **L4**）。
3. 往 `cordis.patch.yml` 里加 `ts-serve` 配置（port、`allowedPeers`）和门禁配置（配对基址、`trustedHosts`）。改之前先备份。
4. 启动 DSH，看 `~/.dsh/logs/dsh-tailscale-serve.log` 是否出现 `ready: http://100.x.y.z:8081`。
5. 加防火墙放行规则（限定 peer 地址）；如果这台机器开了 SMB/RPC/RDP，再加「只对 tailnet 网卡封堵这些端口」的规则。
6. **在那台机器上**生成一次性配对链接（门禁的 `/api/pair/issue` 只接受 loopback，见 **L2**），然后在**另一台机器**的浏览器里打开。
7. 在另一台机器上收藏 `http://100.x.y.z:8081/pair-app`。反方向再走一遍。

## 用停机换来的教训

### L1 —— 配对基址必须是 tailnet authority

**现象。** 配对链接长成 `http://192.168.x.x:<dsh-port>/pair-accept?pair=…`——局域网地址或虚拟网卡地址（VirtualBox host-only、Hyper-V、Radmin……），而且常常用裸的回环端口而不是 `8081`。另一台机器打开是白屏，或者被自己的代理回了 502。

**原因。** 门禁默认 `pairingSource: auto` 且开启 LAN 绑定：它会枚举本机网卡，取第一个非回环地址来广播；一旦有 LAN 基址，还可能把浏览器「跳转」到那个地址。A 机器的局域网地址在 B 机器上毫无意义。

**修复。** 在**每一台**机器上把基址钉死、关掉跳转：

```yaml
- id: remote-web-ui          # 你所用门禁的 loader id
  config:
    publicBaseUrl: http://100.x.y.z:8081   # 本机的 tailnet authority
    pairingSource: public                  # 多机环境绝不要 "auto"
    lanBind: false                         # 不产生 LAN 候选，也就没有跳转
    trustedHosts: ["<host>.<tailnet>.ts.net", "100.x.y.z"]
- id: connection
  config:
    trustedHosts: ["<host>.<tailnet>.ts.net", "100.x.y.z"]
```

**检查。** `GET /api/pair/status` 里应出现等于你 tailnet authority 的 `publicUrl`，且 `lanAddresses` 为空。

### L2 —— 配对链接无法远程生成

**现象。** 在 A 机器上替 B 机器生成链接，返回 `{"ok":false,"code":"forbidden"}` 或 403。

**原因。** 这是设计如此。`/api/pair/issue` 只回应 loopback 客户端，否则任何能连到该端口的 tailnet peer 都能给自己签发凭据。

**结论。** 没法把「新机器入网」全自动化。要么在目标机器本地跑一个生成脚本（找到 DSH 端口 → POST `127.0.0.1:<dsh-port>/api/pair/issue` → 打印 URL），要么接受每台新浏览器一步手动操作。为了自动化去削弱这个校验并不划算。

### L3 —— 绝不要在 DSH 运行时跑 profile 安装

**现象。** 你更新 profile，安装成功，几分钟后远程链路悄悄死掉；DSH 还活着，但 `8081` 没人监听，日志也停在半截。

**原因。** `pnpm install` 会重写 profile 的 `node_modules` 并替换插件目录。运行中的 DSH 内存里还是**旧**模块，目录被删时插件的转发器就被拆掉了；新代码要等下次启动才加载，于是中间这段没人监听。一次「小配置改动」就是这样变成几小时断连的。

**规则。** 关 DSH → 安装 → 启 DSH。非要边跑边装，装完立刻重启，别走开。

### L4 —— peer 解析看起来像卡死

**现象。** 在新 profile 上装一个门禁插件，解析了上百个包，停在「还在装」好几分钟；外层脚本超时，看着像挂了。

**原因。** profile 默认开着 `autoInstallPeers`，门禁 bundle 的每个 `@deepseek-ai/*` peer 都被解析安装。实测一例：678 个包、超过 3 分钟没完成。

**修复。** 在 profile 的 `pnpm-workspace.yaml` 里：

```yaml
nodeLinker: hoisted
autoInstallPeers: false
```

同一次安装随后约 1.2 秒完成。这也正是 DSH 桌面端 profile 本来的配法。

### L5 —— Windows 上，VPN 后端需要 GUI 客户端常驻

**现象。** `tailscale ip -4` 为空，`tailscale status` 卡住或报 `NoState`，本插件日志反复「no Tailscale IPv4 address yet」直到放弃。昨天还是好的。

**原因。** Windows 上，没有 IPN 客户端连着时 `tailscaled` 会把后端拆掉（日志里是「disconnecting Tailscale」），tailnet 地址就没了。如果 GUI 客户端从来没设成自动启动，机器重启回来就是一个「服务在跑、功能离线」的 VPN。

**修复。** 让托盘客户端开机自启（`Run` 项指向 `tailscale-ipn.exe`），并保证本插件的启动重试窗口够长（默认约 10 分钟）以跨过慢登录。**不要**用「改绑局域网地址」来绕过——那正是插件拒绝的降级。

### L6 —— 幽灵虚拟网卡会卡死后端

**现象。** `tailscaled` 日志反复 `Failed to setup adapter (problem code: 0x1F, ntstatus: 0xC00002F0)`，接着 `Timed out waiting for device query`，永远停在 `NoState`。重启服务、重装、杀进程全都无效。

**原因。** Wintun 网卡实例变成了**幽灵设备**（崩溃或升级可能留下「注册了但不存在」的节点）。

**修复。** 删掉残留设备节点再重启 Tailscale：

```powershell
pnputil /enum-devices /class Net          # 找到 SWD\WINTUN 那个实例
pnputil /remove-device "SWD\WINTUN\{...}"
```

在这个状态下跑 MSI 修复安装会挂住——先停服务（或杀掉进程）再动 MSI。

### L7 —— 防火墙要限定在 tailnet 网卡上

**现象（理想情况）。** 你给 `8081` 加了放行规则，局域网行为一点没变。

**怎么保持。** 放行规则的 `RemoteAddress` 限定成 peer 地址（`100.64.0.0/10` 是可接受的默认，列出三台更好）。如果这台机器还跑 SMB/RPC/RDP/WinRM，就为这些端口加**封堵**规则，并把 `LocalAddress` 设成 tailnet 地址——封堵只作用于 tailnet 网卡，局域网的共享、打印、远程桌面全部不受影响。设不设 `LocalAddress`，就是「加固了 tailnet」和「搞坏了局域网」的区别。

### L8 —— DSH 更新会换回环端口

**现象。** DSH 自动更新后，远程页面需要刷新一下，别的都正常。

**原因。** DSH 每次启动都会重新挑一个回环端口。本插件启动时会把 `tailscale serve` 重指到新端口，所以**路径**是对的，但已打开页面上的 websocket 会断。

**修复。** 不用修——刷新即可。如果要写脚本，永远不要硬编码 `<dsh-port>`，从 DSH 进程持有的监听 socket 上现查。

### L9 —— 按这个顺序验证

```bash
# 1. 监听的是 tailnet 地址，不是 0.0.0.0
netstat -ano | grep 8081

# 2. 门禁透过转发器有响应
curl -i http://100.x.y.z:8081/pair-app     # 200，返回 boot 外壳
curl -i http://100.x.y.z:8081/             # 401，来自 DSH 核心

# 3. 配对链路端到端可用
#    （用一次性 token 测，别用马上要发出去的那个）
#    /pair-accept → 303 + Set-Cookie → 带 cookie 的 /pair-app → 200 且含 __DSH_BOOT__

# 4. HTTPS 路径结论一致
tailscale serve status
```

然后——只有到这一步之后——**从另一台机器**再测。回环自测只能证明插件活着，跨机测试才能证明配置对了。

### L10 —— 配对 cookie 就是那台设备

`dsh_pair` 是长期凭据（默认一年），也是该浏览器唯一的凭证。磁盘上的设备列表加门禁的撤销接口就是你的熔断开关。要撤就撤**具体那个 device id**，不要「全撤」——调试期间批量撤销，是把自己（或别人）锁在门外最快的方式。

### L11 —— 两个方向分别测

不对称是常态：一周前配好的那台可能没有 `publicBaseUrl`，新配的有。遇到「不通」时，先检查你**刚刚没动**的那个方向。

## 值得说清的安全边界

- **tailnet 成员身份就是边界。** 任何能在你的 tailnet 上授权设备的人，都能访问每台机器的 `8081`（除非 `allowedPeers` 另有约束）。真正起作用的是 MFA、设备审批和一套像样的 ACL；插件只是把 socket 收窄。
- **只在 tailnet 内，比公网隧道更强。** 在边缘终止 TLS 的隧道能看到明文，还会给你一个会被全网扫描的公网域名；而这套东西在互联网上根本不存在入口。
- **走中继依然是端到端。** 两个 peer 打不了洞时，Tailscale 通过 DERP 中继 WireGuard 密文；中继只看到元数据，看不到内容。
- **不要把地址提交进仓库。** tailnet IP、MagicDNS 名、设备名，以及任何代理/令牌材料，都属于本地配置。本文全用占位符，就是这个原因。

## 逐机回滚

1. 关掉 DSH。
2. 还原 profile 备份：`package.json.bak-*`、`cordis.patch.yml.bak-*`。
3. `pnpm install --ignore-scripts`（或直接删掉新加的包）。
4. 删掉你为 `8081` 加的防火墙规则和那些服务封堵规则。
5. 启动 DSH，确认没有插件也能正常起。
6. 可选：`tailscale serve reset`，再卸载 Tailscale。

## 反面模式

| 别做 | 原因 |
| --- | --- |
| 「先绑 `0.0.0.0` 测一下」 | 一次局域网扫描就可能把应用暴露出去；插件故意拒绝这种绑定 |
| 多机环境用 `pairingSource: auto` | 它会广播排序最前的网卡——通常正是 peer 连不上的那个 |
| 从别的机器替 peer 生成链接 | 该接口按设计只接受 loopback |
| 在运行中的 DSH 上跑 profile 安装 | 会悄悄卸载正在跑的插件（**L3**） |
| 用 `allowNonTailnet` 绕过 VPN 抖动 | 症状消失了，安全属性也没了 |
| 调试时批量撤销设备 | 事后你分不清哪个是自己的浏览器 |
| 硬编码 DSH 回环端口 | 每次启动、每次更新都会变 |
