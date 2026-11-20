# dsh-tailscale-serve

Expose your [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) web GUI to your own devices — **over Tailscale only**.

No port forwarding, no public domain, no `0.0.0.0` listener, no extra login system to get wrong.

    phone (Tailscale) ──tailnet WireGuard──▶ <tailnet ip>:8081
                                              │  raw TCP forwarder
                                              ▼
                                    127.0.0.1:<dsh port>  (DSH + your pairing gate)

Optional second path: `tailscale serve` publishes `https://<machine>.<tailnet>.ts.net` (tailnet-only) and proxies it to the same loopback port.

## Why another remote plugin?

Plugins that expose DSH usually bind `0.0.0.0` and ask you to punch a hole in your router, so every device on the LAN — and anyone who scans your public IP — reaches the app. This one can only ever bind a Tailscale address (`100.64.0.0/10` or `fd7a:115c:a1e0::/48`); anything else is a startup error, not a warning.

It also **does not implement authentication**. DSH's own pairing gate stays the single credential check, so installing this cannot silently downgrade your security — and if no gate answers, the plugin refuses to listen unless you explicitly opt out.

## Security model

| Guarantee | How it is enforced | How to opt out |
| --- | --- | --- |
| Binds a tailnet address only | `isTailnetAddress()` rejects `0.0.0.0`, LAN, loopback and public IPs before `listen()` | `allowNonTailnet: true` |
| Fails closed without a pairing gate | probes `/pair-app`; if nothing answers with a 200 HTML shell, no listener is started | `allowUnpaired: true` (logs a SECURITY warning) or `pairingCheck: "off"` |
| Optional device allowlist | `allowedPeers` accepts exact IPs and CIDR; malformed entries never widen access | empty list = any device on your tailnet |
| No credential of its own | the plugin never stores, issues or forwards tokens; DSH/pairing plugin does | – |
| Bounded exposure | `maxConnections` caps concurrent clients | – |

What it **cannot** protect you from: a compromised tailnet account (the coordination server can authorise new devices), another device on your own tailnet if you leave `allowedPeers` empty, or a pairing plugin misconfigured to hand tokens to the wrong host. Tighten your tailnet ACL and use device approval for the real guarantees — see [SECURITY.md](./SECURITY.md).

## Install

```bash
# in your DSH profile directory, e.g. ~/.dsh/profiles/desktop
pnpm add dsh-tailscale-serve      # or: npm i dsh-tailscale-serve
```

Then add the bundle to the profile `package.json` and enable the row in `cordis.patch.yml`:

```yaml
- insert:
    - id: ts-serve
      name: dsh-tailscale-serve
      config:
        port: 8081            # tailnet-side port
        serve: true           # also publish https://<machine>.<tailnet>.ts.net
        allowedPeers: []      # e.g. ["100.119.175.27"] to allow one phone
        allowUnpaired: false  # keep false: refuse to expose a gated app
```

Restart DSH. On a cold boot the plugin may have to wait: DSH usually starts before `tailscaled` has finished authenticating, so the first attempts log `no Tailscale IPv4 address yet` and are retried (default 400 × 1.5 s ≈ 10 min). Everything is also appended to `~/.dsh/logs/dsh-tailscale-serve.log` because the desktop app hides plugin stdout.

Log lines tell you exactly what happened:

```
[dsh-tailscale-serve] forwarder listening on 100.79.98.33:8081 -> 127.0.0.1:51741
[dsh-tailscale-serve] tailscale serve -> http://127.0.0.1:51741 (tailnet-only)
[dsh-tailscale-serve] ready: http://100.79.98.33:8081  gate=paired  peers=any-tailnet-device
```

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `port` | `8081` | tailnet-side TCP port |
| `serve` | `true` | run `tailscale serve --bg` for tailnet HTTPS |
| `pairingCheck` | `"auto"` | `"auto"` probes `/pair-app`; `"off"` skips the probe (you own the gate) |
| `allowUnpaired` | `false` | start even when no gate answers (dangerous, logs a warning) |
| `allowNonTailnet` | `false` | allow binding a non-tailnet address (you are on your own) |
| `allowedPeers` | `[]` | exact IPs / CIDRs allowed to connect; empty = whole tailnet |
| `tailscaleBin` | `""` | explicit CLI path; empty = auto-detect |
| `maxConnections` | `64` | concurrent connection cap |
| `retries` / `retryMs` | `6` / `3000` | `tailscale serve` retry policy |
| `startAttempts` / `startRetryMs` | `400` / `1500` | startup retry window (~10 min): DSH and Tailscale boot independently, and `tailscaled` can report `NoState` for a while |
| `logFile` | `""` | `""` = `~/.dsh/logs/dsh-tailscale-serve.log`; a path overrides it; `false` disables the file log |

## Verify before you trust it

```bash
npx dsh-tailscale-serve   # no: this package is a library
node scripts/selfcheck.js --port <dsh port>
```

The self-check is read-only: it prints the CLI version, the tailnet address and whether a pairing gate answers. Then test the real path from another tailnet device:

```
curl -i http://<tailnet ip>:8081/pair-app     # expect 200 when a gate is installed
curl -i http://<tailnet ip>:8081/             # expect 401 from DSH core
```

## FAQ

**Do I need a pairing plugin?** No — the plugin is gate-agnostic. It only checks that *something* answers `/pair-app`. Use `@linxin666/dsh-remote-web-ui`, your own auth proxy, or `pairingCheck: "off"` with `allowUnpaired: true` if you really want a bare DSH (not recommended: DSH serves its own auth token only to the local console).

**Does it modify my Tailscale config?** It runs `tailscale serve --bg` when `serve: true`; `tailscale serve reset` removes that. No ACL, key or exit-node changes.

**Windows?** Tested on Windows 11 with Tailscale 1.104.7; the CLI is auto-detected in `C:\\Program Files\\Tailscale\\tailscale.exe`.

## License

MIT
