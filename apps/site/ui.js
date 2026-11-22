// App parts for the site, built with the app's own classes and real project
// content. A page places them with <div data-ui="name"></div>.

// ---- small pieces -----------------------------------------------------------

const PALETTES = [
  ["#F6E7D8", "#C2653A", "#3A2418"], ["#E3ECF7", "#3F6FB5", "#1B2A44"], ["#E6F2E4", "#3E8E5A", "#1D3324"],
  ["#F4E4EE", "#B24C86", "#3B1830"], ["#F3EED9", "#B58A1E", "#3A2E0C"], ["#E8E6F7", "#6553C4", "#221C47"],
  ["#E2F1F1", "#2E8C8C", "#123434"], ["#F6E2DF", "#C24A3E", "#3F1712"],
];
function rng(seed) {
  let a = seed >>> 0 || 1;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** The same pixel captain the app draws for a seed. */
export function avatar(seed, size = 18) {
  const r = rng(seed);
  const [bg, fg, dark] = PALETTES[Math.floor(r() * PALETTES.length)];
  const cells = [];
  for (let y = 1; y < 7; y++) for (let x = 1; x < 4; x++) {
    const edge = x === 1 && (y === 1 || y === 6);
    const on = y === 3 && x === 2 ? 2 : !edge && (x > 1 || r() > 0.35) && (y < 6 || r() > 0.4) ? 1 : 0;
    if (on) cells.push([x, y, on], [7 - x, y, on]);
  }
  const top = Math.floor(r() * 3);
  if (top === 0) cells.push([3, 0, 2], [4, 0, 2]);
  if (top === 1) cells.push([2, 0, 1], [5, 0, 1]);
  return `<svg class="pixel-avatar" width="${size}" height="${size}" viewBox="0 0 8 8" shape-rendering="crispEdges" aria-hidden="true"><rect width="8" height="8" fill="${bg}"/>${cells.map(([x, y, k]) => `<rect x="${x}" y="${y}" width="1" height="1" fill="${k === 2 ? dark : fg}"/>`).join("")}</svg>`;
}

export function status(s, size = 14) {
  const c = 2 * Math.PI * 5;
  const inner = {
    working: `<circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" stroke-opacity=".22" stroke-width="2"/><circle class="status-arc" cx="7" cy="7" r="5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-dasharray="${c * 0.3} ${c}"/>`,
    blocked: `<circle cx="7" cy="7" r="6" fill="currentColor"/><rect x="6.1" y="3.4" width="1.8" height="4.6" rx=".9" fill="var(--sheet)"/><circle cx="7" cy="10.1" r="1" fill="var(--sheet)"/>`,
    error: `<circle cx="7" cy="7" r="5.25" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M5 5l4 4M9 5l-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>`,
    done: `<circle cx="7" cy="7" r="6" fill="currentColor"/><path d="M4.4 7.2l1.8 1.8 3.5-3.6" fill="none" stroke="var(--sheet)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`,
    idle: `<circle cx="7" cy="7" r="4.75" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2 1.8"/>`,
  }[s];
  return `<svg class="status status-${s}" width="${size}" height="${size}" viewBox="0 0 14 14" aria-hidden="true">${inner}</svg>`;
}

// A few line icons in the app's style (24px grid, 1.75 stroke).
const P = {
  pen: "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z",
  list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  doc: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Zm0 0v5h5M9 13h6M9 17h6",
  cal: "M8 3v4M16 3v4M4 9h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z",
  chat: "M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z",
  issue: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18",
  pr: "M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM18 9v3a3 3 0 0 1-3 3H9",
  studio: "M12 22a10 10 0 1 1 10-10c0 2.8-2.2 3-4 3h-2a2 2 0 0 0-1 3.7A1.7 1.7 0 0 1 12 22Z",
  more: "M6 9l6 6 6-6",
  hash: "M4 9h16M4 15h16M10 3 8 21M16 3l-2 18",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM21 21l-4.3-4.3",
  shield: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10ZM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6M12 17h.01",
  check: "M20 6 9 17l-5-5",
  x: "M18 6 6 18M6 6l12 12",
  up: "M12 19V5M5 12l7-7 7 7",
  mic: "M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3ZM19 10v2a7 7 0 0 1-14 0v-2M12 19v3",
  monitor: "M3 4h18v12H3zM8 20h8M12 16v4",
  branch: "M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM15 6a9 9 0 0 0-9 9",
  arrow: "M5 12h14M13 6l6 6-6 6",
  headset: "M3 14v-2a9 9 0 0 1 18 0v2M21 15a2 2 0 0 1-2 2h-1v-5h3ZM3 15a2 2 0 0 0 2 2h1v-5H3Z",
  bolt: "M13 2 3 14h9l-1 8 10-12h-9l1-8Z",
  lock: "M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4",
  download: "M12 3v12M7 10l5 5 5-5M5 21h14",
  github: "M9 19c-4.3 1.4-4.3-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12 12 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21",
  play: "M6 4l14 8-14 8Z",
};
export const icon = (n, s = 15, w = 1.75) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${P[n]}"/></svg>`;

export const mark = (s = 16) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="2.5" width="5.5" height="19" rx="2.75" fill="currentColor"/><rect x="4" y="10" width="16" height="11.5" rx="5.75" fill="currentColor" opacity=".55"/></svg>`;

// ---- the project everything shows ----------------------------------------------

const CAPTAINS = [
  { name: "Desktop", seed: 11, state: "working", threads: [["Rail shows on hover at the left edge", "working", "1m"], ["Keep a draft per thread in the composer", "idle", "4m"]] },
  { name: "Runner", seed: 23, state: "working" },
  { name: "Hub", seed: 37, badge: 1 },
  { name: "Design", seed: 41, badge: 1 },
  { name: "Docs", seed: 53 },
];

// ---- app parts -------------------------------------------------------------------

export function sidebar({ active = "Desktop", page = null } = {}) {
  const row = (ic, label, on, count) => `<div class="sb-row ${on ? "active" : ""}">${icon(ic)}<span class="truncate">${label}</span>${count ? `<span class="sb-count">${count}</span>` : ""}</div>`;
  const caps = CAPTAINS.map((c) => {
    const on = c.name === active;
    const right = c.badge ? `<span class="badge">${c.badge}</span>` : c.state === "working" ? status("working", 13) : "";
    const kids = on && c.threads
      ? `<div class="captain-threads">${c.threads.map(([t, s, w]) => `<div class="sb-row thread-row nested">${s !== "idle" ? status(s, 12) : ""}<span class="truncate">${t}</span><span class="sb-meta">${w} ago</span></div>`).join("")}</div>`
      : "";
    return `<div class="captain"><div class="sb-row captain-row ${on && !page ? "active" : ""}"><span class="avatar-wrap">${avatar(c.seed)}</span><span class="truncate">${c.name}</span>${right}</div>${kids}</div>`;
  }).join("");
  return `<aside class="sidebar">
    <div class="sb-top"><div class="ws-btn"><span class="ws-mark">${mark(16)}</span><span>Bouvio</span></div><div class="sb-top-actions"><span class="icon-btn">${icon("search")}</span></div></div>
    <nav class="sb-nav">${row("pen", "New thread")}${row("list", "Threads")}${row("doc", "Docs", page === "Docs")}${row("cal", "Calendar")}${row("chat", "Chat", page === "Chat")}${row("issue", "Issues", page === "Issues", 5)}${row("pr", "Pull requests")}${row("studio", "Studio", page === "Studio")}${row("more", "More")}</nav>
    <div class="sb-scroll"><div class="sb-section"><span class="sb-heading static">Captains</span></div>${caps}
      <div class="sb-section"><span class="sb-heading static">People</span></div>
      <div class="sb-row">${icon("hash")}<span>general</span></div>
      <div class="sb-row person"><span class="person-avatar" style="background:hsl(340 62% 52%)">I</span><span class="truncate">Isa</span><span class="sb-meta">Desktop</span></div>
    </div>
    <div class="user-row"><span class="user-avatar">T</span><span class="user-text"><span class="user-name">Tim</span><span class="user-ws">Bouvio</span></span></div>
  </aside>`;
}

const tabbar = (cost = "$0.41") => `<header class="tabbar"><div class="tabs">
  <div class="tab"><div class="tab-main">${avatar(11, 16)}<span class="truncate">Rail shows on hover…</span>${status("working", 12)}</div></div>
  <div class="tab on"><div class="tab-main">${avatar(11, 16)}<span>Desktop</span></div></div></div>
  <div class="tabbar-right"><span class="person-avatar" style="background:hsl(340 62% 52%)">I</span><span class="cost num">${cost}</span></div></header>`;

export const approval = (open = true) => `<div class="approval ${open ? "open" : "allowed"}">
  <div class="approval-head">${icon("shield")}<span>${open ? "Wants to run Bash" : "Allowed by Isa"}</span></div>
  <pre class="approval-detail">pnpm test --filter desktop</pre>
  ${open ? `<div class="approval-actions"><span class="btn ghost">${icon("x", 14)}Deny</span><span class="btn primary">${icon("check", 14)}Allow</span></div>` : ""}
</div>`;

export const spawned = () => `
  <div class="spawned">${status("working", 13)}<span class="truncate">Keep a draft per thread in the composer</span><span class="mono spawned-branch">bouvio/3f9a2c1e</span>${icon("arrow", 13)}</div>
  <div class="spawned">${status("working", 13)}<span class="truncate">Rail shows on hover at the left edge</span><span class="mono spawned-branch">bouvio/7be04d55</span>${icon("arrow", 13)}</div>`;

export function thread({ withApproval = false, withSpawn = true, typing = "" } = {}) {
  return `<div class="thread">
    <div class="msg-user"><div class="bubble">Switching threads wipes what I was typing in the composer. Keep a draft per thread, and check the rail while you're at it.</div></div>
    <div class="steps"><div class="msg-meta">Worked for 4s<span class="dot-sep">2 steps</span></div></div>
    <div class="msg-agent"><div class="md"><p>The draft lived in local component state, so it died with the component. I split this into two threads, each on its own branch:</p></div></div>
    ${withSpawn ? spawned() : ""}
    ${withApproval ? approval(true) : `<div class="msg-agent"><div class="md"><p>The draft thread is done: <code>pnpm typecheck</code> passes and switching threads keeps what you typed.</p></div></div>`}
  </div>
  <div class="composer-wrap"><div class="composer"><div class="cm-text ${typing ? "typing" : ""}" data-type="${typing}">${typing ? "" : '<span class="muted">Reply…</span>'}</div>
    <div class="composer-bar"><span class="icon-btn">${icon("mic")}</span><span class="menu-trigger">✳ Claude Code · Opus</span><span class="menu-trigger">Medium</span><div class="composer-spacer"></div><span class="send">${icon("up", 16, 2.25)}</span></div></div>
    <div class="composer-foot"><span class="runner-pill">${icon("monitor", 13)}This computer<span class="online"></span></span><span class="branch">${icon("branch", 12)}main</span></div></div>`;
}

export function overview() {
  const row = (s, title, meta, when, seed) => `<div class="ov-row">${status(s)}<span class="ov-text"><span class="ov-title truncate">${title}</span><span class="ov-meta truncate">${seed ? avatar(seed, 12) : ""}${meta}</span></span><span class="ov-when">${when}</span></div>`;
  const group = (t, n, rows) => `<div class="group"><div class="group-head"><span>${t}</span><span class="group-count">${n}</span></div>${rows}</div>`;
  return `<div class="overview">
    ${group("Needs you", 2, row("blocked", "Magic link sign-in", "Hub · bouvio/a4410b9f", "12m ago", 37) + row("error", "Diff colors in the dark theme", "Design · bouvio/5d2e7a03", "2h ago", 41))}
    ${group("In progress", 2, row("working", "Rail shows on hover at the left edge", "Desktop · bouvio/7be04d55", "1m ago", 11) + row("working", "Find Codex on the Windows PATH", "Runner · bouvio/c01d9e72", "2m ago", 23))}
    ${group("Recent", 3, row("idle", "Keep a draft per thread in the composer", "Desktop · bouvio/3f9a2c1e", "4m ago", 11) + row("idle", "Resume Claude sessions after a restart", "Runner · main", "55m ago", 23))}
  </div>`;
}

export function panel() {
  return `<section class="panel"><header class="panel-head"><div class="seg"><span class="seg-ind" style="width:84px"></span><span class="seg-btn on">Overview</span><span class="seg-btn">Changes</span><span class="seg-btn">Terminal</span></div></header><div class="panel-body">${overview()}</div></section>`;
}

/** The whole app window: sidebar, a captain's thread, and the overview panel. */
export function windowUI({ approvalCard = false, typing = "" } = {}) {
  return `<div class="win-fit"><div class="win" role="img" aria-label="The Bouvio app with captains, a thread and the overview">${sidebar()}
    <div class="w-sheet"><section class="main">${tabbar()}${thread({ withApproval: approvalCard, typing })}</section>${panel()}</div></div></div>`;
}

export function chat() {
  const msg = (who, color, time, text, extra = "") => `<div class="sc-msg"><span class="person-avatar lg" style="background:${color}">${who[0]}</span><div><div class="sc-meta"><b>${who}</b><span>${time}</span></div><div class="sc-text">${text}</div>${extra}</div></div>`;
  return `<div class="sc">
    ${msg("Isa", "hsl(340 62% 52%)", "10:12", "The rail thread is close. Can someone check it on a small laptop screen?", `<div class="sc-reacts"><span>👀 1</span></div>`)}
    ${msg("Tim", "hsl(12 62% 52%)", "10:14", `<span class="sc-chip">@Desktop</span> check the rail at 1280×720 and fix what overlaps`)}
    <div class="sc-reply">${avatar(11, 18)}<div><div class="sc-meta"><b>Desktop</b><span>10:14</span></div><div class="sc-text">Started <span class="sc-link">Rail at 1280×720</span>. I'll post here when it's done.</div></div></div>
    <div class="sc-reply">${avatar(11, 18)}<div><div class="sc-meta"><b>Desktop</b><span>10:19</span></div><div class="sc-text">Done. The rail tooltip overlapped the sidebar; it now opens to the right. Typecheck passes.</div><div class="sc-reacts"><span>🎉 2</span><span>👍 1</span></div></div></div>
  </div>`;
}

export function huddle() {
  const p = (n, c, on) => `<span class="hd-p ${on ? "speak" : ""}"><span class="person-avatar lg" style="background:${c}">${n}</span></span>`;
  return `<div class="hd">${p("T", "hsl(12 62% 52%)", true)}${p("I", "hsl(340 62% 52%)", false)}${p("N", "hsl(225 62% 52%)", false)}<span class="hd-sep"></span><span class="icon-btn">${icon("mic")}</span><span class="icon-btn">${icon("monitor")}</span><span class="btn small hd-leave">Leave</span></div>`;
}

export function board() {
  const bars = Array.from({ length: 16 }, (_, i) => 20 + ((i * 37) % 60) + i * 1.6);
  const frame = (x, label, kind) => `<div class="bd-frame ${kind}" style="left:${x}px"><div class="bd-label">${icon("branch", 11)}<b>${label}</b><span>/revenue</span></div><div class="bd-body"><div class="bd-k">Revenue, last 30 days</div><div class="bd-v">$1,420,380</div><div class="bd-g">+38.6% vs. previous period</div><div class="bd-chart">${kind === "bars" ? bars.map((h, i) => `<i style="height:${h}%;${i === 15 ? "background:var(--ink)" : ""}"></i>`).join("") : `<svg viewBox="0 0 160 60" preserveAspectRatio="none"><polyline points="${bars.map((h, i) => `${i * 10.6},${60 - h * 0.6}`).join(" ")}" fill="none" stroke="var(--accent)" stroke-width="2"/></svg>`}</div></div></div>`;
  return `<div class="bd">
    <div class="bd-sticky" style="left:30px;top:18px;background:#FCE9A8">Bars for daily, line for the trend<span>Xavier</span></div>
    <div class="bd-sticky" style="left:520px;top:12px;background:#CFE3FB">Top customers next to the chart<span>Jordan</span></div>
    ${frame(24, "Abloh 2", "line")}${frame(330, "Abloh 3", "bars")}
    <div class="bd-cursor" style="left:300px;top:40px;--c:#2F9E5A">${cursorSvg()}<span>Vincent</span></div>
    <div class="bd-cursor" style="left:600px;top:250px;--c:#6553C4">${cursorSvg()}<span>Xavier</span></div>
  </div>`;
}
const cursorSvg = () => `<svg width="16" height="16" viewBox="0 0 16 16"><path d="M2 1l12 6-5.5 1.5L6 14Z" fill="var(--c)" stroke="#fff" stroke-width="1.2" stroke-linejoin="round"/></svg>`;

export function sheet() {
  const rows = [["Category", "Planned", "Actual", "Difference"], ["Hosting", "€40.00", "€36.00", "€4.00"], ["Domains", "€15.00", "€15.00", "€0.00"], ["Design", "€600.00", "€720.00", "−€120.00"], ["Ads", "€300.00", "€180.00", "€120.00"], ["Total", "€955.00", "€951.00", "€4.00"]];
  return `<div class="ss"><div class="ss-bar"><span class="mono">D6</span><span class="ss-fx">fx</span><span class="mono">=SUM(D2:D5)</span></div>
    <table class="ss-grid"><tr><th></th>${["A", "B", "C", "D"].map((c) => `<th>${c}</th>`).join("")}</tr>${rows.map((r, i) => `<tr><th>${i + 1}</th>${r.map((v, j) => `<td class="${i === 0 || i === 5 ? "b" : ""} ${j ? "r" : ""} ${i === 5 && j === 3 ? "on" : ""} ${v.startsWith("−") ? "neg" : ""}">${v}</td>`).join("")}</tr>`).join("")}</table></div>`;
}

export function doc() {
  return `<div class="dc"><h3>Weekly sync</h3><p class="muted">Decisions land here first, issues follow.</p><h4>Action items</h4>
    <label><i class="on">${icon("check", 11, 3)}</i><s>Draft the formula engine tests</s></label>
    <label><i></i>Wire public form submissions through the hub</label>
    <label><i></i>Write the release notes <span class="dc-cursor" style="--c:hsl(340 62% 52%)">Isa</span></label></div>`;
}

export function board_db() {
  const card = (t, tag, c) => `<div class="kb-card">${t}<span class="kb-tag" style="background:${c}">${tag}</span></div>`;
  const col = (name, n, cards) => `<div class="kb-col"><div class="kb-head">${name}<span>${n}</span></div>${cards}</div>`;
  return `<div class="kb">${col("Idea", 2, card("Behind the scenes: the formula engine", "Social", "#F6E2DF") + card("Customer story: a studio of three", "Blog", "#E3ECF7"))}${col("Drafting", 1, card("Monthly update", "Newsletter", "#F3EED9"))}${col("Published", 1, card("Release notes 0.4", "Blog", "#E3ECF7"))}</div>`;
}

export function search() {
  const hit = (ic, title, snip) => `<div class="sr-hit"><span class="sr-ic">${icon(ic, 14)}</span><div><b>${title}</b><p>${snip}</p></div></div>`;
  return `<div class="sr"><div class="sr-input">${icon("search", 16)}<span>draft</span></div>
    ${hit("chat", "Keep a draft per thread in the composer", "Move the composer <mark>draft</mark> into the store, keyed by thread id.")}
    ${hit("issue", "BOU-34 Composer loses the draft", "Composer loses the <mark>draft</mark> when switching threads")}
    ${hit("doc", "Weekly sync", "…the <mark>draft</mark> fix shipped on Tuesday, release notes follow.")}</div>`;
}

export function gitgraph() {
  const rows = [["Widen the rail's hover zone", 11, "Rail shows on hover…", 1], ["Keep a draft per thread", 11, "Keep a draft per…", 2], ["Look for codex.cmd on Windows", 23, "Find Codex on the…", 3], ["Merge pull request #41", 0, "main", 0], ["Resume Claude sessions", 0, "", 0], ["Diff colours in the dark theme", 0, "v0.4.0", 0]];
  const colors = ["var(--accent)", "#2F9E5A", "#C2653A", "#6553C4"];
  return `<div class="gg">${rows.map(([s, seed, ref, lane], i) => `<div class="gg-row"><svg width="64" height="30"><line x1="12" y1="0" x2="12" y2="30" stroke="var(--accent)" stroke-width="2"/>${lane ? `<path d="M12 ${i ? 30 : 15} C12 20 ${12 + lane * 14} 22 ${12 + lane * 14} 15 L${12 + lane * 14} 0" fill="none" stroke="${colors[lane]}" stroke-width="2"/>` : ""}<circle cx="${12 + lane * 14}" cy="15" r="4.5" fill="${colors[lane]}"/></svg>${ref ? `<span class="gg-ref" style="--r:${colors[lane]}">${seed ? avatar(seed, 12) : ""}${ref}</span>` : ""}<span class="truncate">${s}</span></div>`).join("")}</div>`;
}

export function costs() {
  const v = [1.9, 1.6, .3, .2, 2.4, 1.4, 2.4, 1.5, 2.2, .2, .3, 1.9, 1.7, 2.1, 1.3, 2.3, .2, .3, 1.4, 2.3, 1.5, 2.0, 1.8];
  return `<div class="cs"><div class="cs-total"><b>$44</b><span>last 30 days · 400 turns</span></div><div class="cs-bars">${v.map((x) => `<i style="height:${(x / 2.5) * 100}%"></i>`).join("")}</div>
    <div class="cs-rows">${[["Desktop", 11, 17], ["Runner", 23, 12], ["Hub", 37, 7.09]].map(([n, s, d]) => `<div class="cs-row">${avatar(s, 14)}<span>${n}</span><span class="cs-bar"><i style="width:${(d / 17) * 100}%"></i></span><span class="num">$${d}</span></div>`).join("")}
    <div class="cs-row cs-budget"><span>Monthly budget</span><span class="cs-bar"><i style="width:44%"></i></span><span class="num">$44 of $100</span></div></div></div>`;
}

export function localModels() {
  const row = (name, what, state, ok) => `<div class="lm-row"><span class="lm-dot ${ok ? "ok" : ""}"></span><b>${name}</b><span class="muted">${what}</span><span class="lm-state ${ok ? "ok" : ""}">${state}</span></div>`;
  return `<div class="lm">${row("Ollama", "Chat and agents", "qwen3:8b · llama3.2", true)}${row("whisper.cpp", "Voice to text", "base · 142 MB", true)}${row("Piper", "Text to speech", "en_US-lessac", true)}${row("ComfyUI", "Images", "sdxl-turbo", true)}${row("OpenRouter", "Your key", "Key saved", true)}</div>`;
}

export function terminal() {
  return `<pre class="tm"><span class="muted"># on your VPS</span>
docker compose -f apps/hub/compose.yml up -d
bouvio-runner serve --hub https://hub.example.com --token $TOKEN
<span class="ok">bouvio-runner: hosting 2 shared workspaces</span></pre>`;
}

export function inbox() {
  const row = (s, t, m, w) => `<div class="ov-row">${status(s)}<span class="ov-text"><span class="ov-title truncate">${t}</span><span class="ov-meta">${m}</span></span><span class="ov-when">${w}</span></div>`;
  return `<div class="overview">${row("blocked", "Magic link sign-in", "Waiting for your yes · Hub", "12m")}${row("idle", "Isa mentioned you in #general", "“@Tim can you check the rail?”", "20m")}${row("done", "Dependency check finished", "Automation · 3m 12s", "1h")}</div>`;
}

// ---- page chrome ----------------------------------------------------------------------

const REPO = "https://github.com/timvanderwijst/bouvio";
export const nav = () => `<nav class="nav"><div class="wrap nav-in">
  <a class="brand" href="./"><span class="ws-mark">${mark(17)}</span>Bouvio</a>
  <div class="nav-links"><a href="#how">How it works</a><a href="#together">Together</a><a href="#free">Free</a></div>
  <div class="grow"></div>
  <a class="btn ghost" href="${REPO}">${icon("github", 15)}GitHub</a>
  <a class="btn primary" href="${REPO}/releases/latest">Download</a></div></nav>`;
export const foot = () => `<footer class="foot"><div class="wrap foot-in">
  <span class="brand"><span class="ws-mark">${mark(15)}</span>Bouvio</span><span>MIT licensed</span><div class="grow"></div>
  <a href="${REPO}">GitHub</a><a href="${REPO}/blob/main/apps/hub/README.md">Self-host the hub</a><a href="${REPO}/blob/main/docs/plugins.md">Plugins</a></div></footer>`;
export const cta = (second = "Self-host the hub") => `<div class="cta">
  <a class="btn primary lg" href="${REPO}/releases/latest">${icon("download", 16)}Download for Windows</a>
  <a class="btn lg" href="${REPO}/blob/main/apps/hub/README.md">${second}<span class="arrow">${icon("arrow", 15)}</span></a></div>`;

// ---- mount ------------------------------------------------------------------------

const PARTS = { nav, foot, cta: () => cta(), window: windowUI, windowApproval: () => windowUI({ approvalCard: true }), sidebar, thread, overview, approval, spawned, chat, huddle, board, sheet, doc, kanban: board_db, search, gitgraph, costs, localModels, terminal, inbox };

export function mount() {
  document.querySelectorAll("[data-ui]").forEach((el) => {
    const f = PARTS[el.dataset.ui];
    if (f) el.innerHTML = f({ typing: el.dataset.typing ?? "" });
  });
  document.querySelectorAll("[data-icon]").forEach((el) => (el.innerHTML = icon(el.dataset.icon, +(el.dataset.size ?? 15))));
  document.querySelectorAll("[data-mark]").forEach((el) => (el.innerHTML = mark(+(el.dataset.mark || 16))));

  // Scale the app window down to its column.
  // On a phone the window shows only the thread, at a readable size.
  const fit = () => document.querySelectorAll(".win-fit").forEach((f) => {
    const win = f.firstElementChild;
    const s = Math.min(1, f.parentElement.clientWidth / win.offsetWidth);
    f.style.setProperty("--scale", String(s));
    f.style.setProperty("--h", `${win.offsetHeight}px`);
    win.style.setProperty("--scale", String(s));
  });
  fit();
  addEventListener("resize", fit);

  // Type into composers once, the way a person would.
  document.querySelectorAll(".cm-text.typing").forEach((el) => {
    const text = el.dataset.type; let i = 0;
    const tick = () => { el.textContent = text.slice(0, ++i); if (i < text.length) setTimeout(tick, 38 + Math.random() * 50); };
    setTimeout(tick, 900);
  });

  // Sections rise in as they come into view.
  const io = new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && (e.target.classList.add("in"), io.unobserve(e.target))), { rootMargin: "0px 0px -10% 0px" });
  document.querySelectorAll(".reveal").forEach((el) => io.observe(el));
}
