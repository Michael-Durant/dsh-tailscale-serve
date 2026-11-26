# Running DSH on several of your own machines

This is the field guide for the setup this plugin was built for: **two or three computers plus a phone, all on one tailnet, each hosting its own DSH, each reachable from the others.** It is not about publishing anything to the internet — nothing here is reachable from outside your tailnet.

Everything below is written against placeholder values. Replace them with your own:

| Placeholder | Meaning |
| --- | --- |
| `100.x.y.z` | a machine's Tailscale IPv4 address (`tailscale ip -4`) |
| `<host>.<tailnet>.ts.net` | that machine's MagicDNS name (`tailscale status --json` → `.Self.DNSName`) |
| `8081` | the tailnet-side port this plugin listens on |
| `<dsh-port>` | the random loopback port DSH happens to pick on this start |

## Topology

    machine A (DSH + plugin)                 machine B (DSH + plugin)
    ├─ 127.0.0.1:<dsh-port>  DSH            ├─ 127.0.0.1:<dsh-port>  DSH
    ├─ 100.x.y.1:8081        forwarder      ├─ 100.x.y.2:8081        forwarder
    └─ tailscale serve ──▶ loopback         └─ tailscale serve ──▶ loopback
              ▲                                        ▲
              └──────────── tailnet (WireGuard) ───────┘
                        phone / laptop browsers

Each machine is a **self-contained endpoint**: its own DSH, its own plugin instance, its own pairing gate. There is no hub, no reverse proxy on one machine, and no shared secret between them. Access is "open the peer's `http://100.x.y.z:8081/pair-app` in a browser".

Because the topology is symmetric, the *same* three config values must be correct on **every** machine. Most cross-machine failures are one machine having them and the other not.

## What every machine needs

1. **Tailscale up and logged into the same tailnet** — `tailscale status` shows the others, `tailscale ip -4` prints an address.
2. **DSH + this plugin in the profile**, bundle enabled in `cordis.patch.yml`.
3. **A pairing gate** (optional but recommended) — e.g. `@linxin666/dsh-remote-web-ui`, configured so its pairing base is the tailnet authority, not a LAN address.
4. **Host trust** for that authority: `connection.trustedHosts` (core) and the gate's own `trustedHosts` must both list `<host>.<tailnet>.ts.net` and `100.x.y.z`.
5. **A firewall rule for `8081`** scoped to the peer addresses you actually use.

## Recipe for adding a machine

Order matters — each step unblocks the next.

1. Install Tailscale, log in, confirm `tailscale status` lists the other machines.
2. **Close DSH**, then install the profile dependencies (see **L3** below). Set `autoInstallPeers: false` + `nodeLinker: hoisted` in the profile's `pnpm-workspace.yaml` first (see **L4** below).
3. Add the `ts-serve` config (port, `allowedPeers`) and the gate config (pairing base, `trustedHosts`) to `cordis.patch.yml`. Back the file up first.
4. Start DSH. Watch `~/.dsh/logs/dsh-tailscale-serve.log` for `ready: http://100.x.y.z:8081`.
5. Add the firewall allow-rule scoped to peer IPs; add the "block SMB/RPC/RDP on the tailnet interface" rules if this machine offers those services.
6. **On that machine**, mint a one-time pairing link (the gate's `/api/pair/issue` is loopback-only — see **L2** below). Open it in a browser **on the other machine**.
7. Bookmark `http://100.x.y.z:8081/pair-app` there. Repeat in the opposite direction.

## Lessons that cost real downtime

### L1 — The pairing base must be the tailnet authority

**Symptom.** The pairing link looks like `http://192.168.x.x:<dsh-port>/pair-accept?pair=…` — a LAN address, or a virtual adapter's address (VirtualBox host-only, Hyper-V, Radmin, …), and often the raw loopback port instead of `8081`. The other machine gets a blank page, or a 502 from its own proxy.

**Cause.** The gate defaults to `pairingSource: auto` + LAN binding on. It enumerates local adapter addresses, picks the first non-loopback one, and advertises *that*; and with a LAN base available, it may also redirect the browser to it ("LAN hop"). A LAN address of machine A is meaningless on machine B.

**Fix.** Pin the base and disable the hop, on **every** machine:

```yaml
- id: remote-web-ui          # your gate's loader id
  config:
    publicBaseUrl: http://100.x.y.z:8081   # this machine's tailnet authority
    pairingSource: public                  # never "auto" in a multi-host setup
    lanBind: false                         # no LAN candidates, no hop
    trustedHosts: ["<host>.<tailnet>.ts.net", "100.x.y.z"]
- id: connection
  config:
    trustedHosts: ["<host>.<tailnet>.ts.net", "100.x.y.z"]
```

**Check.** `GET /api/pair/status` should contain a `publicUrl` equal to your tailnet authority and an empty `lanAddresses`.

### L2 — Pairing links cannot be minted remotely

**Symptom.** Minting a link for machine B from machine A returns `{"ok":false,"code":"forbidden"}` or 403.

**Cause.** By design. `/api/pair/issue` only answers loopback clients — otherwise any tailnet peer that reaches the port could mint itself a credential.

**Consequence.** You cannot fully automate onboarding from one machine. Either run the mint step locally on the target (a small script that finds the DSH port, POSTs to `127.0.0.1:<dsh-port>/api/pair/issue`, prints the URL), or accept one manual step per new browser. No workaround is worth weakening that check.

### L3 — Never run a profile install while DSH is running

**Symptom.** You update the profile, the install succeeds, and the remote link silently dies minutes later. `8081` stops listening even though DSH is still up; the log just ends.

**Cause.** `pnpm install` rewrites the profile's `node_modules` and replaces the plugin directory. The running DSH keeps the *old* module in memory — and when that directory is removed, the plugin's forwarder is torn down. The new code only loads on the next start, so nothing is listening in between. This is how a "small config change" becomes a multi-hour outage.

**Rule.** Close DSH → install → start DSH. If you must install while it runs, restart DSH immediately afterwards, and do not walk away.

### L4 — Peer resolution can look like a hang

**Symptom.** Installing a gate plugin on a fresh profile resolves hundreds of packages and sits at "still working" for minutes; a wrapper script times out and looks frozen.

**Cause.** The profile's default is `autoInstallPeers` on, so every `@deepseek-ai/*` peer of the gate bundle is resolved and installed. One measured case: 678 packages, >3 minutes, no completion.

**Fix.** In the profile's `pnpm-workspace.yaml`:

```yaml
nodeLinker: hoisted
autoInstallPeers: false
```

The same install then finished in ~1.2 s. This matches how the DSH desktop profile is already configured.

### L5 — On Windows, the VPN backend needs its GUI client running

**Symptom.** `tailscale ip -4` is empty, `tailscale status` hangs or reports `NoState`, and this plugin logs "no Tailscale IPv4 address yet" until it gives up. Everything worked yesterday.

**Cause.** On Windows, `tailscaled` tears the backend down when no IPN client is connected ("disconnecting Tailscale"), so the tailnet address disappears. If the GUI client was never auto-started, the machine comes back from a reboot with a VPN service that is technically running and functionally offline.

**Fix.** Auto-start the tray client (a `Run` entry pointing at `tailscale-ipn.exe`), and keep this plugin's startup retry window long enough to bridge a slow login (default ~10 min). Do not "fix" it by binding a LAN address — that is the exact downgrade the plugin refuses.

### L6 — A phantom virtual adapter can wedge the backend

**Symptom.** `tailscaled` logs `Failed to setup adapter (problem code: 0x1F, ntstatus: 0xC00002F0)` followed by `Timed out waiting for device query`, and never leaves `NoState`. Service restart, reinstall, and killing processes all fail.

**Cause.** The Wintun adapter instance became a *phantom* device (crashes or upgrades can leave it registered but absent).

**Fix.** Remove the stale device node, then restart Tailscale:

```powershell
pnputil /enum-devices /class Net          # find the SWD\WINTUN instance
pnputil /remove-device "SWD\WINTUN\{...}"
```

A reinstall that tries to repair the adapter will hang while `tailscaled` is in this state — stop the service (or kill it) before touching the MSI.

### L7 — Keep the firewall scoped to the tailnet interface

**Symptom (good case).** You add a rule for `8081` and the LAN still behaves exactly as before.

**How to keep it that way.** Scope the allow rule's `RemoteAddress` to the peer IPs (`100.64.0.0/10` is a reasonable default, a list of three hosts is better). If the machine also runs SMB/RPC/RDP/WinRM, add **block** rules for those ports with `LocalAddress` set to the tailnet IP — that restricts the block to the tailnet interface and leaves LAN sharing, printing, and remote desktop untouched. Setting `LocalAddress` is the difference between "hardened tailnet" and "broken LAN".

### L8 — DSH updates rotate the loopback port

**Symptom.** After a DSH auto-update, remote pages need a refresh; nothing else breaks.

**Cause.** DSH picks a new loopback port on every start. This plugin re-points `tailscale serve` at start, so the *path* stays correct, but live websockets on already-open pages die.

**Fix.** Nothing to do — refresh. If you script anything, never hard-code `<dsh-port>`; discover it from the listening socket owned by the DSH process.

### L9 — Verify in this order

```bash
# 1. listener is a tailnet address, not 0.0.0.0
netstat -ano | grep 8081

# 2. the gate answers through the forwarder
curl -i http://100.x.y.z:8081/pair-app     # 200 with the boot shell
curl -i http://100.x.y.z:8081/             # 401 from DSH core

# 3. the pairing chain works end to end
#    (do this with a throwaway token, not the one you are about to hand out)
#    /pair-accept → 303 + Set-Cookie → /pair-app with the cookie → 200 containing __DSH_BOOT__

# 4. the HTTPS path agrees
tailscale serve status
```

Then — and only then — test **from the other machine**. A loopback test proves the plugin; a cross-machine test proves the configuration.

### L10 — Treat the pairing cookie as the device

`dsh_pair` is long-lived (a year by default) and is the sole credential for that browser. The device list on disk plus the gate's revoke endpoint are your kill switch. Revoke **the specific device id**, never "all of them" — bulk revocation during debugging is the fastest way to lock yourself (or someone else) out.

### L11 — Test both directions separately

Asymmetry is normal: the machine you configured a week ago may lack `publicBaseUrl` while the new one has it. When "it doesn't work", check the direction you did **not** just set up.

## Security boundaries worth stating out loud

- **Tailnet membership is the perimeter.** Anyone who can authorise a device on your tailnet can reach `8081` on every machine (unless `allowedPeers` says otherwise). MFA + device approval + a real ACL are the controls that matter; the plugin only narrows the socket.
- **Tailnet-only is stronger than a public tunnel.** A tunnel that terminates TLS at the edge can see plaintext and gives you a public hostname that gets scanned. Here there is no reachable entry point from the internet at all.
- **Relaying is still end-to-end.** When two peers cannot hole-punch, Tailscale relays WireGuard ciphertext through DERP; the relay sees metadata, not content.
- **Do not commit your addresses.** Tailnet IPs, MagicDNS names, device names and any proxy/token material belong in local config, not in a repository. This document uses placeholders for that reason.

## Rollback, per machine

1. Close DSH.
2. Restore the profile backups: `package.json.bak-*`, `cordis.patch.yml.bak-*`.
3. `pnpm install --ignore-scripts` (or delete the added packages).
4. Delete the firewall rules you added for `8081` and the service blocks.
5. Start DSH; confirm it boots without the plugin.
6. Optionally `tailscale serve reset` and uninstall Tailscale.

## Anti-patterns

| Don't | Because |
| --- | --- |
| Bind `0.0.0.0` "just to test" | one LAN scan away from exposing the app; this plugin rejects it on purpose |
| Use `pairingSource: auto` on multi-host setups | it advertises whatever adapter sorts first — usually one the peer cannot reach |
| Mint a peer's link from another machine | the API is loopback-only by design |
| Run profile installs under a live DSH | it silently unloads the running plugin (**L3**) |
| Set `allowNonTailnet` to work around a VPN hiccup | fixes the symptom by removing the security property |
| Bulk-revoke devices while debugging | you cannot tell your own browser from an intruder afterwards |
| Hard-code the DSH loopback port | it changes on every start and every update |
