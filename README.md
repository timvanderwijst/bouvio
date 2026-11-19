# Bouvio

A desktop workspace where people and agent fleets work together. Phase 1: the app shell and a local runner that drives Claude Code and Codex.

## What works now

- **Desktop app** (Tauri 2): hover rail (left edge or `Ctrl+\`), workspace sidebar with captains and their threads, thread tabs, Overview / Changes / Terminal panel, `Ctrl+K` command palette, light and dark theme, English and Dutch.
- **Runner** (`crates/runner`): starts Claude Code over `stream-json`, keeps one process per thread, records every event to disk, tracks status (working, needs you, idle, error) and cost, gives a thread its own git worktree and branch, and serves real terminals (ConPTY on Windows).
- **Codex** (`codex exec --json`): wired up but not yet tested against a real Codex install.
- **Headless runner** (`bouvio-runner`): the same core without a window, for a VPS or scripts.

Not yet: approvals inside the app, the API loop for OpenRouter and API keys (phase 2), the hub and multiplayer (phase 3). See the spec for the order.

## Run it

You need Rust (stable), Node 22, pnpm 10, and Claude Code and/or Codex on your PATH, logged in.

On **Windows**: install the [Tauri prerequisites](https://tauri.app/start/prerequisites/) (Microsoft C++ Build Tools and WebView2, which Windows 11 already has).
On **Linux**: `libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libayatana-appindicator3-dev`.

```bash
pnpm install
pnpm tauri dev
```

The UI alone, with sample data and no runner, runs in a browser:

```bash
pnpm dev   # http://127.0.0.1:1420
```

Data lives in `~/.bouvio` (set `BOUVIO_DATA` to use another folder). Worktrees go to `~/.bouvio/worktrees/<workspace>/`.

## Headless runner

```bash
cargo run -p bouvio-runner-cli -- detect
cargo run -p bouvio-runner-cli -- run --cwd ~/code/project --isolate "Fix the failing test"
```

## Layout

```
apps/desktop          React UI (src/) + Tauri shell (src-tauri/)
apps/runner-cli       headless runner
crates/protocol       types shared by app, runner and hub; generates TypeScript
crates/runner         harnesses, event log, worktrees, terminals
```

Types are defined once in Rust. After changing `crates/protocol`, run `pnpm types` to regenerate `apps/desktop/src/protocol/`.

## Checks

```bash
cargo test --workspace
pnpm -r typecheck
```

## License

MIT
