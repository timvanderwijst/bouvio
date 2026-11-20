// Browser-preview stand-ins for this area's runner methods (`handlers`) and
// desktop-only app methods (`app`). See ../mock-bus.ts to fire live events.
import type { Brief } from "../../protocol/Brief";
import type { BriefItem } from "../../protocol/BriefItem";
import type { BudgetStatus } from "../../protocol/BudgetStatus";
import type { CostSummary } from "../../protocol/CostSummary";
import type { EvalRun } from "../../protocol/EvalRun";
import type { EvalSuite } from "../../protocol/EvalSuite";
import type { PersonalNote } from "../../protocol/PersonalNote";
import type { PersonalTask } from "../../protocol/PersonalTask";
import type { Replay } from "../../protocol/Replay";
import type { ReplayKind } from "../../protocol/ReplayKind";
import type { ReplayStep } from "../../protocol/ReplayStep";
import type { Thread } from "../../protocol/Thread";
import type { ThreadEnvelope } from "../../protocol/ThreadEnvelope";
import { mockFire } from "../mock-bus";

const uid = () => crypto.randomUUID();
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const day = (n: number) => iso(new Date(Date.now() + n * 86_400_000));
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

// The sample runner's threads live in the store; read them when called, not at import (mock.ts imports this file).
const state = async () => (await import("../../store")).useStore.getState();
const allThreads = async () => Object.values((await state()).threads).flat() as Thread[];
const notice = (workspace_id: string, kind: string, payload: unknown) => mockFire("workspace-notice", { workspace_id, kind, payload });

// ---- tasks & notes ----------------------------------------------------------------

const task = (title: string, due: string | null, extra: Partial<PersonalTask> = {}, i = 0): PersonalTask => ({
  id: uid(),
  title,
  notes: null,
  done: false,
  due,
  priority: "none",
  workspace_id: null,
  thread_id: null,
  created_at: ago(3000 - i * 60),
  done_at: null,
  sort: i + 1,
  ...extra,
});

let tasks: PersonalTask[] = [
  task("Answer Isa about the hub invite flow", day(-1), { priority: "high" }, 0),
  task("Review the magic link thread", day(0), { priority: "medium" }, 1),
  task("Renew bouvio.com domain", day(0), { notes: "Registrar sends the invoice to the old address." }, 2),
  task("Draft release notes for 0.2", day(2), {}, 3),
  task("Try Kimi K2 on the runner captain", day(5), { priority: "low" }, 4),
  task("Call the accountant", day(9), {}, 5),
  task("Read the Herdr pane docs", null, {}, 6),
  task("Sketch the evals page", null, {}, 7),
  task("Set a budget for the Design captain", day(-2), { done: true, done_at: ago(300) }, 8),
  task("Ship the rail hover fix", day(-1), { done: true, done_at: ago(1500) }, 9),
];

const pushTasks = () => notice("00000000-0000-0000-0000-000000000000", "personal-tasks", tasks);

const notes = new Map<string, PersonalNote>([
  [
    "a1b2c3d4e5f6",
    {
      id: "a1b2c3d4e5f6",
      title: "Release 0.2",
      updated_at: ago(40),
      text: "# Release 0.2\n\n- Drafts survive switching threads\n- Claude sessions resume after a restart\n- Invites with roles on the hub\n\nStill open: **Windows PATH** for Codex.",
    },
  ],
  [
    "0f9e8d7c6b5a",
    {
      id: "0f9e8d7c6b5a",
      title: "Captain prompts that work",
      updated_at: ago(1440 * 2),
      text: "# Captain prompts that work\n\nKeep each captain to one folder. Ask for a plan first, then threads per step.\n\n`spawn_thread` with `isolate: true` for anything that touches more than two files.",
    },
  ],
  ["99aa88bb77cc", { id: "99aa88bb77cc", title: "Groceries", updated_at: ago(1440 * 6), text: "# Groceries\n\n- coffee\n- oat milk\n- bread" }],
]);
const noteMeta = (n: PersonalNote) => ({
  id: n.id,
  title: n.title,
  excerpt: (n.text.split("\n").map((l) => l.trim()).filter(Boolean)[1] ?? "").replace(/^[#\-*> ]+/, ""),
  updated_at: n.updated_at,
});
const noteTitle = (text: string) => text.split("\n").map((l) => l.trim()).find(Boolean)?.replace(/^#+\s*/, "") || "Untitled";

// ---- costs ----------------------------------------------------------------------------

// A deterministic week-ish pattern: busier mid-week, quiet weekends.
const dayCost = (n: number) => {
  const d = new Date(Date.now() - n * 86_400_000);
  const weekend = d.getDay() === 0 || d.getDay() === 6;
  const wave = 0.6 + 0.4 * Math.sin(n * 1.7) ** 2;
  return Math.round((weekend ? 0.35 : 2.4) * wave * 100) / 100;
};

const budgets: BudgetStatus[] = [];

async function costSummary(workspaceId: string | null, days: number): Promise<CostSummary> {
  const st = await state();
  const per_day = Array.from({ length: days }, (_, i) => {
    const n = days - 1 - i;
    const cost_usd = dayCost(n);
    return { date: day(-n), cost_usd, turns: cost_usd ? Math.round(cost_usd * 9) : 0 };
  });
  const total = per_day.reduce((a, d) => a + d.cost_usd, 0);
  const turns = per_day.reduce((a, d) => a + d.turns, 0);
  const caps = workspaceId ? st.captains[workspaceId] ?? [] : Object.values(st.captains).flat();
  const shares = [0.38, 0.27, 0.16, 0.11, 0.05];
  const per_captain = [
    ...caps.slice(0, 5).map((c, i) => ({ key: c.id, label: c.name, cost_usd: total * shares[i], turns: Math.round(turns * shares[i]) })),
    { key: "", label: "", cost_usd: total * 0.03, turns: Math.round(turns * 0.03) },
  ];
  const ths = (workspaceId ? st.threads[workspaceId] ?? [] : Object.values(st.threads).flat()).slice(0, 6);
  return {
    workspace_id: workspaceId,
    days,
    since: new Date(Date.now() - days * 86_400_000).toISOString(),
    total_usd: total,
    turns,
    unknown_turns: Math.round(turns * 0.12),
    per_day,
    per_captain,
    per_model: [
      { key: "claude_code:opus", label: "Claude Code · opus", cost_usd: total * 0.58, turns: Math.round(turns * 0.4) },
      { key: "claude_code:", label: "Claude Code", cost_usd: total * 0.24, turns: Math.round(turns * 0.35) },
      { key: "api:openrouter:moonshotai/kimi-k2", label: "API · openrouter:moonshotai/kimi-k2", cost_usd: total * 0.12, turns: Math.round(turns * 0.15) },
      { key: "codex:", label: "Codex", cost_usd: total * 0.06, turns: Math.round(turns * 0.1) },
    ],
    per_person: [
      { key: "Tim", label: "Tim", cost_usd: total * 0.52, turns: Math.round(turns * 0.45) },
      { key: "Desktop", label: "Desktop", cost_usd: total * 0.29, turns: Math.round(turns * 0.33) },
      { key: "Isa", label: "Isa", cost_usd: total * 0.19, turns: Math.round(turns * 0.22) },
    ],
    top_threads: ths.map((t, i) => ({ thread_id: t.id, workspace_id: t.workspace_id, title: t.title, cost_usd: total * [0.18, 0.12, 0.09, 0.07, 0.05, 0.03][i], turns: [21, 14, 11, 8, 6, 3][i] })),
    budgets: budgets.filter((b) => !workspaceId || b.budget.workspace_id === workspaceId),
  };
}

// ---- brief ------------------------------------------------------------------------------

let briefCache: Brief | null = null;

async function brief(regenerate: boolean): Promise<Brief> {
  if (briefCache && !regenerate) return briefCache;
  await new Promise((r) => setTimeout(r, 900));
  const st = await state();
  const threads = await allThreads();
  const ws = (id: string) => st.workspaces.find((w) => w.id === id)?.name ?? null;
  const item = (kind: BriefItem["kind"], t: Thread): BriefItem => ({ kind, id: t.id, workspace_id: t.workspace_id, workspace: ws(t.workspace_id), title: t.title, detail: null, thread_id: t.id, at: t.updated_at });
  const items: BriefItem[] = [
    ...threads.filter((t) => t.status === "blocked").map((t) => item("waiting", t)),
    ...threads.filter((t) => t.status === "error").map((t) => item("failed", t)),
    ...threads.filter((t) => t.status === "idle" && t.cost_usd > 0).slice(0, 3).map((t) => item("finished", t)),
    ...tasks
      .filter((t) => !t.done && t.due && t.due <= day(0))
      .map((t): BriefItem => ({ kind: "task", id: t.id, workspace_id: null, workspace: null, title: t.title, detail: t.due! < day(0) ? "overdue" : null, thread_id: null, at: null })),
  ];
  const name = (k: BriefItem["kind"]) => items.find((i) => i.kind === k)?.title ?? "";
  briefCache = {
    date: day(0),
    ai: true,
    generated_at: new Date().toISOString(),
    items,
    markdown: [
      `- **${name("waiting")}** waits on your approval to send the sign-in email; nothing else is blocked.`,
      `- **${name("failed")}** failed overnight on a missing token in the dark theme; worth a look before it drifts.`,
      `- Three threads finished, including **${name("finished")}**; all changes sit on their branches, none merged yet.`,
      "- BOU-14 moved to in progress; BOU-9 is done.",
      "- The nightly dependency check ran at 03:00 and found nothing new.",
      `- Due today: **${tasks.find((t) => t.due === day(0))?.title ?? "nothing"}**, plus one overdue task.`,
    ].join("\n"),
  };
  return briefCache;
}

// ---- replay --------------------------------------------------------------------------

function kindOf(e: ThreadEnvelope["event"]): ReplayKind {
  switch (e.type) {
    case "user_message":
      return "message";
    case "assistant_text":
      return "reply";
    case "tool_use":
    case "tool_result":
      return "tool";
    case "approval_request":
    case "approval_resolved":
      return "approval";
    case "error":
      return "error";
    case "turn_complete":
      return "turn";
    default:
      return "other";
  }
}

async function replay(threadId: string): Promise<Replay> {
  const { backend } = await import("../index");
  const events = await backend.rpc<ThreadEnvelope[]>(null, "thread_events", { thread_id: threadId });
  const t = (await allThreads()).find((x) => x.id === threadId);
  // The sample log is squeezed into seconds; stretch it so the replay has a shape.
  const t0 = events.length ? new Date(events[0].at).getTime() : Date.now();
  const stretch = [0, 400, 2600, 9100, 9800, 16200, 21400, 38900, 41000, 41200, 44000, 47000, 52000, 56000];
  const at = (i: number) => t0 + (stretch[i] ?? 52000 + i * 3000);
  const steps: ReplayStep[] = [];
  const open = new Map<string, number>();
  let cost = 0;
  let last = 0;
  events.forEach((e, i) => {
    const ms = at(i) - t0;
    if (e.event.type === "status") return;
    if (e.event.type === "tool_result" && open.has(e.event.tool_use_id)) {
      const s = steps[open.get(e.event.tool_use_id)!];
      s.output = e.event.output;
      s.is_error = e.event.is_error;
      s.duration_ms = ms - s.offset_ms;
      return;
    }
    if (e.event.type === "turn_complete") cost += e.event.cost_usd ?? 0;
    const ev = e.event;
    const label =
      ev.type === "user_message"
        ? `${ev.author}: ${ev.text.split("\n")[0].slice(0, 60)}`
        : ev.type === "assistant_text"
          ? ev.text.split("\n")[0].slice(0, 60)
          : ev.type === "tool_use"
            ? `${ev.name} ${String((ev.input as Record<string, unknown>).file_path ?? (ev.input as Record<string, unknown>).command ?? (ev.input as Record<string, unknown>).pattern ?? "")}`
            : ev.type === "turn_complete"
              ? `Turn done in ${(ev.duration_ms / 1000).toFixed(1)}s`
              : ev.type === "error"
                ? ev.message
                : ev.type;
    if (ev.type === "tool_use") open.set(ev.id, steps.length);
    steps.push({ seq: e.seq, at: new Date(at(i)).toISOString(), offset_ms: ms, gap_ms: ms - last, duration_ms: null, kind: kindOf(ev), label, event: ev, output: null, is_error: ev.type === "error", cost_so_far: cost });
    last = ms;
  });
  return { thread_id: threadId, title: t?.title ?? "", started_at: events[0]?.at ?? null, total_ms: last, total_cost: cost, steps };
}

// ---- evals ------------------------------------------------------------------------------

let suites: EvalSuite[] | null = null;
let runs: EvalRun[] = [];

async function seedEvals(workspaceId: string) {
  if (suites) return;
  suites = [
    {
      id: uid(),
      workspace_id: workspaceId,
      name: "Runner basics",
      updated_at: ago(600),
      cases: [
        { prompt: "Which port does the dev server use? Answer with the number only.", check: "contains", expected: "1420" },
        { prompt: "Add a unit test for title_from that covers an empty string.", check: "command_exit_zero", expected: "cargo test -q -p bouvio-runner title_from" },
        { prompt: "Explain what an isolated thread is in two sentences.", check: "judge", expected: "Mentions its own git worktree and branch; no more than two sentences." },
        { prompt: "List the harnesses Bouvio supports.", check: "regex", expected: "(?i)claude code.*codex" },
      ],
    },
  ];
  const threads = (await allThreads()).filter((t) => t.workspace_id === workspaceId);
  const s = suites[0];
  const targets = [
    { harness: "claude_code" as const, model: "opus" },
    { harness: "claude_code" as const, model: "sonnet" },
    { harness: "codex" as const, model: null },
  ];
  const outcome: [EvalRun["results"][number]["status"], number, number | null, string][] = [
    ["passed", 8200, 0.04, "Contains “1420”."],
    ["passed", 6100, 0.02, "Contains “1420”."],
    ["passed", 9800, null, "Contains “1420”."],
    ["passed", 94000, 0.61, "Exited 0."],
    ["failed", 71000, 0.33, "Exited with 101.\nerror[E0425]: cannot find function `title_from`"],
    ["passed", 120000, null, "Exited 0."],
    ["passed", 12000, 0.05, "Names the worktree and the branch in two sentences."],
    ["passed", 9000, 0.02, "Names the worktree and the branch."],
    ["failed", 15000, null, "Three sentences, and the branch is not mentioned."],
    ["passed", 7000, 0.03, "Matched “Claude Code, Codex”."],
    ["passed", 5000, 0.01, "Matched “Claude Code (stream-json), Codex”."],
    ["error", 1800000, null, "timed out after 30 minutes"],
  ];
  runs = [
    {
      id: uid(),
      suite_id: s.id,
      workspace_id: workspaceId,
      suite_name: s.name,
      cases: s.cases,
      targets,
      started_at: ago(180),
      finished_at: ago(150),
      results: outcome.map(([status, duration_ms, cost_usd, reason], i) => ({
        case_index: Math.floor(i / 3),
        target_index: i % 3,
        thread_id: threads[i % threads.length]?.id ?? null,
        status,
        reason,
        duration_ms,
        cost_usd,
      })),
    },
  ];
}

function simulate(run: EvalRun) {
  const verdicts: ["passed" | "failed", string][] = [
    ["passed", "Contains the expected text."],
    ["failed", "Does not contain the expected text."],
    ["passed", "Exited 0."],
  ];
  run.results.forEach((_, i) => {
    setTimeout(() => {
      run.results[i] = { ...run.results[i], status: "running" };
      notice(run.workspace_id, "personal-eval", structuredClone(run));
    }, 400 + i * 700);
    setTimeout(() => {
      const [status, reason] = verdicts[i % verdicts.length];
      run.results[i] = { ...run.results[i], status, reason, duration_ms: 4000 + i * 1300, cost_usd: Math.round((0.02 + (i % 4) * 0.03) * 100) / 100 };
      if (run.results.every((r) => r.status !== "pending" && r.status !== "running")) run.finished_at = new Date().toISOString();
      notice(run.workspace_id, "personal-eval", structuredClone(run));
    }, 2200 + i * 900);
  });
}

// ---- handlers --------------------------------------------------------------------------

export const handlers: Record<string, (p: Record<string, any>) => unknown> = {
  get_brief: ({ regenerate }) => brief(!!regenerate),

  list_tasks: () => tasks,
  create_task: ({ task: n }) => {
    const t = task(n.title, n.due ?? null, { priority: n.priority ?? "none", workspace_id: n.workspace_id ?? null, thread_id: n.thread_id ?? null, notes: n.notes ?? null, created_at: new Date().toISOString() });
    t.sort = Math.max(0, ...tasks.map((x) => x.sort)) + 1;
    tasks = [...tasks, t];
    pushTasks();
    return t;
  },
  update_task: ({ task: t }) => {
    const old = tasks.find((x) => x.id === t.id);
    if (!old) throw new Error("unknown task");
    const next: PersonalTask = { ...t, created_at: old.created_at, done_at: t.done ? old.done_at ?? new Date().toISOString() : null };
    tasks = tasks.map((x) => (x.id === t.id ? next : x));
    pushTasks();
    return next;
  },
  delete_task: ({ id }) => {
    tasks = tasks.filter((x) => x.id !== id);
    pushTasks();
    return null;
  },
  reorder_tasks: ({ ids }) => {
    const slots = tasks.filter((t) => ids.includes(t.id)).map((t) => t.sort).sort((a, b) => a - b);
    tasks = tasks.map((t) => (ids.includes(t.id) ? { ...t, sort: slots[ids.indexOf(t.id)] } : t)).sort((a, b) => a.sort - b.sort);
    pushTasks();
    return tasks;
  },

  list_notes: () => [...notes.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).map(noteMeta),
  get_note: ({ id }) => {
    const n = notes.get(id);
    if (!n) throw new Error("unknown note");
    return n;
  },
  save_note: ({ id, text }) => {
    const n: PersonalNote = { id: id || uid().replace(/-/g, "").slice(0, 12), text, title: noteTitle(text), updated_at: new Date().toISOString() };
    notes.set(n.id, n);
    return n;
  },
  delete_note: ({ id }) => {
    notes.delete(id);
    return null;
  },

  cost_summary: ({ workspace_id, days }) => costSummary(workspace_id ?? null, days ?? 30),
  list_budgets: ({ workspace_id }) => budgets.filter((b) => !workspace_id || b.budget.workspace_id === workspace_id),
  set_budget: async ({ workspace_id, scope, id, monthly_usd }) => {
    const st = await state();
    const i = budgets.findIndex((b) => b.budget.workspace_id === workspace_id && b.budget.scope === scope && (b.budget.id ?? null) === (scope === "captain" ? id : null));
    if (i >= 0) budgets.splice(i, 1);
    if (monthly_usd > 0) {
      const captain = scope === "captain" ? (st.captains[workspace_id] ?? []).find((c) => c.id === id) : null;
      const label = captain?.name ?? st.workspaces.find((w) => w.id === workspace_id)?.name ?? "";
      const spent = scope === "captain" ? 6.4 : 21.7;
      budgets.push({ budget: { workspace_id, scope, id: scope === "captain" ? id : null, monthly_usd }, label, spent_usd: spent });
    }
    return budgets.filter((b) => b.budget.workspace_id === workspace_id);
  },

  thread_replay: ({ thread_id }) => replay(thread_id),

  list_evals: async ({ workspace_id }) => {
    await seedEvals(workspace_id);
    return suites!.filter((s) => s.workspace_id === workspace_id);
  },
  save_eval: ({ suite }) => {
    const s: EvalSuite = { ...suite, id: suite.id === "00000000-0000-0000-0000-000000000000" ? uid() : suite.id, updated_at: new Date().toISOString() };
    suites = [...(suites ?? []).filter((x) => x.id !== s.id), s];
    return s;
  },
  delete_eval: ({ id }) => {
    suites = (suites ?? []).filter((x) => x.id !== id);
    return null;
  },
  list_eval_runs: async ({ workspace_id, suite_id }) => {
    if (workspace_id) await seedEvals(workspace_id);
    return runs.filter((r) => (!workspace_id || r.workspace_id === workspace_id) && (!suite_id || r.suite_id === suite_id));
  },
  get_eval_run: ({ id }) => runs.find((r) => r.id === id),
  run_eval: ({ suite_id, targets }) => {
    const s = suites?.find((x) => x.id === suite_id);
    if (!s) throw new Error("unknown eval suite");
    const run: EvalRun = {
      id: uid(),
      suite_id,
      workspace_id: s.workspace_id,
      suite_name: s.name,
      cases: s.cases,
      targets,
      started_at: new Date().toISOString(),
      finished_at: null,
      results: s.cases.flatMap((_, c) => targets.map((_: unknown, x: number) => ({ case_index: c, target_index: x, thread_id: null, status: "pending" as const, reason: null, duration_ms: null, cost_usd: null }))),
    };
    runs = [run, ...runs];
    simulate(run);
    return structuredClone(run);
  },
};

export const app: Record<string, (p: Record<string, any>) => unknown> = {};
