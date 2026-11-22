// Browser preview: a fake runner with sample data, so the UI can be built and
// screenshotted without Tauri. Nothing here touches the disk or a model.

import type { Lead } from "../protocol/Lead";
import type { Thread } from "../protocol/Thread";
import type { ThreadEnvelope } from "../protocol/ThreadEnvelope";
import type { ThreadEvent } from "../protocol/ThreadEvent";
import type { Workspace } from "../protocol/Workspace";
import type { Artifact } from "../protocol/Artifact";
import type { Automation } from "../protocol/Automation";
import type { Board } from "../protocol/Board";
import type { ChatMessage } from "../protocol/ChatMessage";
import type { HubUser } from "../protocol/HubUser";
import type { Issue } from "../protocol/Issue";
import type { Member } from "../protocol/Member";
import type { PullRequest } from "../protocol/PullRequest";
import type { WorkspaceSettings } from "../protocol/WorkspaceSettings";
import type { Backend } from "./types";
import { listeners, mockFire } from "./mock-bus";
import * as xComms from "./mock-ext/comms";
import * as xDev from "./mock-ext/dev";
import * as xKnowledge from "./mock-ext/knowledge";
import * as xLocal from "./mock-ext/local";
import * as xOffice from "./mock-ext/office";
import * as xPersonal from "./mock-ext/personal";
import * as xPlatform from "./mock-ext/platform";

const EXT = [xComms, xDev, xKnowledge, xLocal, xOffice, xPersonal, xPlatform];

const uid = () => crypto.randomUUID();
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

const ws: Workspace[] = [
  { id: uid(), name: "Cuna", kind: "shared", root: "~/code/cuna", created_at: ago(9000), role: null, host: null },
  { id: uid(), name: "northwind.dev", kind: "personal", root: "~/code/northwind", created_at: ago(20000), role: null, host: null },
  { id: uid(), name: "Q1 planning", kind: "personal", root: null, created_at: ago(3000), role: null, host: null },
];
const B = ws[0].id;

const cap = (name: string, seed: number, instructions: string): Lead => ({
  id: uid(),
  workspace_id: B,
  name,
  instructions,
  harness: "claude_code",
  model: null,
  effort: "medium",
  approval: "ask_risky",
  avatar_seed: seed,
});

const leads: Lead[] = [
  cap("Desktop", 11, "Owns apps/desktop: the Tauri shell and the React UI."),
  cap("Runner", 23, "Owns crates/runner: harnesses, terminals, worktrees."),
  cap("Hub", 37, "Owns apps/hub: accounts, sync and presence."),
  cap("Design", 41, "Owns tokens, components and motion."),
  cap("Docs", 53, "Keeps README and docs in step with the code."),
];

function thread(c: Lead | null, title: string, status: Thread["status"], min: number, extra: Partial<Thread> = {}): Thread {
  return {
    id: uid(),
    workspace_id: c?.workspace_id ?? B,
    lead_id: c?.id ?? null,
    title,
    harness: "claude_code",
    model: null,
    effort: "medium",
    approval: "ask_risky",
    status,
    cwd: "~/code/cuna",
    branch: "main",
    created_at: ago(min + 30),
    updated_at: ago(min),
    cost_usd: 0,
    session_id: null,
    ...extra,
  };
}

const [desktop, runner, hub, design] = leads;
const threads: Thread[] = [
  thread(desktop, "Desktop", "idle", 3, { cost_usd: 0.41, created_at: ago(20000) }),
  thread(desktop, "Keep a draft per thread in the composer", "idle", 4, { branch: "cuna/3f9a2c1e", cost_usd: 0.38 }),
  thread(desktop, "Rail shows on hover at the left edge", "working", 1, { branch: "cuna/7be04d55" }),
  thread(runner, "Runner", "idle", 40, { created_at: ago(20000) }),
  thread(runner, "Find Codex on the Windows PATH", "working", 2, { branch: "cuna/c01d9e72" }),
  thread(runner, "Resume Claude sessions after a restart", "idle", 55, { cost_usd: 0.22 }),
  thread(hub, "Hub", "idle", 300, { created_at: ago(20000) }),
  thread(hub, "Magic link sign-in", "blocked", 12, { branch: "cuna/a4410b9f" }),
  thread(design, "Design", "idle", 600, { created_at: ago(20000) }),
  thread(design, "Diff colors in the dark theme", "error", 90, { branch: "cuna/5d2e7a03" }),
  thread(null, "What does Herdr do with a blocked pane?", "idle", 180, { cost_usd: 0.04 }),
];

const events = new Map<string, ThreadEnvelope[]>();
function seed(t: Thread, list: ThreadEvent[], startMin: number) {
  events.set(
    t.id,
    list.map((event, i) => ({ thread_id: t.id, seq: i, at: ago(startMin - i * 0.1), event })),
  );
}

const firstThread = threads[0];
seed(
  firstThread,
  [
    { type: "user_message", text: "Switching threads wipes what I was typing in the composer. Keep a draft per thread, and check the rail while you're at it.", author: "Maya" },
    { type: "status", status: "working" },
    { type: "tool_use", id: "a", name: "Grep", input: { pattern: "draft", path: "apps/desktop/src" } },
    { type: "tool_result", tool_use_id: "a", output: "apps/desktop/src/components/Composer.tsx:42:  const [draft, setDraft] = useState(\"\");", is_error: false },
    { type: "tool_use", id: "b", name: "Read", input: { file_path: "apps/desktop/src/store.ts" } },
    { type: "tool_result", tool_use_id: "b", output: "(418 lines)", is_error: false },
    { type: "assistant_text", text: "The draft lived in local component state, so it died with the component. I split this in two threads:\n\n- **Keep a draft per thread in the composer** moves drafts into the store, keyed by thread.\n- **Rail shows on hover at the left edge** fixes the hover zone, which was 2px wide on Windows." },
    { type: "turn_complete", duration_ms: 4100, cost_usd: 0.03 },
    { type: "status", status: "idle" },
    { type: "assistant_text", text: "The draft thread is done: `pnpm typecheck` passes and switching threads keeps what you typed. The rail thread is still working. Changes are on `cuna/3f9a2c1e`; open **Changes** to review them." },
  ],
  6,
);

seed(
  threads[1],
  [
    { type: "user_message", text: "Move the composer draft into the store, keyed by thread id.", author: "Desktop" },
    { type: "status", status: "working" },
    { type: "tool_use", id: "c", name: "Edit", input: { file_path: "apps/desktop/src/store.ts" } },
    { type: "tool_result", tool_use_id: "c", output: "ok", is_error: false },
    { type: "tool_use", id: "d", name: "Edit", input: { file_path: "apps/desktop/src/components/Composer.tsx" } },
    { type: "tool_result", tool_use_id: "d", output: "ok", is_error: false },
    { type: "tool_use", id: "e", name: "Bash", input: { command: "pnpm typecheck" } },
    { type: "tool_result", tool_use_id: "e", output: "> tsc -b --noEmit\n", is_error: false },
    { type: "assistant_text", text: "Drafts now live in `drafts: Record<threadId, string>` in the store. The composer reads and writes there, and clears it on send." },
    { type: "turn_complete", duration_ms: 41_000, cost_usd: 0.38 },
    { type: "status", status: "idle" },
  ],
  8,
);

seed(
  threads[7],
  [
    { type: "user_message", text: "Add magic link sign-in to the hub.", author: "Maya" },
    { type: "status", status: "working" },
    { type: "assistant_text", text: "Sending mail needs an SMTP provider. Which one should the hub use: Resend, Postmark, or plain SMTP settings in `compose.yml`?" },
    { type: "status", status: "blocked" },
  ],
  14,
);

seed(
  threads[2],
  [
    { type: "user_message", text: "The rail should slide in when the pointer touches the left edge, also on Windows with a 1px window border.", author: "Desktop" },
    { type: "status", status: "working" },
    { type: "tool_use", id: "r1", name: "Read", input: { file_path: "apps/desktop/src/components/Rail.tsx" } },
    { type: "tool_result", tool_use_id: "r1", output: "(96 lines)", is_error: false },
    { type: "tool_use", id: "r2", name: "Grep", input: { pattern: "rail-edge", path: "apps/desktop/src/styles" } },
    { type: "tool_result", tool_use_id: "r2", output: "app.css:118:.rail-edge {", is_error: false },
    { type: "assistant_text", text: "The hover zone is `width: 2px`, and on Windows the window border eats one of them. I'm widening it to 6px and keeping it out of the way of the sidebar's scrollbar." },
    { type: "tool_use", id: "r3", name: "Edit", input: { file_path: "apps/desktop/src/styles/app.css" } },
  ],
  1.2,
);

seed(
  threads[4],
  [
    { type: "user_message", text: "`codex` is installed through npm on Windows but detect says not found.", author: "Maya" },
    { type: "status", status: "working" },
    { type: "tool_use", id: "w1", name: "Bash", input: { command: "where.exe codex" } },
    { type: "tool_result", tool_use_id: "w1", output: "C:\\Users\\maya\\AppData\\Roaming\\npm\\codex.cmd", is_error: false },
  ],
  2.2,
);

const diff = `diff --git a/apps/desktop/src/components/Composer.tsx b/apps/desktop/src/components/Composer.tsx
index 4c1a9e2..8d0b7f1 100644
--- a/apps/desktop/src/components/Composer.tsx
+++ b/apps/desktop/src/components/Composer.tsx
@@ -38,11 +38,12 @@ export function Composer({ thread }: Props) {
   const t = useT();
   const send = useStore((s) => s.send);
-  const [draft, setDraft] = useState("");
+  const draft = useStore((s) => s.drafts[thread.id] ?? "");
+  const setDraft = useStore((s) => s.setDraft);
 
   function submit() {
     if (!draft.trim()) return;
     send(thread.id, draft);
-    setDraft("");
+    setDraft(thread.id, "");
   }
diff --git a/apps/desktop/src/store.ts b/apps/desktop/src/store.ts
index 91be3d0..a27c6e4 100644
--- a/apps/desktop/src/store.ts
+++ b/apps/desktop/src/store.ts
@@ -21,6 +21,8 @@ interface State {
   threads: Thread[];
   events: Record<string, ThreadEnvelope[]>;
+  drafts: Record<string, string>;
+  setDraft(threadId: string, text: string): void;
   openTabs: string[];
 }
`;


// ---- more sample data: work, studio, people ------------------------------------------

const maya: HubUser = { id: uid(), name: "Maya", email: "maya@cuna.io", avatar_url: null };
const jordan: HubUser = { id: uid(), name: "Jordan", email: "jordan@cuna.io", avatar_url: null };
const olivia: HubUser = { id: uid(), name: "Olivia", email: "olivia@cuna.io", avatar_url: null };

const issue = (n: number, title: string, status: Issue["status"], lead: Lead | null, min: number, body = ""): Issue => ({
  id: uid(),
  workspace_id: B,
  number: n,
  key: `BOU-${n}`,
  title,
  body,
  status,
  assignee: null,
  lead_id: lead?.id ?? null,
  thread_ids: [],
  github_number: n < 30 ? n + 100 : null,
  created_at: ago(min + 600),
  updated_at: ago(min),
});
const issues: Issue[] = [
  issue(34, "Composer loses the draft when switching threads", "done", desktop, 4),
  issue(35, "Rail does not show on Windows with a 1px border", "in_progress", desktop, 1),
  issue(36, "Detect Codex installed through npm on Windows", "in_progress", runner, 2),
  issue(37, "Magic link sign-in for the hub", "in_progress", hub, 12, "Send a 6-digit code by mail; log it when SMTP is not set."),
  issue(38, "Diff colours are too bright in the dark theme", "todo", design, 90),
  issue(39, "Keyboard shortcut to jump to the next thread that needs you", "todo", desktop, 300),
  issue(40, "Show cost per lead in the sidebar", "backlog", null, 900),
  issue(41, "Live frames sleep when they are off screen", "backlog", design, 1400),
  issue(29, "Resume Claude sessions after a restart", "done", runner, 55),
];

const prs: PullRequest[] = [
  { number: 142, title: "fix(desktop): keep a draft per thread", url: "https://github.com/timvanderwijst/bouvio/pull/142", head: "cuna/3f9a2c1e", base: "main", state: "open", draft: false, author: "maya", additions: 17, deletions: 35, updated_at: ago(3) },
  { number: 141, title: "feat(runner): resume Claude sessions after restart", url: "https://github.com/timvanderwijst/bouvio/pull/141", head: "cuna/9e1c0a77", base: "main", state: "merged", draft: false, author: "maya", additions: 88, deletions: 12, updated_at: ago(50) },
  { number: 140, title: "feat(hub): invites with roles", url: "https://github.com/timvanderwijst/bouvio/pull/140", head: "cuna/1a2b3c4d", base: "main", state: "open", draft: true, author: "jordan", additions: 214, deletions: 9, updated_at: ago(130) },
];

const automations: Automation[] = [
  { id: uid(), workspace_id: B, name: "Morning triage", schedule: "0 8 * * 1-5", prompt: "Read the new issues and GitHub notifications. File what is missing, close duplicates, and post a short summary.", lead_id: leads[4].id, enabled: true, last_run: ago(600), last_thread: null },
  { id: uid(), workspace_id: B, name: "Dependency check", schedule: "30 7 * * 1", prompt: "Run pnpm outdated and cargo outdated. Open one thread per major upgrade worth doing.", lead_id: runner.id, enabled: true, last_run: ago(4000), last_thread: null },
  { id: uid(), workspace_id: B, name: "Release notes", schedule: "0 16 * * 5", prompt: "Write release notes from the PRs merged this week.", lead_id: null, enabled: false, last_run: null, last_thread: null },
];

const svgArt = (bg: string, fg: string, label: string) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="800" height="560"><rect width="800" height="560" fill="${bg}"/><circle cx="560" cy="250" r="150" fill="${fg}" opacity=".85"/><rect x="120" y="170" width="260" height="220" rx="28" fill="${fg}" opacity=".45"/><text x="120" y="470" font-family="Inter,Arial" font-size="34" font-weight="600" fill="${fg}">${label}</text></svg>`)}`;
const art = (title: string, kind: Artifact["kind"], min: number, extra: Partial<Artifact> = {}): Artifact => ({
  id: uid(),
  workspace_id: B,
  thread_id: firstThread.id,
  kind,
  title,
  path: `~/code/cuna/${title}`,
  size: 48_000,
  created_at: ago(min),
  prompt: null,
  model: null,
  ...extra,
});
const artifacts: Artifact[] = [
  art("onboarding-hero.png", "image", 20, { prompt: "A calm workspace at dawn, soft light, paper textures", model: "fal:fal-ai/flux/schnell" }),
  art("pricing.html", "html", 45),
  art("rail-states.svg", "svg", 70),
  art("lead-avatars.png", "image", 120, { prompt: "Sixteen tiny pixel characters in warm colours", model: "openai:gpt-image-1" }),
  art("release-notes.md", "markdown", 200),
  art("standup.mp3", "audio", 300, { prompt: "Read this week's release notes", model: "elevenlabs:Rachel" }),
];
const artPreview: Record<string, string> = {
  "onboarding-hero.png": svgArt("#F3EEE6", "#C2653A", "Onboarding"),
  "rail-states.svg": svgArt("#E3ECF7", "#3F6FB5", "Rail states"),
  "lead-avatars.png": svgArt("#E6F2E4", "#3E8E5A", "Leads"),
};

const now = new Date().toISOString();
const boards: Board[] = [
  { id: uid(), workspace_id: B, name: "Dashboard v2", created_at: ago(3000), updated_at: ago(8), doc: { items: [] } },
  { id: uid(), workspace_id: B, name: "Onboarding flow", created_at: ago(9000), updated_at: ago(400), doc: { items: [] } },
];

const settings: Record<string, WorkspaceSettings> = {
  [B]: {
    instructions: "TypeScript and Rust. Run `pnpm typecheck` and `cargo test` before you say something is done. Keep UI copy short.",
    memory: "- The hub never calls a model; keys stay on runners.\n- One easing for all motion: cubic-bezier(.22,1,.36,1).\n",
    mcp_servers: [{ name: "linear", command: "npx", args: ["-y", "@linear/mcp"], env: [] }],
    dev_command: "pnpm dev --port {port}",
    issue_prefix: "BOU",
    github_repo: "cuna/cuna",
  },
};

const members: Member[] = [
  { user: maya, role: "admin", see_costs: true, online: true },
  { user: jordan, role: "operator", see_costs: false, online: true },
  { user: olivia, role: "viewer", see_costs: false, online: false },
];

const chat: ChatMessage[] = [
  { id: uid(), workspace_id: B, channel: "general", author: jordan, text: "The rail thread is close. Can someone check it on a small laptop screen?", at: ago(42), parent: null, reactions: [], pinned: false },
  { id: uid(), workspace_id: B, channel: "general", author: maya, text: "On it. Also merged the draft fix.", at: ago(38), parent: null, reactions: [], pinned: false },
  { id: uid(), workspace_id: B, channel: "general", author: olivia, text: "Hub magic links are waiting on an SMTP choice — Resend?", at: ago(11), parent: null, reactions: [], pinned: false },
];

const files: Record<string, { name: string; dir: boolean; size: number }[]> = {
  "": [
    { name: "apps", dir: true, size: 0 },
    { name: "crates", dir: true, size: 0 },
    { name: "Cargo.toml", dir: false, size: 512 },
    { name: "LICENSE", dir: false, size: 1070 },
    { name: "README.md", dir: false, size: 2140 },
    { name: "package.json", dir: false, size: 380 },
  ],
  apps: [
    { name: "desktop", dir: true, size: 0 },
    { name: "hub", dir: true, size: 0 },
    { name: "runner-cli", dir: true, size: 0 },
  ],
  crates: [
    { name: "agent", dir: true, size: 0 },
    { name: "protocol", dir: true, size: 0 },
    { name: "runner", dir: true, size: 0 },
  ],
};

// ---- the fake runner ---------------------------------------------------------------------------

type Cb = (p: unknown) => void;
const fire = mockFire;

function push(threadId: string, event: ThreadEvent) {
  const list = events.get(threadId) ?? [];
  const env: ThreadEnvelope = { thread_id: threadId, seq: list.length, at: new Date().toISOString(), event };
  list.push(env);
  events.set(threadId, list);
  const t = threads.find((x) => x.id === threadId)!;
  t.updated_at = env.at;
  if (event.type === "status") t.status = event.status;
  if (event.type === "turn_complete" && event.cost_usd) t.cost_usd += event.cost_usd;
  fire("thread-event", env);
  fire("thread-changed", { ...t });
}
const notice = (workspace_id: string, kind: string, payload: unknown) => fire("workspace-notice", { workspace_id, kind, payload });

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const terms = new Map<string, string>();
const pending = new Map<string, (ok: boolean) => void>();

async function reply(id: string, text: string) {
  const t = threads.find((x) => x.id === id)!;
  if (t.title === "New thread") t.title = text.split("\n")[0].slice(0, 60);
  push(id, { type: "status", status: "working" });
  const started = Date.now();
  await wait(700);
  push(id, { type: "tool_use", id: "m1", name: "Read", input: { file_path: "README.md" } });
  await wait(400);
  push(id, { type: "tool_result", tool_use_id: "m1", output: "# Cuna", is_error: false });
  await wait(400);
  if (/test|run|install|build/i.test(text)) {
    push(id, { type: "approval_request", id: "a1", tool: "Bash", input: { command: "pnpm test" } });
    push(id, { type: "status", status: "blocked" });
    const ok = await new Promise<boolean>((r) => pending.set("a1", r));
    push(id, { type: "approval_resolved", id: "a1", allowed: ok, by: "Maya" });
    push(id, { type: "status", status: "working" });
    await wait(500);
  }
  push(id, {
    type: "assistant_text",
    text: "This is the browser preview, so no agent ran. In the desktop app this goes to **Claude Code**, **Codex** or a model from your keys, on your runner.",
  });
  push(id, { type: "turn_complete", duration_ms: Date.now() - started, cost_usd: 0 });
  push(id, { type: "status", status: "idle" });
}

function readPreview(title: string, kind: Artifact["kind"]) {
  if (artPreview[title]) return { mime: "image/svg+xml", data_url: artPreview[title] };
  if (kind === "html")
    return {
      mime: "text/html",
      text: `<!doctype html><html><body style="font-family:Inter,system-ui;margin:0;padding:48px;background:#fafaf9;color:#1b1b1a"><h1 style="font-size:40px;letter-spacing:-.02em;margin:0 0 8px">Cuna is free</h1><p style="color:#77776f;margin:0 0 32px">Bring your own keys and machines.</p><div style="display:flex;gap:16px">${["Personal", "Team", "Self-hosted"]
        .map((n) => `<div style="flex:1;padding:24px;border-radius:14px;background:#fff;box-shadow:0 0 0 1px #0001"><b>${n}</b><p style="color:#77776f">€0</p></div>`)
        .join("")}</div></body></html>`,
    };
  if (kind === "markdown") return { mime: "text/markdown", text: "# Release notes\n\n- Drafts survive switching threads\n- Claude sessions resume after a restart\n- Invites with roles on the hub\n" };
  return { mime: "text/plain", text: "(preview)" };
}

const handlers: Record<string, (p: Record<string, any>) => unknown> = {
  detect_harnesses: () => [
    { kind: "claude_code", available: true, version: "2.1.329 (Claude Code)", path: "/usr/local/bin/claude" },
    { kind: "codex", available: true, version: "codex-cli 0.98.0", path: "/usr/local/bin/codex" },
    { kind: "open_code", available: false, version: null, path: null },
    { kind: "gemini_cli", available: false, version: null, path: null },
    { kind: "api", available: true, version: null, path: null },
  ],
  list_workspaces: () => [...ws],
  create_workspace: ({ name, root }) => {
    const w: Workspace = { id: uid(), name, kind: "personal", root: root ?? null, created_at: now, role: null, host: null };
    ws.push(w);
    return w;
  },
  list_leads: ({ workspace_id }) => leads.filter((c) => c.workspace_id === workspace_id),
  create_lead: ({ lead }) => {
    const c: Lead = { ...lead, id: uid(), avatar_seed: Math.floor(Math.random() * 1e6) };
    leads.push(c);
    return c;
  },
  list_threads: ({ workspace_id }) => threads.filter((t) => t.workspace_id === workspace_id).map((t) => ({ ...t })),
  create_thread: ({ thread: n }) => {
    const w = ws.find((x) => x.id === n.workspace_id)!;
    const t = thread(null, n.title ?? "New thread", "idle", 0, {
      workspace_id: n.workspace_id,
      lead_id: n.lead_id,
      harness: n.harness,
      model: n.model,
      effort: n.effort,
      approval: n.approval,
      cwd: w.root,
      branch: w.root ? (n.isolate ? `cuna/${uid().slice(0, 8)}` : "main") : null,
      created_at: now,
    });
    threads.push(t);
    fire("thread-changed", { ...t });
    return { ...t };
  },
  thread_events: ({ thread_id }) => [...(events.get(thread_id) ?? [])],
  send_message: ({ thread_id, text, author }) => {
    push(thread_id, { type: "user_message", text, author: author ?? "Maya" });
    reply(thread_id, text);
    return null;
  },
  stop_thread: ({ thread_id }) => push(thread_id, { type: "status", status: "idle" }),
  thread_diff: ({ thread_id }) => (threads.find((x) => x.id === thread_id)?.cwd ? diff : ""),
  resolve_approval: ({ id, allowed }) => {
    pending.get(id)?.(allowed);
    pending.delete(id);
    return null;
  },
  open_terminal: () => {
    const id = uid();
    terms.set(id, "");
    setTimeout(() => fire("terminal-chunk", { terminal_id: id, data: "\x1b[2m~/code/cuna\x1b[0m on \x1b[35mmain\x1b[0m\r\n❯ " }), 50);
    return id;
  },
  write_terminal: ({ id, data }) => {
    const out = (s: string) => fire("terminal-chunk", { terminal_id: id, data: s });
    for (const ch of data as string) {
      if (ch === "\r") {
        const line = terms.get(id) ?? "";
        terms.set(id, "");
        out(`\r\n${line ? "preview: no runner attached\r\n" : ""}❯ `);
      } else if (ch === "\x7f") {
        const line = terms.get(id) ?? "";
        if (line) (terms.set(id, line.slice(0, -1)), out("\b \b"));
      } else (terms.set(id, (terms.get(id) ?? "") + ch), out(ch));
    }
    return null;
  },
  resize_terminal: () => null,
  close_terminal: ({ id }) => terms.delete(id),

  workspace_settings: ({ workspace_id }) =>
    settings[workspace_id] ?? { instructions: "", memory: "", mcp_servers: [], dev_command: null, issue_prefix: "ISS", github_repo: null },
  workspace_settings_set: ({ workspace_id, settings: s }) => {
    settings[workspace_id] = s;
    notice(workspace_id, "settings-changed", s);
    return null;
  },

  list_issues: ({ workspace_id }) => issues.filter((i) => i.workspace_id === workspace_id).sort((a, b) => b.number - a.number),
  create_issue: ({ workspace_id, title, body, status, lead_id }) => {
    const n = Math.max(0, ...issues.map((i) => i.number)) + 1;
    const i: Issue = { ...issue(n, title, status ?? "todo", null, 0, body ?? ""), workspace_id, lead_id: lead_id ?? null, github_number: null };
    issues.push(i);
    notice(workspace_id, "issue-changed", i);
    return i;
  },
  update_issue: ({ issue: i }) => {
    const k = issues.findIndex((x) => x.id === i.id);
    issues[k] = { ...i, updated_at: new Date().toISOString() };
    notice(i.workspace_id, "issue-changed", issues[k]);
    return issues[k];
  },
  delete_issue: ({ id }) => {
    const k = issues.findIndex((x) => x.id === id);
    const [i] = issues.splice(k, 1);
    notice(i.workspace_id, "issue-deleted", { id });
    return null;
  },
  start_issue: async ({ id }) => {
    const i = issues.find((x) => x.id === id)!;
    const t = handlers.create_thread({ thread: { workspace_id: i.workspace_id, lead_id: i.lead_id, title: `${i.key} ${i.title}`, harness: "claude_code", model: null, effort: "medium", approval: "ask_risky", isolate: true } }) as Thread;
    i.thread_ids.push(t.id);
    i.status = "in_progress";
    notice(i.workspace_id, "issue-changed", i);
    handlers.send_message({ thread_id: t.id, text: `Work on ${i.key}: ${i.title}\n\n${i.body}`, author: "Maya" });
    return t;
  },
  sync_github_issues: () => 0,

  list_pull_requests: () => prs,
  create_pull_request: () => "https://github.com/timvanderwijst/bouvio/pull/143",
  merge_pull_request: ({ number }) => {
    const pr = prs.find((x) => x.number === number);
    if (pr) pr.state = "merged";
    return null;
  },
  commit_thread: () => "a1b2c3d",

  list_automations: ({ workspace_id }) => automations.filter((a) => a.workspace_id === workspace_id),
  create_automation: ({ automation: a }) => {
    const x = { ...a, id: a.id && a.id !== "00000000-0000-0000-0000-000000000000" ? a.id : uid() };
    const k = automations.findIndex((y) => y.id === x.id);
    if (k >= 0) automations[k] = x;
    else automations.push(x);
    notice(x.workspace_id, "automation-changed", x);
    return x;
  },
  delete_automation: ({ id }) => {
    const k = automations.findIndex((x) => x.id === id);
    const [a] = automations.splice(k, 1);
    notice(a.workspace_id, "automation-deleted", { id });
    return null;
  },
  run_automation: ({ id }) => {
    const a = automations.find((x) => x.id === id)!;
    const t = handlers.create_thread({ thread: { workspace_id: a.workspace_id, lead_id: a.lead_id, title: a.name, harness: "claude_code", model: null, effort: "medium", approval: "ask_risky", isolate: false } }) as Thread;
    a.last_run = new Date().toISOString();
    handlers.send_message({ thread_id: t.id, text: a.prompt, author: a.name });
    return t;
  },

  list_artifacts: ({ workspace_id }) => artifacts.filter((a) => a.workspace_id === workspace_id),
  read_artifact: ({ id }) => {
    const a = artifacts.find((x) => x.id === id)!;
    return readPreview(a.title, a.kind);
  },
  list_files: ({ dir }) => (files[dir ?? ""] ?? []).map((f) => ({ ...f, path: dir ? `${dir}/${f.name}` : f.name })),
  read_file: ({ path }) => ({ mime: "text/plain", text: path === "README.md" ? "# Cuna\n\nA desktop workspace where people and agent fleets work together.\n" : `// ${path}\n` }),

  list_boards: ({ workspace_id }) => boards.filter((b) => b.workspace_id === workspace_id).map((b) => ({ ...b, doc: null })),
  create_board: ({ workspace_id, name }) => {
    const b: Board = { id: uid(), workspace_id, name, created_at: now, updated_at: now, doc: { items: [] } };
    boards.unshift(b);
    return b;
  },
  get_board: ({ id }) => boards.find((b) => b.id === id),
  update_board: ({ id, doc }) => {
    const b = boards.find((x) => x.id === id)!;
    b.doc = doc;
    b.updated_at = new Date().toISOString();
    return null;
  },
  rename_board: ({ id, name }) => {
    boards.find((x) => x.id === id)!.name = name;
    return null;
  },
  delete_board: ({ id }) => {
    boards.splice(boards.findIndex((x) => x.id === id), 1);
    return null;
  },
  dev_servers: () => [],
  start_dev_server: ({ thread_id }) => ({ thread_id, url: "about:blank", port: 0, running: true }),
  stop_dev_server: () => null,
};

Object.assign(handlers, ...EXT.map((x) => x.handlers));
const appHandlers: Record<string, (p: Record<string, any>) => unknown> = Object.assign({}, ...EXT.map((x) => x.app));

export const mockBackend: Backend = {
  live: false,
  async rpc(_ws, method, params = {}) {
    const h = handlers[method];
    if (!h) throw new Error(`preview: ${method} is not available`);
    await wait(30);
    return (await h(params)) as never;
  },
  async app(method, params = {}) {
    const h = appHandlers[method];
    if (!h) throw new Error(`preview: ${method} needs the desktop app`);
    return (await h(params)) as never;
  },
  on(event, cb) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event)!.add(cb as Cb);
    return () => listeners.get(event)!.delete(cb as Cb);
  },
  async pickFolder() {
    return window.prompt("Folder path") || null;
  },
  async openUrl(url) {
    window.open(url, "_blank");
  },
  async providers() {
    return [
      { kind: "open_router", configured: true },
      { kind: "anthropic", configured: false },
      { kind: "open_ai", configured: true },
      { kind: "google", configured: false },
      { kind: "fal", configured: true },
      { kind: "replicate", configured: false },
      { kind: "eleven_labs", configured: false },
      { kind: "local", configured: false },
    ];
  },
  async setKey() {},
  async listModels() {
    return [
      { id: "openrouter:anthropic/claude-sonnet-4.5", name: "Claude Sonnet 4.5", provider: "open_router", context: 200000, price_in: 3, price_out: 15 },
      { id: "openrouter:openai/gpt-5", name: "GPT-5", provider: "open_router", context: 400000, price_in: 1.25, price_out: 10 },
      { id: "openrouter:google/gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "open_router", context: 1000000, price_in: 1.25, price_out: 10 },
      { id: "openrouter:moonshotai/kimi-k2", name: "Kimi K2", provider: "open_router", context: 128000, price_in: 0.6, price_out: 2.5 },
      { id: "openai:gpt-4.1", name: "GPT-4.1", provider: "open_ai", context: 1000000, price_in: 2, price_out: 8 },
    ];
  },
  async generateMedia({ workspaceId, kind, model, prompt }) {
    await wait(1500);
    const a = art(`${prompt.slice(0, 24).replace(/\W+/g, "-").toLowerCase()}.png`, kind === "speech" ? "audio" : kind === "video" ? "video" : "image", 0, { workspace_id: workspaceId, prompt, model });
    artPreview[a.title] = svgArt("#F4E4EE", "#B24C86", prompt.slice(0, 18));
    artifacts.unshift(a);
    return a;
  },
  async transcribe() {
    return "Transcription needs an OpenAI key in the desktop app.";
  },
  hub: {
    async status() {
      return { url: "https://hub.cuna.io", user: maya, connected: true };
    },
    async setUrl() {},
    async request(method: string, path: string) {
      if (path.endsWith("/members")) return members as never;
      if (path.includes("/chat")) return chat.filter((m) => path.includes(m.channel)) as never;
      if (path.endsWith("/invites") && method === "POST") return { code: "K7Q2MX9A", url: "https://hub.cuna.io/invite/K7Q2MX9A" } as never;
      return null as never;
    },
    async signIn() {
      return maya;
    },
    async logout() {},
    async refresh() {
      return [];
    },
    async share(workspaceId) {
      const w = ws.find((x) => x.id === workspaceId)!;
      w.kind = "shared";
      return w;
    },
    async join() {
      return [];
    },
    async send(msg) {
      if (msg.t === "chat") {
        const m: ChatMessage = { id: uid(), workspace_id: msg.workspace_id, channel: msg.channel, author: maya, text: msg.text, at: new Date().toISOString(), parent: null, reactions: [], pinned: false };
        chat.push(m);
        fire("hub-chat", m);
      }
    },
  },
};

// Some life in the preview: Jordan looks at a thread and types in #general.
setTimeout(() => fire("hub-presence", { presence: { workspace_id: B, user: jordan, viewing: firstThread.id, cursor: null }, online: true }), 800);
