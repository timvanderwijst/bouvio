// Browser-preview stand-ins for this area's runner methods (`handlers`) and
// desktop-only app methods (`app`). See ../mock-bus.ts to fire live events.
import { parseDiff } from "../../lib/diff";
import type { ApiCollection } from "../../protocol/ApiCollection";
import type { ApiRequest } from "../../protocol/ApiRequest";
import type { CiRun } from "../../protocol/CiRun";
import type { DbConnection } from "../../protocol/DbConnection";
import type { DbRows } from "../../protocol/DbRows";
import type { GraphCommit } from "../../protocol/GraphCommit";
import type { GraphEdge } from "../../protocol/GraphEdge";
import type { HttpResponse } from "../../protocol/HttpResponse";
import type { ReviewComment } from "../../protocol/ReviewComment";
import type { Thread } from "../../protocol/Thread";
import { mockFire } from "../mock-bus";
import pickerJs from "../../../../../crates/runner/src/ext/dev/picker.js?raw";

const uid = () => crypto.randomUUID();
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const notice = (workspace_id: string, kind: string, payload: unknown) => mockFire("workspace-notice", { workspace_id, kind, payload });
const NIL = "00000000-0000-0000-0000-000000000000";

/** The main mock backend, loaded lazily to stay out of its import cycle. */
const main = async () => (await import("../mock")).mockBackend;

// ---- git graph ----------------------------------------------------------------------------

const C = (sha: string, parents: string[], subject: string, author: string, min: number, refs: string[] = []) => ({ sha, parents, subject, author, min, refs });
const HISTORY = [
  C("7be04d55a1", ["5e0f2b9c4d"], "Widen the rail's hover zone to 8px on Windows", "Desktop", 3, ["cuna/7be04d55"]),
  C("3f9a2c1e77", ["9d41c0a2e3"], "Keep a draft per thread in the composer", "Desktop", 5, ["cuna/3f9a2c1e"]),
  C("c01d9e72f0", ["5e0f2b9c4d"], "Look for codex.cmd next to codex on Windows", "Runner", 9, ["cuna/c01d9e72"]),
  C("9d41c0a2e3", ["5e0f2b9c4d"], "Move composer drafts into the store", "Desktop", 14),
  C("5e0f2b9c4d", ["a17c3e0f88", "e2b8d4416a"], "Merge pull request #41 from feature/hub-invites", "Maya Peters", 62, ["HEAD", "main", "origin/main"]),
  C("e2b8d4416a", ["4c7a9e01b2"], "Invite links carry a role", "Hub", 95, ["origin/feature/hub-invites"]),
  C("a17c3e0f88", ["0b6f3d2c91"], "Resume Claude sessions after a restart", "Runner", 130),
  C("4c7a9e01b2", ["0b6f3d2c91"], "Hub: members table with roles", "Hub", 180),
  C("0b6f3d2c91", ["f83e1a5d07"], "Diff colours in the dark theme", "Design", 600, ["v0.4.0"]),
  C("f83e1a5d07", ["2a9c6b4e13"], "One terminal per thread, kept across tabs", "Maya Peters", 1500),
  C("2a9c6b4e13", ["8e1d07f5c2"], "Worktree per thread on its own cuna/ branch", "Runner", 2900),
  C("8e1d07f5c2", [], "Initial commit", "Maya Peters", 9000),
];

/** The runner's lane assignment, ported for the preview. */
function lanes(list: GraphCommit[]) {
  let cols: ([string, number] | null)[] = [];
  let next = 0;
  let width = 0;
  const afters: ([string, number] | null)[][] = [];
  const opened: number[][] = [];
  const joins: number[][] = [];
  const free = () => {
    const i = cols.findIndex((x) => x === null);
    if (i >= 0) return i;
    cols.push(null);
    return cols.length - 1;
  };
  for (const c of list) {
    const waiting = cols.flatMap((x, i) => (x && x[0] === c.sha ? [i] : []));
    let lane: number;
    let color: number;
    if (waiting.length) [lane, color] = [waiting[0], cols[waiting[0]]![1]];
    else [lane, color] = [free(), next++];
    for (const i of waiting) cols[i] = null;
    c.lane = lane;
    c.color = color;
    const o: number[] = [];
    const j: number[] = [];
    c.parents.forEach((p, n) => {
      const at = cols.findIndex((x) => x?.[0] === p);
      if (at >= 0) j.push(at);
      else if (n === 0) cols[lane] = [p, color];
      else {
        const i = free();
        cols[i] = [p, next++];
        o.push(i);
      }
    });
    while (cols.length && cols[cols.length - 1] === null) cols.pop();
    width = Math.max(width, cols.length, lane + 1);
    afters.push(cols.map((x) => (x ? [...x] : null)) as ([string, number] | null)[]);
    opened.push(o);
    joins.push(j);
  }
  list.forEach((c, i) => {
    const nx = list[i + 1];
    const target = (k: number, sha: string) => (nx && nx.sha === sha ? nx.lane : k);
    const edges: GraphEdge[] = [];
    afters[i].forEach((slot, k) => {
      if (slot) edges.push({ from: opened[i].includes(k) ? c.lane : k, to: target(k, slot[0]), color: slot[1] });
    });
    for (const k of joins[i]) {
      const slot = afters[i][k];
      if (k !== c.lane && slot) edges.push({ from: c.lane, to: target(k, slot[0]), color: c.color });
    }
    c.edges = edges;
  });
  cols = [];
  return width;
}

function graph(limit = 300) {
  const commits: GraphCommit[] = HISTORY.slice(0, limit).map((c) => ({
    sha: c.sha.padEnd(40, "0"),
    parents: c.parents.map((p) => p.padEnd(40, "0")),
    refs: c.refs,
    author: c.author,
    email: `${c.author.split(" ")[0].toLowerCase()}@cuna.dev`,
    date: ago(c.min),
    subject: c.subject,
    lane: 0,
    color: 0,
    edges: [],
  }));
  const width = lanes(commits);
  return { commits, lanes: width, head: commits.find((c) => c.refs[0] === "HEAD")?.sha ?? null };
}

const FILES: Record<string, [string, number | null, number | null][]> = {
  "7be04d55a1": [["apps/desktop/src/components/Rail.tsx", 6, 2], ["apps/desktop/src/styles/app.css", 4, 1]],
  "3f9a2c1e77": [["apps/desktop/src/components/Composer.tsx", 3, 2], ["apps/desktop/src/store.ts", 2, 0]],
  "c01d9e72f0": [["crates/runner/src/detect.rs", 18, 4], ["crates/runner/src/harness/codex.rs", 3, 1]],
  "5e0f2b9c4d": [["apps/hub/src/invites.rs", 112, 0], ["apps/hub/src/members.rs", 64, 12], ["apps/hub/migrations/0007_invites.sql", 14, 0]],
  "0b6f3d2c91": [["apps/desktop/src/styles/tokens.css", 10, 10], ["apps/desktop/public/logo.png", null, null]],
};

function commit(sha: string) {
  const c = HISTORY.find((x) => sha.startsWith(x.sha));
  if (!c) throw new Error("unknown commit");
  const files = (FILES[c.sha] ?? [["README.md", 4, 1]]).map(([path, adds, dels]) => ({ path, adds, dels }));
  const stat = files.map((f) => ` ${f.path.padEnd(44)} | ${f.adds === null ? "Bin" : `${f.adds + (f.dels ?? 0)} ${"+".repeat(Math.min(f.adds, 20))}${"-".repeat(Math.min(f.dels ?? 0, 20))}`}`).join("\n");
  return {
    sha: c.sha.padEnd(40, "0"),
    parents: c.parents.map((p) => p.padEnd(40, "0")),
    author: c.author,
    email: `${c.author.split(" ")[0].toLowerCase()}@cuna.dev`,
    date: ago(c.min),
    subject: c.subject,
    body: c.parents.length > 1 ? "Invites with roles on the hub: viewer, commenter, prompter, operator and admin." : "",
    files,
    stat,
  };
}

// ---- checks -------------------------------------------------------------------------------

const run = (id: number, workflow: string, title: string, branch: string, event: string, status: string, conclusion: string | null, min: number): CiRun => ({
  id,
  workflow,
  title,
  branch,
  event,
  status,
  conclusion,
  created_at: ago(min),
  url: `https://github.com/timvanderwijst/bouvio/actions/runs/${id}`,
  thread_id: null,
});
const RUNS: CiRun[] = [
  run(4013, "CI", "Widen the rail's hover zone to 8px on Windows", "cuna/7be04d55", "push", "in_progress", null, 2),
  run(4012, "CI", "Keep a draft per thread in the composer", "cuna/3f9a2c1e", "push", "completed", "failure", 6),
  run(4011, "CI", "Merge pull request #41 from feature/hub-invites", "main", "push", "completed", "success", 61),
  run(4010, "Release", "v0.4.0", "main", "release", "completed", "success", 590),
  run(4009, "CI", "Look for codex.cmd next to codex on Windows", "cuna/c01d9e72", "pull_request", "completed", "failure", 8),
  run(4008, "Lint", "Bump vite to 6.2.1", "renovate/vite", "pull_request", "completed", "cancelled", 240),
  run(4007, "CI", "Invite links carry a role", "feature/hub-invites", "pull_request", "completed", "success", 96),
];

const T = (s: number) => new Date(Date.now() - 6 * 60_000 + s * 1000).toISOString().replace("Z", "0000Z");
const LOGS: Record<number, string> = {
  4012: [
    `typecheck\tSet up job\t${T(0)} Current runner version: '2.321.0'`,
    `typecheck\tRun pnpm -r typecheck\t${T(41)} ##[group]Run pnpm -r typecheck`,
    `typecheck\tRun pnpm -r typecheck\t${T(41)} pnpm -r typecheck`,
    `typecheck\tRun pnpm -r typecheck\t${T(41)} ##[endgroup]`,
    `typecheck\tRun pnpm -r typecheck\t${T(44)} Scope: 2 of 3 workspace projects`,
    `typecheck\tRun pnpm -r typecheck\t${T(52)} apps/desktop typecheck$ tsc -b --noEmit`,
    `typecheck\tRun pnpm -r typecheck\t${T(61)} apps/desktop typecheck: src/components/Composer.tsx(44,11): error TS2554: Expected 2 arguments, but got 1.`,
    `typecheck\tRun pnpm -r typecheck\t${T(61)} apps/desktop typecheck: src/components/ThreadView.tsx(88,7): error TS2339: Property 'draft' does not exist on type 'State'.`,
    `typecheck\tRun pnpm -r typecheck\t${T(62)} apps/desktop typecheck: Failed`,
    `typecheck\tRun pnpm -r typecheck\t${T(62)} /home/runner/work/cuna/cuna/apps/desktop:`,
    `typecheck\tRun pnpm -r typecheck\t${T(62)} ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @cuna/desktop@0.4.0 typecheck: \`tsc -b --noEmit\``,
    `typecheck\tRun pnpm -r typecheck\t${T(62)} Exit status 2`,
    `typecheck\tRun pnpm -r typecheck\t${T(62)} ##[error]Process completed with exit code 2.`,
  ].join("\n"),
  4009: [
    `test (windows-latest)\tRun cargo test --workspace\t${T(0)} ##[group]Run cargo test --workspace`,
    `test (windows-latest)\tRun cargo test --workspace\t${T(190)}      Running unittests src\\lib.rs (target\\debug\\deps\\cuna_runner-5d1c.exe)`,
    `test (windows-latest)\tRun cargo test --workspace\t${T(191)} running 41 tests`,
    `test (windows-latest)\tRun cargo test --workspace\t${T(196)} test detect::tests::finds_codex_cmd ... FAILED`,
    `test (windows-latest)\tRun cargo test --workspace\t${T(197)} failures:`,
    `test (windows-latest)\tRun cargo test --workspace\t${T(197)} ---- detect::tests::finds_codex_cmd stdout ----`,
    `test (windows-latest)\tRun cargo test --workspace\t${T(197)} thread 'detect::tests::finds_codex_cmd' panicked at crates\\runner\\src\\detect.rs:31:9:`,
    `test (windows-latest)\tRun cargo test --workspace\t${T(197)} assertion \`left == right\` failed`,
    `test (windows-latest)\tRun cargo test --workspace\t${T(197)}   left: Some("C:\\\\npm\\\\codex")`,
    `test (windows-latest)\tRun cargo test --workspace\t${T(197)}  right: Some("C:\\\\npm\\\\codex.cmd")`,
    `test (windows-latest)\tRun cargo test --workspace\t${T(198)} test result: FAILED. 40 passed; 1 failed; 0 ignored`,
    `test (windows-latest)\tRun cargo test --workspace\t${T(198)} ##[error]Process completed with exit code 101.`,
  ].join("\n"),
};

// ---- review -------------------------------------------------------------------------------

const reviews = new Map<string, ReviewComment[]>();

async function lineText(thread_id: string, path: string, side: string, line: number) {
  const raw = await (await main()).rpc<string>(null, "thread_diff", { thread_id });
  const f = parseDiff(raw).find((x) => x.path === path);
  const l = f?.hunks.flatMap((h) => h.lines).find((x) => (side === "old" ? x.kind === "del" && x.old === line : x.kind !== "del" && x.new === line));
  return l?.text ?? null;
}

async function seedReview(thread_id: string) {
  if (reviews.has(thread_id)) return reviews.get(thread_id)!;
  const list: ReviewComment[] = [];
  const path = "apps/desktop/src/components/Composer.tsx";
  const text = await lineText(thread_id, path, "new", 41);
  if (text !== null)
    list.push({
      id: uid(),
      thread_id,
      path,
      line: 41,
      side: "new",
      text: "Select both in one call with useShallow, so the composer re-renders once per keystroke instead of twice.",
      author: "Jonas",
      line_text: text,
      resolved: false,
      outdated: false,
      created_at: ago(7),
    });
  reviews.set(thread_id, list);
  return list;
}

// ---- data ---------------------------------------------------------------------------------

const connections = new Map<string, DbConnection[]>();
const conns = (ws: string) => {
  if (!connections.has(ws))
    connections.set(ws, [
      { id: uid(), name: "App", kind: "sqlite", url: "data/app.db", read_only: true },
      { id: uid(), name: "Hub (staging)", kind: "postgres", url: "postgres://cuna:****@10.0.0.4:5432/hub", read_only: true },
    ]);
  return connections.get(ws)!;
};
const findConn = (id: string) => [...connections.values()].flat().find((c) => c.id === id);

const NAMES = ["Maya Peters", "Jonas de Vries", "Noor Bakker", "Sem Jansen", "Lotte Visser", "Daan Smit", "Eva Mulder", "Finn de Boer", "Mila Bos", "Luuk Meijer"];
const TABLES: Record<string, { kind: string; columns: string[]; rows: (i: number) => unknown[]; total: number }> = {
  users: {
    kind: "table",
    columns: ["id", "email", "name", "role", "verified", "created_at", "settings"],
    total: 1284,
    rows: (i) => {
      const n = NAMES[i % NAMES.length];
      return [i + 1, `${n.split(" ")[0].toLowerCase()}${i > 9 ? i : ""}@example.com`, n, ["admin", "operator", "prompter", "commenter", "viewer"][i % 5], i % 7 !== 3, ago(60 * 24 * (400 - i)), i % 4 === 0 ? { theme: "dark", lang: "nl" } : null];
    },
  },
  workspaces: {
    kind: "table",
    columns: ["id", "name", "owner_id", "shared", "created_at"],
    total: 37,
    rows: (i) => [`ws_${(1e6 + i * 7919).toString(36)}`, ["Cuna", "northwind.dev", "Q1 planning", "Jonas's studio", "Hub ops"][i % 5] + (i > 4 ? ` ${i}` : ""), (i % 10) + 1, i % 3 === 0, ago(60 * 24 * (200 - i))],
  },
  invites: {
    kind: "table",
    columns: ["code", "workspace_id", "role", "uses", "expires_at"],
    total: 12,
    rows: (i) => [`${(36 ** 5 + i * 104729).toString(36).slice(-6).toUpperCase()}`, `ws_${(1e6 + (i % 5) * 7919).toString(36)}`, ["viewer", "prompter", "operator"][i % 3], i % 4, i % 3 === 2 ? null : ago(-60 * 24 * (i + 1))],
  },
  events: {
    kind: "table",
    columns: ["seq", "thread_id", "kind", "payload_bytes", "at"],
    total: 48211,
    rows: (i) => [48211 - i, `th_${(5e5 + (i % 9) * 31).toString(36)}`, ["assistant_text", "tool_use", "tool_result", "status", "turn_complete"][i % 5], 120 + ((i * 397) % 4000), ago(i * 0.4)],
  },
  active_members: {
    kind: "view",
    columns: ["workspace", "members", "last_seen"],
    total: 5,
    rows: (i) => [["Cuna", "northwind.dev", "Q1 planning", "Jonas's studio", "Hub ops"][i], 2 + ((i * 3) % 7), ago(i * 13)],
  },
};

function tableRows(name: string, limit: number, offset: number, order?: { column: string; desc: boolean } | null): DbRows {
  const t = TABLES[name];
  if (!t) throw new Error(`unknown table ${name}`);
  let rows = Array.from({ length: Math.min(t.total, 400) }, (_, i) => t.rows(i));
  if (order) {
    const k = t.columns.indexOf(order.column);
    rows = [...rows].sort((a, b) => {
      const x = a[k] as any;
      const y = b[k] as any;
      const c = x === y ? 0 : x === null ? -1 : y === null ? 1 : x < y ? -1 : 1;
      return order.desc ? -c : c;
    });
  }
  return { columns: t.columns, rows: rows.slice(offset, offset + limit), truncated: false, total: t.total, affected: null, time_ms: 2 + Math.round(Math.random() * 6) };
}

const READ = /^\s*(select|with|explain|pragma|show|values)\b/i;
function query(conn: DbConnection, sql: string): DbRows {
  if (conn.read_only && (!READ.test(sql) || /\b(insert|update|delete|drop|alter|create|truncate|into)\b/i.test(sql))) {
    const word = sql.trim().split(/\s+/)[0]?.toUpperCase() || "That";
    throw new Error(`this connection is read-only; ${word} is not a read`);
  }
  if (!READ.test(sql)) return { columns: [], rows: [], truncated: false, total: null, affected: 1 + Math.floor(Math.random() * 3), time_ms: 4 };
  const from = sql.match(/\bfrom\s+["`]?(\w+)/i)?.[1]?.toLowerCase();
  if (/count\(\*\)/i.test(sql) && from && TABLES[from]) return { columns: ["count"], rows: [[TABLES[from].total]], truncated: false, total: null, affected: null, time_ms: 3 };
  if (from && TABLES[from]) {
    const limit = +(sql.match(/\blimit\s+(\d+)/i)?.[1] ?? 1000);
    const r = tableRows(from, Math.min(limit, 1000), 0);
    return { ...r, total: null, truncated: limit > 1000 && TABLES[from].total > 1000 };
  }
  return { columns: ["?column?"], rows: [[1]], truncated: false, total: null, affected: null, time_ms: 1 };
}

// ---- API client ---------------------------------------------------------------------------

const H = (name: string, value: string) => ({ name, value, enabled: true });
const apis = new Map<string, ApiCollection>();
const api = (ws: string) => {
  if (!apis.has(ws)) {
    const local = uid();
    const req = (name: string, method: string, url: string, body = ""): ApiRequest => ({
      id: uid(),
      name,
      method,
      url,
      headers: [H("Accept", "application/json"), ...(body ? [H("Content-Type", "application/json")] : []), H("Authorization", "Bearer {{token}}")],
      body,
    });
    apis.set(ws, {
      requests: [
        req("Health", "GET", "{{base_url}}/api/health"),
        req("List workspaces", "GET", "{{base_url}}/api/workspaces"),
        req("Create invite", "POST", "{{base_url}}/api/workspaces/ws_cuna/invites", '{\n  "role": "prompter",\n  "uses": 5\n}'),
        req("Revoke invite", "DELETE", "{{base_url}}/api/invites/K3F9QX"),
      ],
      environments: [
        { id: local, name: "Local hub", variables: [{ key: "base_url", value: "http://127.0.0.1:8787" }, { key: "token", value: "dev-7f3a91" }] },
        { id: uid(), name: "Staging", variables: [{ key: "base_url", value: "https://hub.staging.cuna.dev" }, { key: "token", value: "" }] },
      ],
      active_env: local,
      history: [
        { id: uid(), at: ago(4), request: req("", "GET", "{{base_url}}/api/workspaces"), status: 200, time_ms: 18, size: 612 },
        { id: uid(), at: ago(11), request: req("", "POST", "{{base_url}}/api/workspaces/ws_cuna/invites", '{ "role": "viewer" }'), status: 201, time_ms: 41, size: 143 },
        { id: uid(), at: ago(26), request: req("", "GET", "{{base_url}}/api/me"), status: 401, time_ms: 6, size: 37 },
      ],
    });
  }
  return apis.get(ws)!;
};

function respond(method: string, url: string, body: string): Omit<HttpResponse, "time_ms" | "url"> {
  const json = (status: number, statusText: string, v: unknown) => {
    const text = JSON.stringify(v);
    return {
      status,
      status_text: statusText,
      headers: [H("content-type", "application/json"), H("content-length", String(text.length)), H("date", new Date().toUTCString()), H("x-request-id", uid().slice(0, 13)), H("server", "cuna-hub/0.4.0")],
      body: text,
      base64: false,
      size: text.length,
    };
  };
  const path = url.replace(/^\w+:\/\/[^/]+/, "").split("?")[0];
  if (path === "/api/health") return json(200, "OK", { ok: true, version: "0.4.0", uptime_s: 86_412, db: "sqlite", runners_online: 2 });
  if (path === "/api/workspaces")
    return json(200, "OK", [
      { id: "ws_cuna", name: "Cuna", role: "admin", members: 4, host_online: true },
      { id: "ws_northwind", name: "northwind.dev", role: "operator", members: 2, host_online: false },
      { id: "ws_q1", name: "Q1 planning", role: "viewer", members: 7, host_online: true },
    ]);
  if (path.endsWith("/invites") && method === "POST") {
    let role = "viewer";
    try {
      role = JSON.parse(body).role ?? role;
    } catch {
      return json(400, "Bad Request", { error: "body is not valid JSON" });
    }
    return json(201, "Created", { code: "K3F9QX", role, url: "https://hub.example.com/join/K3F9QX", expires_at: ago(-60 * 24 * 7) });
  }
  if (method === "DELETE") return { status: 204, status_text: "No Content", headers: [H("date", new Date().toUTCString())], body: "", base64: false, size: 0 };
  if (path === "/api/me") return json(401, "Unauthorized", { error: "sign in first" });
  return json(404, "Not Found", { error: `no route for ${method} ${path}` });
}

// ---- preview page with the real picker ----------------------------------------------------

let pageUrl: string | null = null;
function page() {
  if (pageUrl) return pageUrl;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Settings · Cuna</title>
<style>
*{box-sizing:border-box}body{margin:0;font:14px/1.5 -apple-system,system-ui,sans-serif;color:#1b1b1a;background:#fafaf9}
header{display:flex;align-items:center;gap:20px;height:56px;padding:0 24px;border-bottom:1px solid #eee;background:#fff}
header b{font-size:15px}nav a{color:#666;text-decoration:none;margin-right:16px}nav a.on{color:#1b1b1a;font-weight:600}
main{max-width:640px;margin:32px auto;padding:0 24px}h1{font-size:22px;margin:0 0 4px}p.sub{color:#777;margin:0 0 24px}
.card{background:#fff;border:1px solid #eee;border-radius:12px;padding:20px;margin-bottom:16px}
label{display:block;font-size:13px;font-weight:600;margin:0 0 6px}input{width:100%;height:36px;border:1px solid #ddd;border-radius:8px;padding:0 10px;font:inherit;margin-bottom:14px}
.row{display:flex;gap:8px;justify-content:flex-end}button{height:34px;padding:0 14px;border-radius:8px;border:1px solid #ddd;background:#fff;font:inherit;font-weight:500;cursor:pointer}
button.primary{background:#3e63dd;border-color:#3e63dd;color:#fff}.toggle{display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-top:1px solid #f0f0f0}
.toggle:first-of-type{border-top:0}.sw{width:34px;height:20px;border-radius:10px;background:#3e63dd;position:relative}.sw:after{content:"";position:absolute;right:3px;top:3px;width:14px;height:14px;border-radius:50%;background:#fff}
</style></head><body>
<header data-source="src/components/Header.tsx:12"><b>Cuna</b><nav><a href="#">Threads</a><a href="#">Issues</a><a class="on" href="#">Settings</a></nav></header>
<main data-source="src/pages/Settings.tsx:18">
<h1>Profile</h1><p class="sub">How you show up to people and agents in shared workspaces.</p>
<section class="card" data-source="src/pages/Settings.tsx:24">
<label for="n">Display name</label><input id="n" value="Maya Peters" data-source="src/pages/Settings.tsx:27">
<label for="e">Email</label><input id="e" value="maya@example.com" data-source="src/pages/Settings.tsx:31">
<div class="row"><button data-source="src/pages/Settings.tsx:36">Cancel</button><button class="primary" data-testid="save-profile" data-source="src/pages/Settings.tsx:37">Save changes</button></div>
</section>
<section class="card" data-source="src/pages/Settings.tsx:44">
<div class="toggle"><span>Notify me when an agent needs me</span><span class="sw"></span></div>
<div class="toggle"><span>Weekly cost summary</span><span class="sw"></span></div>
</section></main>
<script>${pickerJs}</script>
<script>setTimeout(()=>parent.postMessage({type:"cuna:location",path:"/settings/profile",href:"",title:document.title},"*"),30)</script>
</body></html>`;
  pageUrl = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  return pageUrl;
}

// ---- handlers -----------------------------------------------------------------------------

export const handlers: Record<string, (p: Record<string, any>) => unknown> = {
  dev_proxy: async ({ thread_id }) => {
    await wait(400);
    return { thread_id, url: page(), upstream: "http://127.0.0.1:5173" };
  },
  stop_dev_proxy: () => null,

  list_review_comments: async ({ thread_id }) => (await seedReview(thread_id)).map((c) => ({ ...c })),
  add_review_comment: async ({ thread_id, path, line, side, text }) => {
    const list = await seedReview(thread_id);
    const lt = await lineText(thread_id, path, side, line);
    if (lt === null) throw new Error("that line is not in the diff any more");
    const c: ReviewComment = { id: uid(), thread_id, path, line, side, text: text.trim(), author: "Maya", line_text: lt, resolved: false, outdated: false, created_at: new Date().toISOString() };
    list.push(c);
    return { ...c };
  },
  resolve_review_comment: ({ id, resolved = true }) => {
    for (const list of reviews.values()) {
      const c = list.find((x) => x.id === id);
      if (c) {
        c.resolved = resolved;
        return { ...c };
      }
    }
    throw new Error("unknown comment");
  },
  delete_review_comment: ({ id }) => {
    for (const [k, list] of reviews) reviews.set(k, list.filter((x) => x.id !== id));
    return null;
  },

  ci_runs: async () => {
    await wait(250);
    return RUNS.map((r) => ({ ...r }));
  },
  get_ci_log: async ({ run_id }) => {
    await wait(200);
    return { text: LOGS[run_id] ?? "", truncated: false };
  },
  fix_ci_run: async ({ workspace_id, run_id }) => {
    const r = RUNS.find((x) => x.id === run_id)!;
    const m = await main();
    const t = await m.rpc<Thread>(workspace_id, "create_thread", {
      thread: { workspace_id, lead_id: null, title: `Fix ${r.workflow} on ${r.branch}`, harness: "claude_code", model: null, effort: "medium", approval: "ask_risky", isolate: true },
    });
    await m.rpc(workspace_id, "send_message", {
      thread_id: t.id,
      text: `The GitHub Actions run "${r.title}" (${r.workflow}) failed on branch \`${r.branch}\`. ${r.url}\n\nFind the cause, fix it, and run the failing check locally if you can.\n\nFailing log:\n\n\`\`\`\n${(LOGS[r.id] ?? "").replace(/^[^\t]*\t[^\t]*\t\S+ /gm, "")}\n\`\`\``,
    });
    return t;
  },

  list_db_connections: ({ workspace_id }) => ({ connections: conns(workspace_id).map((c) => ({ ...c })), suggestions: ["dev.sqlite"] }),
  save_db_connection: ({ workspace_id, connection }) => {
    const list = conns(workspace_id);
    const c = { ...connection, id: connection.id === NIL ? uid() : connection.id };
    const i = list.findIndex((x) => x.id === c.id);
    if (i >= 0) list[i] = c;
    else list.push(c);
    notice(workspace_id, "dev-db", {});
    return { ...c };
  },
  delete_db_connection: ({ workspace_id, id }) => {
    connections.set(workspace_id, conns(workspace_id).filter((c) => c.id !== id));
    notice(workspace_id, "dev-db", {});
    return null;
  },
  list_db_tables: async ({ conn }) => {
    await wait(80);
    if (!findConn(conn)) throw new Error("unknown connection");
    return Object.entries(TABLES).map(([name, t]) => ({ name, kind: t.kind }));
  },
  get_db_rows: async ({ table, limit = 100, offset = 0, order }) => {
    await wait(60);
    return tableRows(table, limit, offset, order);
  },
  run_db_query: async ({ conn, sql }) => {
    await wait(90);
    const c = findConn(conn);
    if (!c) throw new Error("unknown connection");
    return query(c, sql);
  },

  http_request: async ({ workspace_id, method = "GET", url, headers = [], body = "", name }) => {
    const col = workspace_id ? api(workspace_id) : null;
    const env = col?.environments.find((e) => e.id === col.active_env);
    const vars = Object.fromEntries((env?.variables ?? []).map((v) => [v.key, v.value]));
    const fill = (s: string) => s.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (m, k) => vars[k] ?? m);
    const real = fill(url);
    const time = 8 + Math.round(Math.random() * 60);
    await wait(time + 120);
    if (!/^https?:\/\//.test(real)) throw new Error("not a valid URL");
    if (real.includes("staging")) throw new Error("could not connect: dns error: failed to lookup address information");
    const res = { ...respond(method, real, fill(body)), time_ms: time, url: real };
    if (col && workspace_id) {
      col.history.unshift({ id: uid(), at: new Date().toISOString(), request: { id: NIL, name: name ?? "", method, url, headers, body }, status: res.status, time_ms: res.time_ms, size: res.size });
      col.history.length = Math.min(col.history.length, 50);
      notice(workspace_id, "dev-api", {});
    }
    return res;
  },
  list_api_requests: ({ workspace_id }) => structuredClone(api(workspace_id)),
  save_api_request: ({ workspace_id, request }) => {
    const col = api(workspace_id);
    const r = { ...request, id: request.id === NIL ? uid() : request.id, name: request.name?.trim() || `${request.method} ${request.url}` };
    const i = col.requests.findIndex((x) => x.id === r.id);
    if (i >= 0) col.requests[i] = r;
    else col.requests.push(r);
    notice(workspace_id, "dev-api", {});
    return { ...r };
  },
  delete_api_request: ({ workspace_id, id }) => {
    const col = api(workspace_id);
    col.requests = col.requests.filter((x) => x.id !== id);
    return null;
  },
  save_api_environments: ({ workspace_id, environments, active_env }) => {
    const col = api(workspace_id);
    col.environments = environments.map((e: any) => ({ ...e, id: e.id === NIL ? uid() : e.id }));
    col.active_env = col.environments.some((e) => e.id === active_env) ? active_env : null;
    return structuredClone(col);
  },
  clear_api_history: ({ workspace_id }) => {
    api(workspace_id).history = [];
    return null;
  },

  git_graph: async ({ limit }) => {
    await wait(120);
    return graph(limit);
  },
  get_commit: async ({ sha }) => {
    await wait(60);
    return commit(sha);
  },
};

export const app: Record<string, (p: Record<string, any>) => unknown> = {};
