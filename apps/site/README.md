# Site

Five versions of the Bouvio landing page, built from the app's own styles
(`apps/desktop/src/styles`) and parts of a real project.

| Page | Focus | App parts |
| --- | --- | --- |
| `v1.html` | The shared workspace | app window, approval card, chat with @captain, design board |
| `v2.html` | The agent fleet | overview, captain thread with spawned threads, git graph, costs |
| `v3.html` | Docs and sheets | doc, sheet with formulas, database board, search |
| `v4.html` | Working together | chat with huddle, board with cursors, roles, inbox |
| `v5.html` | Free and local | local models, VPS runner, budgets, app window |

Preview from `apps/` so the shared styles resolve:

```bash
cd apps && python3 -m http.server 1500
```

Then open http://127.0.0.1:1500/site/.
