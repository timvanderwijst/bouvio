# Site

The Cuna landing page, built from the app's own styles
(`apps/desktop/src/styles`) and parts of a real project. `ui.js` renders the
app parts into `[data-ui]` elements; `site.css` lays out the page and
`parts.css` holds compact versions of app screens.

The page follows the app's navigation:

| Section | App parts |
| --- | --- |
| Hero | the live app window: rail, sidebar with leads, a thread, the overview |
| Agents | stage with overview, a lead's thread, an approval card and the git graph; a task's timeline |
| Team | chat with a lead and a huddle; inbox and my work, roles, machines |
| Work | tabs for issues, pull requests and calendar; tabs for docs, sheets, databases and search |
| Studio | the design board with live branches |
| Build | terminal and preview, automations, integrations; costs and evals |
| Free | plans as rows, local models, your own server, models and tools marquee, FAQ |

People in the examples are made up.

Preview from `apps/` so the shared styles resolve:

```bash
cd apps && python3 -m http.server 1500
```

Then open http://127.0.0.1:1500/site/.
