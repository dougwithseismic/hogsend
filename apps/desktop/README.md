# @hogsend/desktop

A native macOS **companion app** for Hogsend — lives in the menu bar and keeps
an eye on your lifecycle engine without you having to open a browser tab.

Built with [Tauri v2](https://tauri.app) (Rust shell + React/Vite frontend), so
it's a small native binary that reuses the existing web stack.

## What it does

- **Menu-bar status** — polls `GET /v1/health` on the active instance every 15s
  and shows a live glyph (🟢 / 🟡 / 🔴) plus a failure count.
- **Dashboard** — status, version, uptime, component health (database / Redis /
  worker), pending-migration warnings, and the last-24h send/journey activity.
- **Native notifications** — fires when a new email/journey failure appears or
  the worker goes offline (de-duplicated against the previous sample).
- **Connection manager** — save multiple instances (local dev, staging, prod)
  and switch the active one. Stored locally; no secrets.
- **Open Studio** — launches the real `${baseUrl}/studio` in a dedicated
  webview window, so auth uses first-party cookies and you get the full UI.

Health is fetched from the Rust side (not the webview), so it sidesteps CORS and
keeps polling while the window is hidden.

## Develop

```bash
pnpm --filter @hogsend/desktop dev        # tauri dev (Rust + Vite, hot reload)
pnpm --filter @hogsend/desktop dev:vite   # frontend only, in a browser
```

## Build

```bash
pnpm --filter @hogsend/desktop build       # frontend assets only (CI-safe)
pnpm --filter @hogsend/desktop tauri:build # full .app + .dmg bundle
```

Bundles land in `src-tauri/target/release/bundle/` (or `target/debug/bundle/`
with `--debug`).

## Release (local, no CI)

Cut releases from your Mac and push them live — no GitHub Actions runner.

```bash
# one-time: generate the updater signing key (keep it secret, outside the repo)
pnpm --filter @hogsend/desktop exec tauri signer generate -w ~/.tauri/hogsend-updater.key
# → put the printed PUBLIC key in src-tauri/tauri.conf.json (plugins.updater.pubkey)

# each release: bump version in src-tauri/tauri.conf.json, then:
pnpm --filter @hogsend/desktop release            # build + publish
pnpm --filter @hogsend/desktop release --dry-run  # build + sign only, no publish
```

`scripts/release.sh` is **OS-aware** — on macOS it builds a signed universal
(Intel + Apple Silicon) `.dmg`; on Windows (Git Bash) it builds a signed NSIS
`.exe`. Then, with `gh`:

- creates/updates **`desktop-v<version>`** with the installer + updater asset
  (`--latest=false`, so it never steals the repo's "Latest release" badge from
  the `@hogsend/*` npm tags);
- **merges** this platform's entry into `latest.json` on the stable
  **`desktop-latest`** prerelease (keeping the other OS's entry), and uploads a
  stable-named installer (`Hogsend.dmg` / `Hogsend-setup.exe`) — the URLs the
  updater and the docs "Download" button point at. Post-publish it re-fetches
  the feed and fails loudly if the swap left it broken.

### Windows

Same app, same script — but you can't cross-build Windows from a Mac. Two ways:

- Run `pnpm --filter @hogsend/desktop release` on a Windows machine (Git Bash +
  MSVC build tools); it produces the NSIS installer and merges `windows-x86_64`
  into the same feed.
- Or let CI do it: `.github/workflows/desktop-windows.yml` runs that script on a
  `windows-latest` runner when a `desktop-v*` tag appears. One-time, add the
  `TAURI_SIGNING_PRIVATE_KEY` (+ `…_PASSWORD`) repo secrets so it can sign.

`keyring` uses `apple-native` on macOS and `windows-native` on Windows (selected
per target in `Cargo.toml`); the tray icon is templated only on macOS.

**Auto-update:** the app checks `desktop-latest/latest.json` on launch (notify
only) and applies updates from the tray → *Check for Updates…*. The updater
verifies its own minisign signature, independent of OS code-signing.

### Signing / first launch

The build is **not yet Apple-signed/notarized**, so the first download is
Gatekeeper-quarantined. Open it once with:

```bash
xattr -dr com.apple.quarantine /Applications/Hogsend.app   # or right-click → Open
```

After that, in-app auto-updates apply cleanly (no re-quarantine — the running
app swaps itself). To ship without that step, add an Apple Developer ID and set
`APPLE_SIGNING_IDENTITY` / notarization env before `release`.

## Layout

```
src/                 React shell (connection manager + health dashboard)
  lib/bridge.ts      typed wrapper over the Rust commands/events
  lib/types.ts       mirrors GET /v1/health + the Rust Snapshot
src-tauri/src/lib.rs the poller, tray, notifications, and commands
```

## Server contract (the only thing that can drift)

Studio itself is **not** forked — `open_studio` loads the live `${baseUrl}/studio`
in a webview, so journeys/emails/sends/contacts are always the deployed Studio.

The companion only hand-mirrors a thin slice of the server contract:

- **`GET /v1/health`** — the menubar poller, read in `src-tauri/src/lib.rs`
  (JSON pointers) and `src/lib/types.ts` (TS types).
- **`/api/auth/get-session` + `/api/auth/sign-in/email`** — the Studio
  auto-login, in `src-tauri/src/lib.rs` (`AUTH_BASE`).

Those paths live as constants at the top of `lib.rs` and are guarded by
`apps/api/src/__tests__/desktop-companion-contract.test.ts` — if the engine
renames a key the companion reads, that test fails on purpose. Update both ends
(the Rust pointers/constants and the TS types) in the same change.

## Regenerate the app icon

```bash
pnpm --filter @hogsend/desktop exec tauri icon path/to/1024x1024.png
```
