# Releases and updates

Releases are built by GitHub Actions (free for this public repository) and published on GitHub Releases. Nobody pays for hosting: the app checks `https://github.com/timvanderwijst/bouvio/releases/latest/download/latest.json` and downloads from the release itself.

## One-time setup: the updater key

The app only installs updates signed with your key.

1. Generate a key pair (keep the password):

   ```bash
   cd apps/desktop
   pnpm tauri signer generate -w ~/.tauri/cuna.key
   ```

2. Put the **public** key (the contents of `~/.tauri/cuna.key.pub`) in `apps/desktop/src-tauri/tauri.conf.json` under `plugins.updater.pubkey`, replacing `REPLACE_WITH_UPDATER_PUBLIC_KEY`, and commit it.

3. In the repository on GitHub, **Settings → Secrets and variables → Actions**, add:

   - `TAURI_SIGNING_PRIVATE_KEY`: the contents of `~/.tauri/cuna.key`
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: its password

Never commit the private key. If it is lost, installed apps cannot verify new updates; people then install the next version by hand once.

Until the public key is set, the app runs normally and **Settings → Updates** says updates are not configured. Without the secrets, release builds still work but carry no updater files.

## Making a release

1. Bump `version` in `apps/desktop/src-tauri/tauri.conf.json` (and `version` in the root `Cargo.toml` to match).
2. Commit, then tag and push:

   ```bash
   git tag v0.2.0
   git push origin v0.2.0
   ```

3. The **Release** workflow creates a draft release and adds:
   - the desktop app for Windows, macOS (universal) and Linux, with `latest.json` and signatures for the updater,
   - `cuna-runner` binaries for Linux (x86_64, arm64), macOS (arm64, x86_64) and Windows,
   - the hub image `ghcr.io/timvanderwijst/cuna-hub:<version>` (and `:latest`), for amd64 and arm64.
4. Read the draft on GitHub and publish it. Apps see the update within a day, or at once with **Settings → Updates → Check for updates**.

The macOS and Windows builds are not code-signed by an Apple or Microsoft certificate (those cost money), so the first install shows the system's warning for unknown developers. Updates after that install quietly.

## Local builds

`pnpm tauri build` makes updater artifacts and needs `TAURI_SIGNING_PRIVATE_KEY` in the environment. Without a key, use:

```bash
pnpm --filter @cuna/desktop tauri:build-unsigned
```
