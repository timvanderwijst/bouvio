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
/** The same pixel avatar the app draws for a lead. */
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
  home: "M3 11 12 4l9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1Z",
  inbox: "M22 12h-6l-2 3h-4l-2-3H2M5.5 5h13L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6Z",
  layers: "M12 2 2 7l10 5 10-5ZM2 17l10 5 10-5M2 12l10 5 10-5",
  users: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8",
  sliders: "M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6",
  book: "M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5ZM4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5",
  code: "M16 18l6-6-6-6M8 6l-6 6 6 6",
  chart: "M3 3v18h18M8 17V11M13 17V7M18 17v-4",
  plug: "M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0ZM12 18v4",
  server: "M3 4h18v7H3zM3 13h18v7H3zM7 7.5h.01M7 16.5h.01",
  flask: "M9 3h6M10 3v6L4 19a1.5 1.5 0 0 0 1.3 2h13.4a1.5 1.5 0 0 0 1.3-2L14 9V3",
  clock: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM12 6v6l4 2",
  plus: "M12 5v14M5 12h14",
  folder: "M3 6a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z",
};
export const icon = (n, s = 15, w = 1.75) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${P[n]}"/></svg>`;

export const mark = (s = 16) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="2.5" width="5.5" height="19" rx="2.75" fill="currentColor"/><rect x="4" y="10" width="16" height="11.5" rx="5.75" fill="currentColor" opacity=".55"/></svg>`;

// ---- the project everything shows ----------------------------------------------

// People in the example workspace. Made up.
const PEOPLE = {
  Noor: "hsl(12 62% 52%)",
  Maya: "hsl(340 62% 52%)",
  Daan: "hsl(225 62% 52%)",
  Sam: "hsl(160 50% 38%)",
  Lena: "hsl(268 50% 55%)",
};
const person = (n, cls = "") => `<span class="person-avatar ${cls}" style="background:${PEOPLE[n]}">${n[0]}</span>`;

const LEADS = [
  { name: "Desktop", seed: 11, state: "working", threads: [["Rail shows on hover at the left edge", "working", "1m"], ["Keep a draft per thread in the composer", "idle", "4m"]] },
  { name: "Runner", seed: 23, state: "working" },
  { name: "Hub", seed: 37, badge: 1 },
  { name: "Design", seed: 41, badge: 1 },
  { name: "Docs", seed: 53 },
];

// ---- app parts -------------------------------------------------------------------

/** The app's outer rail, shown open in the picture. */
export function rail() {
  const b = (ic, label, on, badge) => `<span class="w-rail-btn ${on ? "on" : ""}" title="${label}">${icon(ic, 18)}${badge ? `<span class="w-rail-badge">${badge}</span>` : ""}</span>`;
  return `<div class="w-rail"><span class="w-rail-mark">${mark(20)}</span>${b("home", "Home")}${b("inbox", "Inbox", false, 2)}${b("layers", "Workspaces", true)}${b("users", "Team")}<span class="w-rail-gap"></span>${b("sliders", "Settings")}</div>`;
}

export function sidebar({ active = "Desktop", page = null } = {}) {
  const row = (ic, label, on, count) => `<div class="sb-row ${on ? "active" : ""}">${icon(ic)}<span class="truncate">${label}</span>${count ? `<span class="sb-count">${count}</span>` : ""}</div>`;
  const leads = LEADS.map((c) => {
    const on = c.name === active;
    const right = c.badge ? `<span class="badge">${c.badge}</span>` : c.state === "working" ? status("working", 13) : "";
    const kids = on && c.threads
      ? `<div class="lead-threads">${c.threads.map(([t, s, w]) => `<div class="sb-row thread-row nested">${s !== "idle" ? status(s, 12) : ""}<span class="truncate">${t}</span><span class="sb-meta">${w} ago</span></div>`).join("")}</div>`
      : "";
    return `<div class="lead"><div class="sb-row lead-row ${on && !page ? "active" : ""}"><span class="avatar-wrap">${avatar(c.seed)}</span><span class="truncate">${c.name}</span>${right}</div>${kids}</div>`;
  }).join("");
  return `<aside class="sidebar">
    <div class="sb-top"><div class="ws-btn"><span class="ws-mark">${mark(16)}</span><span>Bouvio</span></div><div class="sb-top-actions"><span class="icon-btn">${icon("search")}</span></div></div>
    <nav class="sb-nav">${row("pen", "New thread")}${row("list", "Threads")}${row("chat", "Chat", page === "Chat")}${row("cal", "Planning", page === "Planning", 5)}${row("book", "Library", page === "Library")}${row("studio", "Studio", page === "Studio")}${row("code", "Build")}${row("chart", "Insights")}</nav>
    <div class="sb-scroll"><div class="sb-section"><span class="sb-heading static">Leads</span></div>${leads}
      <div class="sb-section"><span class="sb-heading static">People</span></div>
      <div class="sb-row person">${person("Maya")}<span class="truncate">Maya</span><span class="sb-meta">Desktop</span></div>
    </div>
    <div class="user-row"><span class="user-avatar">N</span><span class="user-text"><span class="user-name">Noor</span><span class="user-ws">Bouvio</span></span></div>
  </aside>`;
}

const tabbar = (cost = "$0.41") => `<header class="tabbar"><div class="tabs">
  <div class="tab"><div class="tab-main">${avatar(11, 16)}<span class="truncate">Rail shows on hover…</span>${status("working", 12)}</div></div>
  <div class="tab on"><div class="tab-main">${avatar(11, 16)}<span>Desktop</span></div></div></div>
  <div class="tabbar-right">${person("Maya")}<span class="cost num">${cost}</span></div></header>`;

export const approval = (open = true) => `<div class="approval ${open ? "open" : "allowed"}">
  <div class="approval-head">${icon("shield")}<span>${open ? "Wants to run Bash" : "Allowed by Maya"}</span></div>
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

/** The whole app window: rail, sidebar, a lead's thread and the overview panel. */
export function windowUI({ approvalCard = false, typing = "" } = {}) {
  return `<div class="win-fit"><div class="win" role="img" aria-label="The Bouvio app with leads, a thread and the overview">${rail()}${sidebar()}
    <div class="w-sheet"><section class="main">${tabbar()}${thread({ withApproval: approvalCard, typing })}</section>${panel()}</div></div></div>`;
}

/** Team chat. The last lead reply is still being typed. */
export function chat() {
  const msg = (who, time, text, extra = "") => `<div class="sc-msg">${person(who, "lg")}<div><div class="sc-meta"><b>${who}</b><span>${time}</span></div><div class="sc-text">${text}</div>${extra}</div></div>`;
  return `<div class="sc">
    ${msg("Maya", "10:12", "The rail thread is close. Can someone check it on a small laptop screen?", `<div class="sc-reacts"><span>👀 1</span></div>`)}
    ${msg("Daan", "10:14", `<span class="sc-chip">@Desktop</span> check the rail at 1280×720 and fix what overlaps`)}
    <div class="sc-reply">${avatar(11, 18)}<div><div class="sc-meta"><b>Desktop</b><span>10:14</span></div><div class="sc-text">Started <span class="sc-link">Rail at 1280×720</span>. I'll post here when it's done.</div></div></div>
    <div class="sc-reply">${avatar(11, 18)}<div><div class="sc-meta"><b>Desktop</b><span>10:19</span></div><div class="sc-text">Done. The rail tooltip overlapped the sidebar, so it now opens to the right. Typecheck passes.</div><div class="sc-reacts"><span>🎉 2</span><span>👍 1</span></div></div></div>
    <div class="sc-reply sc-typing">${avatar(37, 18)}<span class="sc-dots" aria-label="Hub is typing"><i></i><i></i><i></i></span><span class="sc-who">Hub is typing</span></div>
  </div>`;
}

export function huddle() {
  const p = (n, on) => `<span class="hd-p ${on ? "speak" : ""}">${person(n, "lg")}</span>`;
  return `<div class="hd">${p("Daan", true)}${p("Maya")}${p("Noor")}<span class="hd-sep"></span><span class="icon-btn">${icon("mic")}</span><span class="icon-btn">${icon("monitor")}</span><span class="btn small hd-leave">Leave</span></div>`;
}

export function board() {
  const bars = Array.from({ length: 16 }, (_, i) => 20 + ((i * 37) % 60) + i * 1.6);
  const frame = (x, label, kind) => `<div class="bd-frame ${kind}" style="left:${x}px"><div class="bd-label">${icon("branch", 11)}<b>${label}</b><span>/revenue</span></div><div class="bd-body"><div class="bd-k">Revenue, last 30 days</div><div class="bd-v">$1,420,380</div><div class="bd-g">+38.6% vs. previous period</div><div class="bd-chart">${kind === "bars" ? bars.map((h, i) => `<i style="height:${h}%;${i === 15 ? "background:#1b1b1a" : ""}"></i>`).join("") : `<svg viewBox="0 0 160 60" preserveAspectRatio="none"><polyline points="${bars.map((h, i) => `${i * 10.6},${60 - h * 0.6}`).join(" ")}" fill="none" stroke="#2F6FEB" stroke-width="2"/></svg>`}</div></div></div>`;
  return `<div class="win-fit bd-fit"><div class="bd">
    <div class="bd-sticky" style="left:30px;top:18px;background:#FCE9A8">Bars for daily, line for the trend<span>Sam</span></div>
    <div class="bd-sticky" style="left:520px;top:12px;background:#CFE3FB">Top customers next to the chart<span>Lena</span></div>
    ${frame(24, "Variant A", "line")}${frame(330, "Variant B", "bars")}
    <div class="bd-cursor" style="left:300px;top:40px;--c:#2F9E5A">${cursorSvg()}<span>Sam</span></div>
    <div class="bd-cursor" style="left:600px;top:250px;--c:#6553C4">${cursorSvg()}<span>Lena</span></div>
  </div></div>`;
}
const cursorSvg = () => `<svg width="16" height="16" viewBox="0 0 16 16"><path d="M2 1l12 6-5.5 1.5L6 14Z" fill="var(--c)" stroke="#fff" stroke-width="1.2" stroke-linejoin="round"/></svg>`;

export function sheet() {
  const rows = [["Category", "Planned", "Actual", "Difference"], ["Hosting", "€40.00", "€36.00", "€4.00"], ["Domains", "€15.00", "€15.00", "€0.00"], ["Design", "€600.00", "€720.00", "−€120.00"], ["Ads", "€300.00", "€180.00", "€120.00"], ["Total", "€955.00", "€951.00", "€4.00"]];
  return `<div class="ss"><div class="ss-bar"><span class="mono">D6</span><span class="ss-fx">fx</span><span class="mono">=SUM(D2:D5)</span></div>
    <div class="ss-scroll"><table class="ss-grid"><tr><th></th>${["A", "B", "C", "D"].map((c) => `<th>${c}</th>`).join("")}</tr>${rows.map((r, i) => `<tr><th>${i + 1}</th>${r.map((v, j) => `<td class="${i === 0 || i === 5 ? "b" : ""} ${j ? "r" : ""} ${i === 5 && j === 3 ? "on" : ""} ${v.startsWith("−") ? "neg" : ""}">${v}</td>`).join("")}</tr>`).join("")}</table></div></div>`;
}

export function doc() {
  return `<div class="dc"><h3>Weekly sync</h3><p class="muted">Decisions land here first, issues follow.</p><h4>Action items</h4>
    <label><i class="on">${icon("check", 11, 3)}</i><s>Draft the formula engine tests</s></label>
    <label><i></i>Wire public form submissions through the hub</label>
    <label><i></i>Write the release notes <span class="dc-cursor" style="--c:${PEOPLE.Maya}" data-name="Maya"></span></label></div>`;
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
    ${hit("doc", "Weekly sync", "…the <mark>draft</mark> fix shipped on Tuesday, release notes follow.")}
    ${hit("folder", "research/drafts-in-editors.pdf", "Imported PDF, page 4: how editors keep a <mark>draft</mark> per tab.")}</div>`;
}

export function issues() {
  const row = (s, id, t, seed, lead, label) => `<div class="is-row">${status(s)}<span class="mono is-id">${id}</span><span class="truncate is-t">${t}</span><span class="is-label">${label}</span><span class="is-lead">${avatar(seed, 14)}<span>${lead}</span></span></div>`;
  return `<div class="is">${row("working", "BOU-41", "Rail shows on hover at the left edge", 11, "Desktop", "UI")}${row("blocked", "BOU-38", "Magic link sign-in", 37, "Hub", "Auth")}${row("idle", "BOU-34", "Composer loses the draft when switching threads", 11, "Desktop", "Bug")}${row("idle", "BOU-29", "Find Codex on the Windows PATH", 23, "Runner", "Windows")}${row("done", "BOU-22", "Resume Claude sessions after a restart", 23, "Runner", "Runner")}</div>`;
}

export function prs() {
  const row = (n, t, br, checks, state, cls) => `<div class="pr-row"><span class="pr-ic ${cls}">${icon("pr", 15)}</span><span class="pr-text"><span class="truncate"><b>#${n}</b> ${t}</span><span class="mono pr-br truncate">${br}</span></span><span class="pr-checks">${checks}</span><span class="pr-state ${cls}">${state}</span></div>`;
  return `<div class="pr">${row(44, "Keep a draft per thread", "bouvio/3f9a2c1e → main", "✓ 3/3", "Ready", "ok")}${row(43, "Rail shows on hover", "bouvio/7be04d55 → main", "● 1/3", "Checks", "run")}${row(42, "Look for codex.cmd on Windows", "bouvio/c01d9e72 → main", "✓ 3/3", "Merged", "merged")}</div>`;
}

export function calendar() {
  const days = ["Mon 17", "Tue 18", "Wed 19", "Thu 20", "Fri 21"];
  const ev = { 0: [["08:30", "Dependency check", "auto"], ["10:00", "Weekly sync", "team"]], 1: [["14:00", "Design review", "team"]], 2: [["08:30", "Dependency check", "auto"], ["16:00", "Hub on staging", "agent"]], 3: [["11:00", "Planning", "team"]], 4: [["08:30", "Dependency check", "auto"], ["15:00", "Release 0.5", "agent"]] };
  return `<div class="cal">${days.map((d, i) => `<div class="cal-day ${i === 2 ? "today" : ""}"><div class="cal-d">${d}</div>${(ev[i] || []).map(([t, n, k]) => `<div class="cal-ev ${k}"><span class="mono">${t}</span>${n}</div>`).join("")}</div>`).join("")}</div>`;
}

export function gitgraph() {
  const rows = [["Widen the rail's hover zone", 11, "Rail shows on hover…", 1], ["Keep a draft per thread", 11, "Keep a draft per…", 2], ["Look for codex.cmd on Windows", 23, "Find Codex on the…", 3], ["Merge pull request #41", 0, "main", 0], ["Resume Claude sessions", 0, "", 0], ["Diff colours in the dark theme", 0, "v0.4.0", 0]];
  const colors = ["var(--accent)", "#2F9E5A", "#C2653A", "#6553C4"];
  return `<div class="gg">${rows.map(([s, seed, ref, lane], i) => `<div class="gg-row"><svg width="64" height="30" aria-hidden="true"><line x1="12" y1="0" x2="12" y2="30" stroke="var(--accent)" stroke-width="2"/>${lane ? `<path d="M12 ${i ? 30 : 15} C12 20 ${12 + lane * 14} 22 ${12 + lane * 14} 15 L${12 + lane * 14} 0" fill="none" stroke="${colors[lane]}" stroke-width="2"/>` : ""}<circle cx="${12 + lane * 14}" cy="15" r="4.5" fill="${colors[lane]}"/></svg>${ref ? `<span class="gg-ref" style="--r:${colors[lane]}">${seed ? avatar(seed, 12) : ""}${ref}</span>` : ""}<span class="truncate">${s}</span></div>`).join("")}</div>`;
}

export function costs() {
  const v = [1.9, 1.6, .3, .2, 2.4, 1.4, 2.4, 1.5, 2.2, .2, .3, 1.9, 1.7, 2.1, 1.3, 2.3, .2, .3, 1.4, 2.3, 1.5, 2.0, 1.8];
  return `<div class="cs"><div class="cs-total"><b>$44</b><span>last 30 days · 400 turns</span></div><div class="cs-bars grow-y">${v.map((x, i) => `<i style="height:${(x / 2.5) * 100}%;--i:${i}"></i>`).join("")}</div>
    <div class="cs-rows">${[["Desktop", 11, 17], ["Runner", 23, 12], ["Hub", 37, 7.09]].map(([n, s, d]) => `<div class="cs-row">${avatar(s, 14)}<span>${n}</span><span class="cs-bar"><i style="width:${(d / 17) * 100}%"></i></span><span class="num">$${d}</span></div>`).join("")}
    <div class="cs-row cs-budget"><span>Monthly budget</span><span class="cs-bar"><i style="width:44%"></i></span><span class="num">$44 of $100</span></div></div></div>`;
}

/** Evals: the same task set, run against each model. */
export function evals() {
  const rows = [["Claude Code · Opus", 92], ["Claude Code · Sonnet", 88], ["Codex", 85], ["qwen3:8b · local", 61]];
  return `<div class="ev"><div class="ev-head"><span>Composer fixes</span><span class="mono">24 tasks</span></div>${rows.map(([n, p], i) => `<div class="ev-row"><span class="truncate">${n}</span><span class="ev-bar grow-x"><i style="width:${p}%;--i:${i}"></i></span><span class="num">${p}%</span></div>`).join("")}</div>`;
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

export function devTerminal() {
  return `<pre class="tm"><span class="muted">~/bouvio $</span> pnpm test --filter desktop
 <span class="ok">✓</span> composer keeps a draft per thread
 <span class="ok">✓</span> rail opens at the left edge
 <span class="ok">✓</span> tooltip stays inside the window
<span class="ok">Tests  3 passed</span>
<span class="muted">~/bouvio $</span> pnpm dev
<span class="muted">Preview at</span> http://localhost:5173</pre>`;
}

export function automations() {
  const row = (ic, when, what) => `<div class="au-row"><span class="sr-ic">${icon(ic, 14)}</span><span class="au-text"><b>${when}</b><span>${what}</span></span></div>`;
  return `<div class="au">${row("clock", "Every weekday at 08:30", "Runner checks dependencies and opens a PR")}${row("issue", "An issue gets the label bug", "The lead for that area starts a thread")}${row("pr", "A pull request opens", "Design reviews the screenshots")}</div>`;
}

export function integrations() {
  const row = (n, what, on) => `<div class="lm-row"><span class="lm-dot ${on ? "ok" : ""}"></span><b>${n}</b><span class="lm-state ${on ? "ok" : ""}">${what}</span></div>`;
  return `<div class="lm">${row("GitHub", "MCP · installed", true)}${row("Postgres", "MCP · installed", true)}${row("Playwright", "MCP · installed", true)}${row("frontend-design", "Skill", true)}${row("Sentry", "From the registry", false)}</div>`;
}

export function inbox() {
  const row = (s, t, m, w) => `<div class="ov-row">${status(s)}<span class="ov-text"><span class="ov-title truncate">${t}</span><span class="ov-meta truncate">${m}</span></span><span class="ov-when">${w}</span></div>`;
  return `<div class="overview">${row("blocked", "Magic link sign-in", "Waiting for your yes · Hub", "12m")}${row("idle", "Maya mentioned you in #general", "“@Noor can you check the rail?”", "20m")}${row("done", "Dependency check finished", "Automation · 3m 12s", "1h")}</div>`;
}

export function myWork() {
  const row = (done, t, due) => `<label class="mw-row"><i class="${done ? "on" : ""}">${done ? icon("check", 11, 3) : ""}</i><span class="truncate ${done ? "mw-done" : ""}">${t}</span><span class="mw-due ${due === "Today" ? "now" : ""}">${due}</span></label>`;
  return `<div class="mw">${row(true, "Approve the rail PR", "Today")}${row(false, "Answer Hub about magic links", "Today")}${row(false, "Write the release notes", "Fri")}</div>`;
}

export function people() {
  const row = (n, role, note) => `<div class="pp-row">${person(n)}<span class="pp-name">${n}<span>${note}</span></span><span class="pp-role">${role}</span></div>`;
  return `<div class="pp">${row("Noor", "Owner", "Everything")}${row("Daan", "Operator", "Starts agents")}${row("Maya", "Prompter", "Talks to agents")}${row("Sam", "Viewer", "Watches")}</div>`;
}

export function machines() {
  const row = (ic, n, what, state, on) => `<div class="lm-row"><span class="lm-dot ${on ? "ok" : ""}"></span><b>${n}</b><span class="muted">${what}</span><span class="lm-state ${on ? "ok" : ""}">${state}</span></div>`;
  return `<div class="lm">${row("monitor", "This computer", "Windows", "2 threads", true)}${row("server", "VPS", "Linux · €4 a month", "Online", true)}${row("monitor", "Daan's laptop", "macOS", "Asleep", false)}</div>`;
}

/** A task's life, as a dotted timeline. */
export function timeline() {
  const steps = [["09:02", "Issue", "Maya files BOU-34: the composer loses the draft."], ["09:03", "Lead", "Desktop picks it up and starts a thread on its own branch."], ["09:11", "Approval", "It asks to run the tests. Daan says yes."], ["09:14", "Pull request", "#44 opens with the diff and a passing check."], ["09:20", "Merged", "Noor merges it from the app."]];
  return `<ol class="tl">${steps.map(([t, h, p], i) => `<li style="--i:${i}"><span class="mono tl-t">${t}</span><b>${h}</b><p>${p}</p></li>`).join("")}</ol>`;
}

const MODELS = ["Claude Code", "Codex", "Opus", "Sonnet", "Haiku", "GPT", "Gemini", "Llama", "Qwen", "Mistral", "DeepSeek", "Ollama", "OpenRouter", "whisper.cpp", "Piper", "ComfyUI"];
const TOOLS = ["GitHub", "Postgres", "Playwright", "Filesystem", "Sentry", "Figma", "Notion", "Slack", "Google Drive", "Stripe", "Brave Search", "Skills", "CalDAV", "IMAP mail"];
export function marquees() {
  const lane = (items, rev) => `<div class="mq-lane ${rev ? "rev" : ""}"><div class="mq-track">${[...items, ...items].map((x, i) => `<span class="mq-item" ${i >= items.length ? 'aria-hidden="true"' : ""}>${x}</span>`).join("")}</div></div>`;
  return `<div class="mq">${lane(MODELS)}${lane(TOOLS, true)}</div>`;
}

// ---- page chrome ----------------------------------------------------------------------

const REPO = "https://github.com/timvanderwijst/bouvio";
const LINKS = [["agents", "Agents"], ["team", "Team"], ["work", "Work"], ["studio", "Studio"], ["build", "Build"], ["free", "Free"]];
export const nav = () => `<nav class="nav" data-nav><div class="nav-in">
  <a class="brand" href="#top"><span class="ws-mark">${mark(17)}</span>Bouvio</a>
  <div class="nav-links" data-links>${LINKS.map(([id, l]) => `<a href="#${id}" data-to="${id}">${l}</a>`).join("")}<i class="nav-ind" data-ind></i></div>
  <div class="grow"></div>
  <a class="btn ghost nav-gh" href="${REPO}">${icon("github", 15)}GitHub</a>
  <a class="btn primary" href="${REPO}/releases/latest">Download</a></div></nav>`;
export const foot = () => `<footer class="foot">
  <div class="wrap foot-cols">
    <div><h6>Product</h6><a href="${REPO}/releases/latest">Download</a><a href="#agents">Agents</a><a href="#work">Docs and planning</a><a href="#studio">Studio</a></div>
    <div><h6>Self-host</h6><a href="${REPO}/blob/main/apps/hub/README.md">Run the hub</a><a href="#free">Local models</a><a href="#build">Runners</a></div>
    <div><h6>Build on it</h6><a href="${REPO}/blob/main/docs/plugins.md">Plugins</a><a href="${REPO}">Source code</a><a href="${REPO}/issues">Issues</a></div>
    <div><h6>Bouvio</h6><span>Free and open source</span><span>MIT licensed</span><span>Windows, macOS, Linux</span></div>
  </div>
  <div class="foot-wm" aria-hidden="true">bouvio</div>
  <div class="wrap foot-bt"><span>© Bouvio contributors</span><span>Your keys, your machines</span></div>
</footer>`;
export const cta = (second = "Self-host the hub") => `<div class="cta">
  <a class="btn primary lg" href="${REPO}/releases/latest">${icon("download", 16)}Download for Windows</a>
  <a class="btn lg" href="${REPO}/blob/main/apps/hub/README.md">${second}<span class="arrow">${icon("arrow", 15)}</span></a></div>`;

// ---- mount ------------------------------------------------------------------------

const PARTS = { nav, foot, cta: () => cta(), window: windowUI, windowApproval: () => windowUI({ approvalCard: true }), rail, sidebar, thread: () => thread(), overview, approval, approvalDone: () => approval(false), spawned, chat, huddle, board, sheet, doc, kanban: board_db, search, issues, prs, calendar, gitgraph, costs, evals, localModels, terminal, devTerminal, automations, integrations, inbox, myWork, people, machines, timeline, marquees };

const still = matchMedia("(prefers-reduced-motion: reduce)").matches;

export function mount() {
  document.querySelectorAll("[data-ui]").forEach((el) => {
    const f = PARTS[el.dataset.ui];
    if (f) el.innerHTML = f({ typing: el.dataset.typing ?? "" });
  });
  document.querySelectorAll("[data-icon]").forEach((el) => (el.innerHTML = icon(el.dataset.icon, +(el.dataset.size ?? 15))));
  document.querySelectorAll("[data-mark]").forEach((el) => (el.innerHTML = mark(+(el.dataset.mark || 16))));

  // Scale the app window down to its column.
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
    if (still) { el.textContent = text; return; }
    const tick = () => { el.textContent = text.slice(0, ++i); if (i < text.length) setTimeout(tick, 38 + Math.random() * 50); };
    setTimeout(tick, 1400);
  });

  splitWords();
  navBehaviour();
  fillStatement();
  stage();
  tabs();
  onView("[data-count]", countUp);
  onView(".grow-x, .grow-y, .tl", (el) => el.classList.add("play"));
}

/** Run once when an element scrolls into view. */
function onView(sel, fn) {
  const io = new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && (fn(e.target), io.unobserve(e.target))), { rootMargin: "0px 0px -12% 0px" });
  document.querySelectorAll(sel).forEach((el) => io.observe(el));
}

// Headline: each word rises out of a mask, 45 ms after the last.
function splitWords() {
  document.querySelectorAll("[data-split]").forEach((h) => {
    let i = 0;
    const walk = (node) => [...node.childNodes].forEach((n) => {
      if (n.nodeType === 3) {
        const frag = document.createDocumentFragment();
        n.textContent.split(/(\s+)/).forEach((w) => {
          if (!w) return;
          if (/^\s+$/.test(w)) return frag.append(w);
          const o = document.createElement("span"); o.className = "sw";
          const inner = document.createElement("span"); inner.textContent = w; inner.style.setProperty("--i", String(i++));
          o.append(inner); frag.append(o);
        });
        n.replaceWith(frag);
      } else walk(n);
    });
    walk(h);
    h.classList.add("is-split");
  });
}

// Glass nav: narrows after the hero; a line slides to the section you're in.
function navBehaviour() {
  const navEl = document.querySelector("[data-nav]");
  if (!navEl) return;
  const onScroll = () => navEl.classList.toggle("small", scrollY > 40);
  onScroll();
  addEventListener("scroll", onScroll, { passive: true });

  const links = [...navEl.querySelectorAll("[data-to]")];
  const ind = navEl.querySelector("[data-ind]");
  const move = (a) => {
    links.forEach((l) => l.classList.toggle("on", l === a));
    if (!a) { ind.style.opacity = "0"; return; }
    ind.style.opacity = "1";
    ind.style.transform = `translateX(${a.offsetLeft}px)`;
    ind.style.width = `${a.offsetWidth}px`;
  };
  const sections = links.map((l) => document.getElementById(l.dataset.to)).filter(Boolean);
  const pick = () => {
    const y = innerHeight * 0.4;
    let cur = null;
    sections.forEach((s) => { if (s.getBoundingClientRect().top <= y) cur = s; });
    move(cur ? links.find((l) => l.dataset.to === cur.id) : null);
  };
  pick();
  addEventListener("scroll", pick, { passive: true });
  addEventListener("resize", pick);
}

// Statement: words colour in as you scroll past.
function fillStatement() {
  document.querySelectorAll("[data-fill]").forEach((p) => {
    const words = p.textContent.trim().split(/\s+/);
    p.innerHTML = words.map((w) => `<span>${w}</span>`).join(" ");
    const spans = [...p.children];
    if (still) { spans.forEach((s) => s.classList.add("on")); return; }
    const run = () => {
      const r = p.getBoundingClientRect();
      const prog = Math.min(1, Math.max(0, (innerHeight * 0.85 - r.top) / (r.height + innerHeight * 0.35)));
      const n = Math.round(prog * spans.length);
      spans.forEach((s, i) => s.classList.toggle("on", i < n));
    };
    run();
    addEventListener("scroll", run, { passive: true });
  });
}

// Numbers count up to their value and ease out.
function countUp(el) {
  const to = +el.dataset.count;
  if (still) return;
  const t0 = performance.now(), dur = 1200;
  const step = (t) => {
    const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
    el.textContent = String(Math.round(to * e));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// Stage: the panel stays put, and each new screen wipes over the last one.
function stage() {
  document.querySelectorAll("[data-stage]").forEach((st) => {
    const steps = [...st.querySelectorAll("[data-step]")];
    const scrs = [...st.querySelectorAll("[data-scr]")];
    let cur = 0;
    const show = (i) => {
      if (i === cur) return;
      scrs.forEach((s) => s.classList.remove("was"));
      scrs[cur].classList.replace("on", "was");
      scrs[i].classList.add("on");
      steps.forEach((s, j) => s.classList.toggle("on", j === i));
      cur = i;
    };
    const io = new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && show(steps.indexOf(e.target))), { rootMargin: "-45% 0px -45% 0px" });
    steps.forEach((s) => io.observe(s));
  });
}

// Tabs: the line slides to the chosen tab and the panel follows.
function tabs() {
  document.querySelectorAll("[data-tabs]").forEach((box) => {
    const btns = [...box.querySelectorAll("[role=tab]")];
    const panes = [...box.querySelectorAll("[role=tabpanel]")];
    const ind = box.querySelector("[data-ind]");
    const pick = (i, focus) => {
      btns.forEach((b, j) => { b.setAttribute("aria-selected", String(i === j)); b.tabIndex = i === j ? 0 : -1; });
      panes.forEach((p, j) => { p.classList.toggle("off", i !== j); p.inert = i !== j; p.setAttribute("aria-hidden", String(i !== j)); });
      ind.style.transform = `translateX(${btns[i].offsetLeft}px)`;
      ind.style.width = `${btns[i].offsetWidth}px`;
      if (focus) btns[i].focus();
    };
    btns.forEach((b, i) => {
      b.addEventListener("click", () => pick(i));
      b.addEventListener("keydown", (e) => {
        if (e.key === "ArrowRight") pick((i + 1) % btns.length, true);
        if (e.key === "ArrowLeft") pick((i - 1 + btns.length) % btns.length, true);
      });
    });
    pick(0);
    addEventListener("resize", () => pick(btns.findIndex((b) => b.getAttribute("aria-selected") === "true")));
  });
}
