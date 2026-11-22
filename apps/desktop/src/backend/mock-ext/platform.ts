// Browser-preview stand-ins for this area's runner methods (`handlers`) and
// desktop-only app methods (`app`). See ../mock-bus.ts to fire live events.
import type { PluginInfo } from "../../protocol/PluginInfo";
import type { WorkspaceTemplate } from "../../protocol/WorkspaceTemplate";

const templates: WorkspaceTemplate[] = [
  {
    id: "web-app",
    name: "Web app",
    description: "Frontend, backend and tests leads for a web project, with a dev server for live previews.",
    icon: "app-window",
    instructions: "",
    dev_command: "npm run dev -- --port {port}",
    leads: [
      { name: "Frontend", instructions: "" },
      { name: "Backend", instructions: "" },
      { name: "Tests", instructions: "" },
    ],
    issues: [],
    automations: [],
  },
  {
    id: "marketing-campaign",
    name: "Marketing campaign",
    description: "Copy, design and research leads for a campaign, with a weekly report every Monday.",
    icon: "megaphone",
    instructions: "",
    dev_command: null,
    leads: [
      { name: "Copy", instructions: "" },
      { name: "Design", instructions: "" },
      { name: "Research", instructions: "" },
    ],
    issues: [],
    automations: [],
  },
  {
    id: "finance-analysis",
    name: "Finance analysis",
    description: "An analyst lead for budgets, statements and forecasts, working from your own spreadsheets.",
    icon: "chart-line",
    instructions: "",
    dev_command: null,
    leads: [{ name: "Analyst", instructions: "" }],
    issues: [],
    automations: [],
  },
  {
    id: "research-project",
    name: "Research project",
    description: "A researcher who gathers and checks sources, and a writer who turns them into clear documents.",
    icon: "book-open",
    instructions: "",
    dev_command: null,
    leads: [
      { name: "Researcher", instructions: "" },
      { name: "Writer", instructions: "" },
    ],
    issues: [],
    automations: [],
  },
  {
    id: "personal-assistant",
    name: "Personal assistant",
    description: "One assistant for notes, plans, drafts and errands, with a short brief every weekday morning.",
    icon: "sparkles",
    instructions: "",
    dev_command: null,
    leads: [{ name: "Assistant", instructions: "" }],
    issues: [],
    automations: [],
  },
];

const plugins: PluginInfo[] = [
  {
    manifest: { id: "hello", name: "Hello", version: "0.1.0", description: "An example: a page in the rail and a command in Ctrl+K.", entry: "index.js", permissions: ["rpc"] },
    enabled: false,
    path: "~/.bouvio/plugins/hello",
    error: null,
  },
  {
    manifest: { id: "standup", name: "Standup notes", version: "1.2.0", description: "Collects what every thread did yesterday into one note.", entry: "index.js", permissions: ["rpc", "network"] },
    enabled: true,
    path: "~/.bouvio/plugins/standup",
    error: null,
  },
];

export const handlers: Record<string, (p: Record<string, any>) => unknown> = {
  list_templates: () => templates,
  create_workspace_from_template: (p) => ({
    id: crypto.randomUUID(),
    name: p.name || templates.find((t) => t.id === p.template_id)?.name || "Workspace",
    kind: "personal",
    root: p.root ?? null,
    created_at: new Date().toISOString(),
    role: null,
    host: null,
  }),
  export_workspace: (p) => ({ path: p.path, bytes: 1_840_000, threads: 11, artifacts: 4, artifacts_skipped: 0 }),
};

export const app: Record<string, (p: Record<string, any>) => unknown> = {
  app_info: () => ({ version: "0.1.0", updater: true }),
  plugins_list: () => plugins,
  plugins_dir: () => "~/.bouvio/plugins",
  plugin_set_enabled: (p) => {
    const x = plugins.find((x) => x.manifest.id === p.id);
    if (x) x.enabled = p.enabled;
    return null;
  },
  plugin_create: () => plugins[0],
  dialog_save: (p) => `~/Downloads/${p.name ?? "backup.zip"}`,
  dialog_open: () => null,
};
