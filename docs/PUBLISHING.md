# Publishing checklist

Everything below is ordered; steps 1-2 work offline, 3-5 need network and
credentials.

## 1. Local repo

```bash
cd dsh-tailscale-serve
git init -b main
git add -A
git commit -m "dsh-tailscale-serve 0.1.0"
node --test
npm pack --dry-run
```

## 2. Sanity check the tarball contents

`npm pack --dry-run` must list exactly: LICENSE, README.md, README.zh.md,
SECURITY.md, cordis.patch.yml, index.js, lib/forwarder.js, lib/net-guard.js,
package.json. No `test/`, no `scripts/`, no `node_modules`.

## 3. GitHub

```bash
gh repo create Michael-Durant/dsh-tailscale-serve --public --source . --push
# or: git remote add origin git@github.com:Michael-Durant/dsh-tailscale-serve.git && git push -u origin main
```

Then set the topic `dsh-plugin` and a one-line description that mentions
"tailnet-only".

## 4. npm

```bash
npm login                       # must be logged in; check with: npm whoami
npm publish --access public     # prepublishOnly runs node --test
```

If 2FA is enforced, pass `--otp <code>`.

## 5. DeepSeek plugin market

The in-app market ("插件 → 发现 → 索引源") reads `index.json` from the npm
package `dsh-plugin-catalog`. Getting listed means adding one entry to that
catalog and opening a PR:

1. Fork the catalog repo (or the repo the current index source points at).
2. Append to `index.json` (field names follow the existing entries; change
   nothing else):

   ```json
   {
     "name": "dsh-tailscale-serve",
     "title": "Tailscale Serve",
     "description": "Expose the DSH web GUI to your own devices over Tailscale only — never binds 0.0.0.0, fails closed without a pairing gate.",
     "version": "0.1.0",
     "author": "Michael-Durant",
     "repo": "https://github.com/Michael-Durant/dsh-tailscale-serve",
     "npm": "https://www.npmjs.com/package/dsh-tailscale-serve",
     "tags": ["remote", "tailscale", "network", "security"],
     "dsh": ">=0.2.2-rc.3"
   }
   ```

3. Open the PR with a short note: what it does, the security defaults, and the
   fact that pairing is optional (`pairingCheck: "off"`).

## 6. After publishing

- Tag the release: `git tag v0.1.0 && git push --tags`.
- Ask a second machine to `pnpm add dsh-tailscale-serve` and confirm the log
  line `ready: http://<tailnet ip>:8081 gate=paired`.
- Never publish with `allowUnpaired: true` in `cordis.patch.yml`; the shipped
  default patch must stay fail-closed.
