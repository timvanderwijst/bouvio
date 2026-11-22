# Plugins

A plugin adds pages, panels, settings, palette commands or always-on pieces to the Cuna desktop app. It is one folder with a manifest and an ES module, loaded while the app runs.

> **Trust.** A plugin runs inside the app with the same access as Cuna itself. With the `rpc` permission it can read every workspace and start agents. Enable only plugins you wrote or trust. Plugins are off until you turn them on in **Settings → Plugins**.

## Where plugins live

```
~/.cuna/plugins/            (or $CUNA_DATA/plugins)
  hello/
    plugin.json
    index.js
```

**Settings → Plugins → Create plugin** writes a working example (`hello`): a page in the rail and a command in `Ctrl+K`. **Open folder** opens this folder, **Reload** loads changed files again. Which plugins are on is kept in `~/.cuna/plugins.json`.

## `plugin.json`

```json
{
  "id": "hello",
  "name": "Hello",
  "version": "0.1.0",
  "description": "A page in the rail and a command in Ctrl+K.",
  "entry": "index.js",
  "permissions": ["rpc", "network"]
}
```

| Field | |
|---|---|
| `id` | Letters, digits, `-` and `_`. Must match the folder name. |
| `name`, `version`, `description` | Shown in Settings. A new `version` makes Reload pick the plugin up again. |
| `entry` | The module to load, relative to the folder. Defaults to `index.js`. |
| `permissions` | `rpc`: may call runner methods through `api.rpc`. `network`: talks to the internet with `fetch`; listed so people can see it before they enable the plugin. |

## The module

The entry is a plain ES module, loaded from a blob URL. It cannot `import` packages by name: everything it needs from the app comes in through `api`. Bundle your own dependencies into the file if you need any (esbuild, `--format=esm`), but never React: use `api.React`.

```js
export function activate(api) {
  const h = api.React.createElement;

  function Hello() {
    return h("div", { className: "page" }, h("h1", { className: "page-title" }, "Hello"));
  }

  api.registerArea({
    pages: [{ id: "page", place: "rail", label: "Hello", icon: api.icons.Smile, component: Hello }],
    commands: [{ id: "hello", label: "Say hello", icon: api.icons.Smile, run: () => api.toast("Hello") }],
  });
}

// Optional: called when the plugin is turned off or reloaded. Its area is removed for you.
export function deactivate() {}
```

`activate` may be `async`. If it throws, Settings shows the error next to the plugin.

## `api`

| | |
|---|---|
| `api.React` | The app's React 19. Hooks work as usual. |
| `api.plugin` | `{ id, name, version, path }` of this plugin. |
| `api.registerArea(area)` | Adds this plugin's area, or replaces it when called again. Same shape as the built-in areas (`src/ext/types.ts`): `pages`, `panels`, `home`, `settings`, `commands`, `overlays`. Ids are namespaced for you (`plugin.<id>.<your id>`), so pick short ones. |
| `api.navigate(pageId, sub?)` | Opens one of this plugin's pages by the id it registered. |
| `api.rpc(method, params?, workspaceId?)` | Calls a runner method, in the current workspace unless you name one. Needs the `rpc` permission. For a shared workspace someone else hosts, it goes through the hub and your role there applies. |
| `api.workspaceId()` | The open workspace, or `null`. |
| `api.t(key, values?)` | The app's translations. A key that does not exist comes back as is, so plain text works as a label. |
| `api.ui.Menu`, `api.ui.Dialog` | The app's dropdown and dialog components. |
| `api.icons` | A set of lucide icons for pages and commands: `Bell`, `BookOpen`, `Bot`, `Calendar`, `ChartLine`, `Check`, `Clock`, `Code`, `FileText`, `Folder`, `Globe`, `Heart`, `Image`, `LayoutGrid`, `List`, `MessageSquare`, `Puzzle`, `Search`, `Settings`, `Smile`, `Sparkles`, `Star`, `Terminal`, `Zap`. Any component that takes a `size` prop works too. |
| `api.toast(message)` | A short message at the bottom of the window. |

### Pieces you can register

- **pages**: `{ id, place: "workspace" | "rail", label, icon, component, order?, flush? }`. `component` gets `{ sub }`.
- **panels**: `{ id, label, component }`, a tab in the right panel; `component` gets `{ thread }`.
- **home**, **settings**, **overlays**: `{ id, component }`. Overlays are always mounted; use them for listeners or floating UI.
- **commands**: `{ id, label, icon, run }` in `Ctrl+K`.

### Styling

Use the app's classes (`page`, `page-title`, `btn`, `btn primary`, `input`, `set-group`, `set-row`) and its colour variables (`var(--ink)`, `var(--mute)`, `var(--sheet)`, `var(--line)`, `var(--accent)`), so the plugin works in light and dark. Inline styles or a `<style>` element from an overlay are fine for anything else.

### Runner methods

`api.rpc` takes the same methods as the app, for example `list_threads {workspace_id}`, `thread_events {thread_id}`, `list_issues {workspace_id}`, `create_issue {workspace_id, title, body?}`, `send_message {thread_id, text}`. Results are the types in `apps/desktop/src/protocol/`.

## Not in the web client

Plugins load only in the desktop app. The web client the hub serves at `/app/` has no plugins.
