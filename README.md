# Bouvio

A desktop workspace where people and agent fleets work together, live, without pushing to Git first.

Bouvio runs the agents you already have (Claude Code, Codex) and models from your own keys, on your own machines. A small hub you host lets others join your workspace: they see threads, diffs and terminals as they happen, chat, and steer agents with the role you give them. Bouvio never pays for or proxies model calls.

## What's in it

| Area | What it does |
| --- | --- |
| **Captains and threads** | Long-lived agents per domain (captains) split work into threads. Each thread can get its own git worktree and branch. Status per agent: working, needs you, idle, error. |
| **Harnesses** | Claude Code (`stream-json`, one process per thread, resumed after restarts), Codex (`codex exec --json`), and Bouvio's own agent loop for API keys: OpenRouter, Anthropic, OpenAI, Google. |
| **Approvals** | Ask for everything, ask when risky, or free. Claude Code's permission prompts and the API loop's risky tools land in the thread as a card anyone with the right role can answer. |
| **Fleet tools** | Every agent gets a `bouvio` MCP server: `spawn_thread`, `list_threads`, `thread_status`, `create_issue`, `remember`. |
| **Work** | Own issue tracker with GitHub sync, pull requests and merges through `gh`, commits from a thread, scheduled automations (cron). |
| **Studio** | Artifacts agents make (HTML, images, documents, media) with previews; image, video and speech generation with your keys; design boards with live frames of each branch's dev server, variants, remote cursors. |
| **Knowledge** | Workspace instructions, editable memory, MCP servers per workspace. |
| **Multiplayer** | Hub with email codes and Google/GitHub sign-in, invites with roles (viewer → admin), chat, presence, relay of RPCs to the hosting runner. |
| **Everywhere** | Hover rail (left edge or `Ctrl+\`), `Ctrl+K`, light and dark, English and Dutch, voice input. |
| **Local AI** | Ollama and LM Studio models in the agent loop, whisper.cpp for voice input, Piper for speech, ComfyUI for images, local embeddings. No keys, no subscription. |
| **Office** | Docs, Sheets (with a formula engine), Slides, databases with table, board, calendar and gallery views, a calendar, and public forms. All live and collaborative over Yjs. |
| **Knowledge** | Search over threads, issues, files, docs and imports (full text plus meaning), PDF/Word/Excel import, a web clipper, the MCP registry and a skills catalogue. |
| **Communication** | Chat with channels, threads, reactions and pins; `@Captain` in chat runs that captain; huddles with voice, video and screen share (WebRTC, TURN on your own VPS); an inbox and OS notifications. |
| **Developer tools** | Browser preview with an element picker, line-by-line review sent to the agent, CI checks through `gh`, a database viewer, an API client and a git graph. |
| **Overview** | A morning brief, personal tasks and notes, costs with monthly budgets, replay of any run, and evals that compare agents and models. |
| **Platform** | A web/PWA client served by the hub, auto-updates from GitHub Releases, plugins, workspace backup and import, and templates. |

## Layout

```
apps/desktop          Tauri 2 app: React UI (src/) + Rust shell with the runner built in (src-tauri/)
apps/hub              hub server (axum + SQLite), Dockerfile and compose.yml
apps/runner-cli       headless runner: `serve` hosts shared workspaces from a VPS
crates/protocol       types shared by app, runner and hub; generates TypeScript
crates/runner         harnesses, event log, approvals, MCP server, worktrees, terminals, issues, studio, hub client
crates/agent          Bouvio's agent loop, tools, providers, keychain, media generation
```

## Run the app

You need Rust (stable), Node 22, pnpm 10, and Claude Code and/or Codex on your PATH, logged in. For pull requests and GitHub sync, the `gh` CLI, logged in.

On **Windows**: the [Tauri prerequisites](https://tauri.app/start/prerequisites/) (Microsoft C++ Build Tools; WebView2 ships with Windows 11).
On **Linux**: `libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libayatana-appindicator3-dev`.

```bash
pnpm install
pnpm tauri dev
```

The UI alone runs in a browser with sample data: `pnpm dev` → http://127.0.0.1:1420.

Data lives in `~/.bouvio` (`BOUVIO_DATA` to change). API keys live in the OS keychain.

## Host a hub

See [`apps/hub/README.md`](apps/hub/README.md). Short version, on your VPS:

```bash
docker compose -f apps/hub/compose.yml up -d
```

Then in the app: Settings → Hub → Sign in, and Share on a workspace.

## Keep agents working at night

On the VPS, next to the hub or anywhere else:

```bash
cargo run --release -p bouvio-runner-cli -- serve --hub https://hub.example.com --token <your hub token>
```

## Docs

- [Plugins](docs/plugins.md)
- [Releases and updates](docs/releases.md)

## Checks

```bash
cargo test --workspace
pnpm -r typecheck
pnpm --filter @bouvio/desktop test:web
```

## License

MIT
