// Browser-preview stand-ins for this area's runner methods (`handlers`) and
// desktop-only app methods (`app`). See ../mock-bus.ts to fire live events.
import type { Artifact } from "../../protocol/Artifact";
import type { InstalledSkill } from "../../protocol/InstalledSkill";
import type { Issue } from "../../protocol/Issue";
import type { KnowledgeIndexStatus } from "../../protocol/KnowledgeIndexStatus";
import type { McpCatalogEntry } from "../../protocol/McpCatalogEntry";
import type { McpServer } from "../../protocol/McpServer";
import type { SearchHit } from "../../protocol/SearchHit";
import type { SearchLocation } from "../../protocol/SearchLocation";
import type { SkillEntry } from "../../protocol/SkillEntry";
import type { Thread } from "../../protocol/Thread";
import type { ThreadEnvelope } from "../../protocol/ThreadEnvelope";
import type { Workspace } from "../../protocol/Workspace";
import type { WorkspaceSettings } from "../../protocol/WorkspaceSettings";
import { mockFire } from "../mock-bus";

/** The rest of the preview's fake runner, loaded lazily (it imports this file). */
const base = async <T,>(ws: string | null, method: string, params: Record<string, unknown> = {}) => (await import("../mock")).mockBackend.rpc<T>(ws, method, params);

interface Item {
  workspace_id: string;
  kind: string;
  id: string;
  title: string;
  text: string;
  location: SearchLocation;
}

// Files and docs the preview pretends to have indexed, next to the sample threads and issues.
const FILES: [string, string][] = [
  ["README.md", "Cuna is a desktop workspace where people and agent fleets work together, live, without pushing to Git first. Data lives in ~/.cuna."],
  ["crates/runner/src/lib.rs", "The Cuna runner: the part that actually runs agents. It owns the threads on this machine, drives their harness, keeps their event log and status."],
  ["crates/runner/src/work.rs", "Own issue tracker with GitHub sync, pull requests and merges through gh, commits from a thread, scheduled automations (cron)."],
  ["apps/hub/README.md", "Host a hub on your VPS with docker compose. Members sign in with email codes, Google or GitHub, and get a role from viewer to admin."],
  ["apps/desktop/src/styles/tokens.css", "Cuna design tokens. Light and dark are equals, not inversions. One accent, soft surfaces, one easing curve."],
  ["docs/search.md", "Search fuses BM25 keyword ranking with embeddings through reciprocal rank fusion, so exact names and loose meaning both find their way to the top."],
];
const DOCS: [string, string, string][] = [
  ["doc", "Launch plan", "We ship the public beta on Friday. Hub invites go out to the waitlist first; the sign-up form needs the new rate limit before then."],
  ["doc", "Pricing notes", "The maintainer pays nothing: models run on the user's own keys or local models, and the hub runs on their own VPS."],
  ["note", "Standup 14 Nov", "Runner: worktree cleanup is flaky on Windows. Design: dark mode contrast on chips. Hub: presence drops after sleep."],
  ["sheet", "Q4 budget", "Hosting 12.50 per month, domains 30 per year, design tools 0 because we use the open-source ones."],
];

const imported: Item[] = [];
let corpusCache: { at: number; items: Item[] } | null = null;

async function corpus(): Promise<Item[]> {
  if (corpusCache && Date.now() - corpusCache.at < 5000) return [...corpusCache.items, ...imported];
  const workspaces = await base<Workspace[]>(null, "list_workspaces");
  const items: Item[] = [];
  for (const w of workspaces) {
    const threads = await base<Thread[]>(w.id, "list_threads", { workspace_id: w.id }).catch(() => [] as Thread[]);
    for (const t of threads) {
      const events = await base<ThreadEnvelope[]>(w.id, "thread_events", { thread_id: t.id }).catch(() => [] as ThreadEnvelope[]);
      const text = events
        .map((e) => (e.event.type === "user_message" || e.event.type === "assistant_text" ? e.event.text : ""))
        .filter(Boolean)
        .join("\n\n");
      items.push({ workspace_id: w.id, kind: "thread", id: t.id, title: t.title, text, location: { type: "thread", thread_id: t.id } });
    }
    const issues = await base<Issue[]>(w.id, "list_issues", { workspace_id: w.id }).catch(() => [] as Issue[]);
    for (const i of issues) items.push({ workspace_id: w.id, kind: "issue", id: i.id, title: `${i.key} ${i.title}`, text: i.body, location: { type: "issue", issue_id: i.id } });
  }
  const first = workspaces[0]?.id;
  if (first) {
    for (const [path, text] of FILES) items.push({ workspace_id: first, kind: "file", id: path, title: path, text, location: { type: "file", path } });
    DOCS.forEach(([kind, title, text], n) => items.push({ workspace_id: first, kind, id: `${kind}-${n}`, title, text, location: { type: "doc", kind, id: `${kind}-${n}` } }));
  }
  corpusCache = { at: Date.now(), items };
  return [...items, ...imported];
}

const words = (q: string) => [...new Set(q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean))];

function snippet(text: string, toks: string[]) {
  const flat = text.replace(/\s+/g, " ").trim();
  const lower = flat.toLowerCase();
  const isStart = (i: number) => i === 0 || !/[\p{L}\p{N}]/u.test(lower[i - 1]);
  let first = -1;
  for (let i = 0; i < lower.length && first < 0; i++) if (isStart(i) && toks.some((t) => lower.startsWith(t, i))) first = i;
  let start = Math.max(0, (first < 0 ? 0 : first) - 40);
  if (start > 0) start = flat.indexOf(" ", start) + 1 || start;
  const body = flat.slice(start, start + 180);
  const out = (start > 0 ? "…" : "") + body + (start + 180 < flat.length ? "…" : "");
  const lo = out.toLowerCase();
  const highlights: [number, number][] = [];
  for (let i = 0; i < lo.length; i++) {
    if (i > 0 && /[\p{L}\p{N}]/u.test(lo[i - 1])) continue;
    const t = toks.filter((x) => lo.startsWith(x, i)).sort((a, b) => b.length - a.length)[0];
    if (t) {
      highlights.push([i, i + t.length]);
      i += t.length - 1;
    }
  }
  return { text: out, highlights };
}

const settingsOf = (ws: string) => base<WorkspaceSettings>(ws, "workspace_settings", { workspace_id: ws });
async function saveSettings(ws: string, s: WorkspaceSettings) {
  await base(ws, "workspace_settings_set", { workspace_id: ws, settings: s });
  mockFire("workspace-notice", { workspace_id: ws, kind: "settings-changed", payload: s });
  return s;
}

const REGISTRY: McpCatalogEntry[] = [
  {
    name: "io.github.github/github-mcp-server",
    short_name: "github",
    description: "Issues, pull requests, code search and Actions on GitHub.",
    version: "0.18.0",
    repository: "https://github.com/github/github-mcp-server",
    runtime: "docker",
    command: "docker",
    args: ["run", "-i", "--rm", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN", "ghcr.io/github/github-mcp-server"],
    env: [{ name: "GITHUB_PERSONAL_ACCESS_TOKEN", description: "A fine-grained token with the repositories you want agents to reach.", required: true, secret: true, default: null }],
  },
  {
    name: "io.github.modelcontextprotocol/filesystem",
    short_name: "filesystem",
    description: "Read, write and search files in folders you allow.",
    version: "2025.8.21",
    repository: "https://github.com/modelcontextprotocol/servers",
    runtime: "npx",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem@2025.8.21", "~/Documents"],
    env: [],
  },
  {
    name: "io.github.makenotion/notion-mcp-server",
    short_name: "notion-mcp-server",
    description: "Search, read and update pages and databases in Notion.",
    version: "1.9.0",
    repository: "https://github.com/makenotion/notion-mcp-server",
    runtime: "npx",
    command: "npx",
    args: ["-y", "@notionhq/notion-mcp-server@1.9.0"],
    env: [{ name: "NOTION_TOKEN", description: "Integration token from notion.so/my-integrations.", required: true, secret: true, default: null }],
  },
  {
    name: "io.github.getsentry/sentry-mcp",
    short_name: "sentry-mcp",
    description: "Issues, events and releases from Sentry, for debugging with real stack traces.",
    version: "0.17.1",
    repository: "https://github.com/getsentry/sentry-mcp",
    runtime: "npx",
    command: "npx",
    args: ["-y", "@sentry/mcp-server@0.17.1"],
    env: [
      { name: "SENTRY_ACCESS_TOKEN", description: "User auth token with org:read and event:read.", required: true, secret: true, default: null },
      { name: "SENTRY_HOST", description: "For self-hosted Sentry.", required: false, secret: false, default: "sentry.io" },
    ],
  },
  {
    name: "io.github.pydantic/mcp-run-python",
    short_name: "mcp-run-python",
    description: "Run Python in a sandbox for quick calculations and data checks.",
    version: "0.0.21",
    repository: "https://github.com/pydantic/mcp-run-python",
    runtime: "uvx",
    command: "uvx",
    args: ["mcp-run-python", "stdio"],
    env: [],
  },
  {
    name: "com.example/hosted-search",
    short_name: "hosted-search",
    description: "A hosted search API that needs an account header.",
    version: "1.0.0",
    repository: null,
    runtime: null,
    command: null,
    args: [],
    env: [],
  },
];

const skill = (name: string, description: string): SkillEntry => ({
  name,
  description,
  source: { repo: "anthropics/skills", path: `skills/${name}`, git_ref: "HEAD" },
  url: `https://github.com/anthropics/skills/tree/HEAD/skills/${name}`,
});
const CATALOG: SkillEntry[] = [
  skill("algorithmic-art", "Create generative art with p5.js, with seeded randomness and interactive parameters."),
  skill("brand-guidelines", "Apply brand colors and typography to documents and slides."),
  skill("docx", "Create, edit and analyze Word documents, with tracked changes and comments."),
  skill("mcp-builder", "Guide for building MCP servers that let models use external services well."),
  skill("pdf", "Extract text and tables, fill forms, merge and split PDF files."),
  skill("webapp-testing", "Test local web apps with Playwright: screenshots, logs and UI checks."),
  skill("xlsx", "Spreadsheets with formulas, formatting and charts; read and analyze data."),
];
const installedSkills: Record<string, InstalledSkill[]> = {};
let skillSources: string[] = [];

export const handlers: Record<string, (p: Record<string, any>) => unknown> = {
  async search({ workspace_id, query, kinds, limit }) {
    const toks = words(String(query ?? ""));
    if (!toks.length) return [];
    const all = await corpus();
    const last = toks[toks.length - 1];
    const hits: SearchHit[] = [];
    for (const it of all) {
      if (workspace_id && it.workspace_id !== workspace_id) continue;
      if (kinds?.length && !kinds.includes(it.kind)) continue;
      const hay = words(`${it.title} ${it.text}`);
      const title = words(it.title);
      const match = (t: string) => hay.some((w) => w === t || (t === last && w.startsWith(t)));
      if (!toks.every(match)) continue;
      const score = toks.reduce((s, t) => s + (title.some((w) => w.startsWith(t)) ? 2 : 0) + hay.filter((w) => w.startsWith(t)).length * 0.1, 0);
      hits.push({ kind: it.kind, id: it.id, title: it.title, snippet: snippet(it.text || it.title, toks), score, workspace_id: it.workspace_id, location: it.location });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit ?? 30);
  },
  async get_index_status({ workspace_id }): Promise<KnowledgeIndexStatus> {
    const n = (await corpus()).filter((i) => i.workspace_id === workspace_id).length;
    return { workspace_id, docs: n * 37, vectors: n * 112, pending: 0, semantic: true, last_scan: new Date(Date.now() - 4 * 60_000).toISOString() };
  },
  async reindex({ workspace_id }) {
    corpusCache = null;
    const s = await handlers.get_index_status({ workspace_id });
    mockFire("workspace-notice", { workspace_id, kind: "knowledge-index", payload: s });
    return s;
  },
  async import_file({ workspace_id, path }) {
    return addImport(workspace_id, String(path).split(/[\\/]/).pop() || "import", `Imported from ${path}.`);
  },
  async import_bytes({ workspace_id, name, base64 }) {
    let text = "";
    try {
      text = atob(String(base64)).slice(0, 4000);
    } catch {}
    return addImport(workspace_id, name, /[\x00-\x08]/.test(text) ? `Converted ${name} to Markdown.` : text);
  },
  async clip_url({ workspace_id, url }) {
    if (!/^https?:\/\/\S+\.\S+/.test(String(url)) && !/^\S+\.\S+$/.test(String(url))) throw new Error("not a web address");
    const host = String(url).replace(/^https?:\/\//, "").split("/")[0];
    return addImport(workspace_id, `Article from ${host}`, `The main text of ${url}, without menus, ads or scripts.`);
  },
  async search_mcp_registry({ query }) {
    const q = String(query ?? "").toLowerCase().trim();
    await new Promise((r) => setTimeout(r, 250));
    return REGISTRY.filter((e) => !q || `${e.name} ${e.description}`.toLowerCase().includes(q));
  },
  async install_mcp({ workspace_id, server }) {
    const s = await settingsOf(workspace_id);
    return saveSettings(workspace_id, { ...s, mcp_servers: [...s.mcp_servers.filter((m) => m.name !== (server as McpServer).name), server as McpServer] });
  },
  async remove_mcp({ workspace_id, name }) {
    const s = await settingsOf(workspace_id);
    return saveSettings(workspace_id, { ...s, mcp_servers: s.mcp_servers.filter((m) => m.name !== name) });
  },
  async list_skills_catalog() {
    await new Promise((r) => setTimeout(r, 300));
    return CATALOG;
  },
  get_skill_sources: () => skillSources,
  set_skill_sources({ sources }) {
    skillSources = (sources as string[]).map((s) => s.trim()).filter(Boolean);
    return skillSources;
  },
  async install_skill({ workspace_id, source }) {
    const entry = CATALOG.find((c) => c.source.path === source.path);
    const name = entry?.name ?? String(source.path).split("/").pop()!;
    const s: InstalledSkill = { name, description: entry?.description ?? "", path: `~/code/cuna/.claude/skills/${name}` };
    installedSkills[workspace_id] = [...(installedSkills[workspace_id] ?? []).filter((x) => x.name !== name), s].sort((a, b) => a.name.localeCompare(b.name));
    await new Promise((r) => setTimeout(r, 400));
    return s;
  },
  list_installed_skills: ({ workspace_id }) => (installedSkills[workspace_id] ??= [{ name: "pdf", description: CATALOG[4].description, path: "~/code/cuna/.claude/skills/pdf" }]),
  remove_skill({ workspace_id, name }) {
    installedSkills[workspace_id] = (installedSkills[workspace_id] ?? []).filter((x) => x.name !== name);
    return null;
  },
};

function addImport(workspace_id: string, name: string, text: string): Artifact {
  const slug = name.toLowerCase().replace(/\.[a-z0-9]+$/, "").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || "import";
  const a: Artifact = {
    id: crypto.randomUUID(),
    workspace_id,
    thread_id: null,
    kind: "markdown",
    title: name,
    path: `~/code/cuna/.cuna/imports/${slug}.md`,
    size: text.length + 80,
    created_at: new Date().toISOString(),
    prompt: null,
    model: null,
  };
  imported.push({ workspace_id, kind: "artifact", id: a.id, title: name, text, location: { type: "artifact", artifact_id: a.id, path: a.path } });
  mockFire("workspace-notice", { workspace_id, kind: "artifact-changed", payload: a });
  return a;
}

export const app: Record<string, (p: Record<string, any>) => unknown> = {};
