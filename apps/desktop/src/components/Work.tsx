import { ArrowUpRight, Check, CircleDashed, GitMerge, GitPullRequest, GitPullRequestDraft, Pause, Play, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { backend } from "../backend";
import { useT } from "../i18n";
import type { Issue } from "../protocol/Issue";
import type { IssueStatus } from "../protocol/IssueStatus";
import type { Thread } from "../protocol/Thread";
import { rpc, useStore, useWorkspaceCaptains, useWorkspaceThreads, useWsData } from "../store";
import { ago } from "../lib/format";
import { Empty } from "./Panel";
import { Menu } from "./Menu";
import { PixelAvatar } from "./PixelAvatar";
import { StatusIcon } from "./StatusIcon";

const ORDER: IssueStatus[] = ["in_progress", "todo", "backlog", "done", "canceled"];

export function IssueIcon({ status, size = 14 }: { status: IssueStatus; size?: number }) {
  const r = 5.25;
  const c = 2 * Math.PI * r;
  const frac = status === "in_progress" ? 0.5 : status === "done" ? 1 : 0;
  return (
    <svg className={`issue-icon is-${status}`} width={size} height={size} viewBox="0 0 14 14" aria-hidden>
      {status === "backlog" ? (
        <circle cx="7" cy="7" r={r} fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="1.6 1.9" />
      ) : status === "canceled" ? (
        <>
          <circle cx="7" cy="7" r="6" fill="currentColor" />
          <path d="M5 5l4 4M9 5l-4 4" stroke="var(--sheet)" strokeWidth="1.4" strokeLinecap="round" />
        </>
      ) : status === "done" ? (
        <>
          <circle cx="7" cy="7" r="6" fill="currentColor" />
          <path d="M4.4 7.2l1.8 1.8 3.5-3.6" fill="none" stroke="var(--sheet)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </>
      ) : (
        <>
          <circle cx="7" cy="7" r={r} fill="none" stroke="currentColor" strokeWidth="1.5" />
          {frac > 0 && <circle cx="7" cy="7" r={r / 2} fill="none" stroke="currentColor" strokeWidth={r} strokeDasharray={`${(c / 2) * frac} ${c}`} transform="rotate(-90 7 7)" />}
        </>
      )}
    </svg>
  );
}

export function IssuesPage() {
  const t = useT();
  const load = useStore((s) => s.load);
  const data = useWsData();
  const setDialog = useStore((s) => s.setDialog);
  const notify = useStore((s) => s.notify);
  const [filter, setFilter] = useState<"active" | "backlog" | "done">("active");
  const [open, setOpen] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  useEffect(() => {
    load("issues");
    load("settings");
  }, [load]);
  const issues = data.issues ?? [];
  const shown = issues.filter((i) => (filter === "active" ? i.status === "todo" || i.status === "in_progress" : filter === "backlog" ? i.status === "backlog" : i.status === "done" || i.status === "canceled"));
  const groups = ORDER.map((s) => ({ s, items: shown.filter((i) => i.status === s) })).filter((g) => g.items.length);
  const selected = issues.find((i) => i.id === open) ?? null;

  const sync = async () => {
    setSyncing(true);
    try {
      const n = await rpc<number>("sync_github_issues", { workspace_id: useStore.getState().workspaceId });
      notify(t("issues.synced", { count: n }));
      load("issues", true);
    } catch (e) {
      notify(String(e));
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className={`page wide split ${selected ? "with-detail" : ""}`}>
      <div className="split-main">
        <div className="page-head">
          <h1 className="page-title">{t("ws.issues")}</h1>
          <div className="choice small">
            {(["active", "backlog", "done"] as const).map((f) => (
              <button key={f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>
                {t(`issues.${f}`)}
              </button>
            ))}
          </div>
          <div className="page-actions">
            {data.settings?.github_repo && (
              <button className={`btn ghost ${syncing ? "spin-icon" : ""}`} onClick={sync} disabled={syncing} title={data.settings.github_repo}>
                <RefreshCw size={14} />
                GitHub
              </button>
            )}
            <button className="btn primary" onClick={() => setDialog("issue")}>
              <Plus size={14} />
              {t("issues.new")}
            </button>
          </div>
        </div>
        {groups.length === 0 && <Empty text={t("issues.none")} />}
        {groups.map((g) => (
          <div key={g.s} className="issue-group">
            <div className="group-head static">
              <IssueIcon status={g.s} />
              <span>{t(`issue.${g.s}`)}</span>
              <span className="group-count">{g.items.length}</span>
            </div>
            {g.items.map((i) => (
              <IssueRow key={i.id} issue={i} on={open === i.id} onOpen={() => setOpen(open === i.id ? null : i.id)} />
            ))}
          </div>
        ))}
      </div>
      {selected && <IssueDetail key={selected.id} issue={selected} onClose={() => setOpen(null)} />}
    </div>
  );
}

function IssueRow({ issue, on, onOpen }: { issue: Issue; on: boolean; onOpen: () => void }) {
  const captains = useWorkspaceCaptains();
  const c = captains.find((x) => x.id === issue.captain_id);
  const threads = useStore((s) => (s.workspaceId ? s.threads[s.workspaceId] : undefined));
  const working = issue.thread_ids.some((id) => threads?.find((t) => t.id === id)?.status === "working");
  return (
    <button className={`list-row issue-row ${on ? "on" : ""}`} onClick={onOpen}>
      <span className="mono issue-key">{issue.key}</span>
      <IssueIcon status={issue.status} />
      <span className="truncate list-title">{issue.title}</span>
      {working && <StatusIcon status="working" size={13} />}
      {issue.github_number && <span className="list-meta mono">#{issue.github_number}</span>}
      {c && (
        <span className="list-meta">
          <PixelAvatar seed={c.avatar_seed} size={14} />
          {c.name}
        </span>
      )}
      <span className="list-meta when">{ago(issue.updated_at)}</span>
    </button>
  );
}

function IssueDetail({ issue, onClose }: { issue: Issue; onClose: () => void }) {
  const t = useT();
  const captains = useWorkspaceCaptains();
  const openThread = useStore((s) => s.openThread);
  const notify = useStore((s) => s.notify);
  const threads = useWorkspaceThreads();
  const [title, setTitle] = useState(issue.title);
  const [body, setBody] = useState(issue.body);
  const [busy, setBusy] = useState(false);
  const save = (p: Partial<Issue>) => rpc("update_issue", { issue: { ...issue, title, body, ...p } }).catch((e) => notify(String(e)));
  const linked = issue.thread_ids.map((id) => threads.find((x) => x.id === id)).filter(Boolean) as Thread[];

  return (
    <aside className="detail">
      <div className="detail-head">
        <span className="mono issue-key">{issue.key}</span>
        <div className="composer-spacer" />
        <button
          className="icon-btn"
          title={t("common.delete")}
          onClick={async () => {
            await rpc("delete_issue", { id: issue.id });
            onClose();
          }}
        >
          <Trash2 size={14} />
        </button>
      </div>
      <textarea className="detail-title" rows={2} value={title} onChange={(e) => setTitle(e.target.value.replace(/\n/g, " "))} onBlur={() => title !== issue.title && save({})} />
      <textarea className="detail-body" value={body} placeholder={t("issues.bodyHint")} onChange={(e) => setBody(e.target.value)} onBlur={() => body !== issue.body && save({})} />
      <div className="detail-props">
        <span>{t("issues.status")}</span>
        <Menu
          value={issue.status}
          items={ORDER.map((s) => ({ value: s, label: t(`issue.${s}`), icon: <IssueIcon status={s} /> }))}
          onChange={(s) => save({ status: s })}
        />
        <span>{t("issues.captain")}</span>
        <Menu
          value={issue.captain_id}
          items={[{ value: null, label: t("issues.noCaptain") }, ...captains.map((c) => ({ value: c.id as string | null, label: c.name, icon: <PixelAvatar seed={c.avatar_seed} size={14} /> }))]}
          onChange={(c) => save({ captain_id: c })}
        />
      </div>
      <button
        className="btn primary block"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            const th = await rpc<Thread>("start_issue", { id: issue.id, captain_id: issue.captain_id });
            await useStore.getState().openThread(th.id);
          } catch (e) {
            notify(String(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Play size={14} />
        {t("issues.start")}
      </button>
      {linked.length > 0 && (
        <div className="detail-links">
          {linked.map((th) => (
            <button key={th.id} className="ov-row" onClick={() => openThread(th.id)}>
              <StatusIcon status={th.status} />
              <span className="ov-text">
                <span className="ov-title truncate">{th.title}</span>
                <span className="ov-meta mono">{th.branch}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </aside>
  );
}

export function PullRequestsPage() {
  const t = useT();
  const load = useStore((s) => s.load);
  const data = useWsData();
  const notify = useStore((s) => s.notify);
  const [busy, setBusy] = useState<number | null>(null);
  useEffect(() => {
    load("prs");
  }, [load]);
  const prs = data.prs;
  return (
    <div className="page wide">
      <div className="page-head">
        <h1 className="page-title">{t("ws.pullRequests")}</h1>
        <div className="page-actions">
          <button className="icon-btn" onClick={() => load("prs", true)} title={t("panel.refresh")}>
            <RefreshCw size={14} />
          </button>
        </div>
      </div>
      {prs && prs.length === 0 && <Empty text={t("prs.none")} />}
      <div className="list">
        {prs?.map((p) => {
          const Icon = p.state === "merged" ? GitMerge : p.draft ? GitPullRequestDraft : GitPullRequest;
          return (
            <div key={p.number} className="list-row pr-row">
              <Icon size={15} className={`pr-${p.state}${p.draft ? " pr-draft" : ""}`} />
              <span className="mono list-meta">#{p.number}</span>
              <span className="truncate list-title">{p.title}</span>
              <span className="list-meta mono truncate">
                {p.base} ← {p.head}
              </span>
              <span className="add">+{p.additions}</span>
              <span className="del">−{p.deletions}</span>
              <span className="list-meta">{p.author}</span>
              {p.state === "open" && !p.draft && (
                <button
                  className="btn small"
                  disabled={busy === p.number}
                  onClick={async () => {
                    setBusy(p.number);
                    try {
                      await rpc("merge_pull_request", { workspace_id: useStore.getState().workspaceId, number: p.number });
                      load("prs", true);
                    } catch (e) {
                      notify(String(e));
                    } finally {
                      setBusy(null);
                    }
                  }}
                >
                  <GitMerge size={13} />
                  {t("prs.merge")}
                </button>
              )}
              <button className="icon-btn" onClick={() => backend.openUrl(p.url)} title={t("prs.open")}>
                <ArrowUpRight size={14} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** "0 8 * * 1-5" → "08:00 · Mon–Fri", for the common shapes; the raw cron otherwise. */
export function describeCron(cron: string, lang: string): string {
  const [m, h, dom, mon, dow] = cron.trim().split(/\s+/);
  if (/^\d+$/.test(m ?? "") && h === "*" && dom === "*" && mon === "*" && dow === "*") return lang === "nl" ? `elk uur om :${m.padStart(2, "0")}` : `every hour at :${m.padStart(2, "0")}`;
  if (!/^\d+$/.test(m ?? "") || !/^\d+$/.test(h ?? "") || dom !== "*" || mon !== "*") return cron;
  const time = `${h.padStart(2, "0")}:${m.padStart(2, "0")}`;
  const days = new Intl.DateTimeFormat(lang, { weekday: "short" });
  const name = (d: number) => days.format(new Date(2024, 0, 7 + d));
  let when = "";
  if (dow === "*") when = lang === "nl" ? "elke dag" : "every day";
  else if (/^\d-\d$/.test(dow)) when = `${name(+dow[0])}–${name(+dow[2])}`;
  else if (/^\d(,\d)*$/.test(dow)) when = dow.split(",").map((d) => name(+d)).join(", ");
  else return cron;
  return `${time} · ${when}`;
}

export function AutomationsPage() {
  const t = useT();
  const load = useStore((s) => s.load);
  const data = useWsData();
  const captains = useWorkspaceCaptains();
  const setDialog = useStore((s) => s.setDialog);
  const notify = useStore((s) => s.notify);
  const openThread = useStore((s) => s.openThread);
  useEffect(() => {
    load("automations");
  }, [load]);
  const list = useMemo(() => [...(data.automations ?? [])].sort((a, b) => Number(b.enabled) - Number(a.enabled)), [data.automations]);
  const lang = document.documentElement.lang;
  return (
    <div className="page wide">
      <div className="page-head">
        <h1 className="page-title">{t("ws.automations")}</h1>
        <div className="page-actions">
          <button className="btn primary" onClick={() => setDialog("automation")}>
            <Plus size={14} />
            {t("auto.new")}
          </button>
        </div>
      </div>
      {data.automations && list.length === 0 && <Empty text={t("auto.none")} />}
      <div className="auto-list">
        {list.map((a) => {
          const c = captains.find((x) => x.id === a.captain_id);
          return (
            <div key={a.id} className={`auto ${a.enabled ? "" : "off"}`}>
              <button className="auto-main" onClick={() => setDialog("automation", a)}>
                <span className="auto-name">{a.name}</span>
                <span className="auto-when">{describeCron(a.schedule, lang)}</span>
                <span className="auto-prompt">{a.prompt}</span>
              </button>
              <div className="auto-side">
                {c && (
                  <span className="list-meta">
                    <PixelAvatar seed={c.avatar_seed} size={14} />
                    {c.name}
                  </span>
                )}
                <span className="list-meta">{a.last_run ? ago(a.last_run) : t("auto.never")}</span>
                <button
                  className="icon-btn"
                  title={t("auto.runNow")}
                  onClick={async () => {
                    try {
                      const th = await rpc<Thread>("run_automation", { id: a.id });
                      openThread(th.id);
                    } catch (e) {
                      notify(String(e));
                    }
                  }}
                >
                  <Play size={14} />
                </button>
                <button className="icon-btn" title={a.enabled ? t("auto.pause") : t("auto.resume")} onClick={() => rpc("update_automation", { automation: { ...a, enabled: !a.enabled } }).catch((e) => notify(String(e)))}>
                  {a.enabled ? <Pause size={14} /> : <Check size={14} />}
                </button>
              </div>
            </div>
          );
        })}
      </div>
      <p className="page-note">
        <CircleDashed size={13} />
        {t("auto.note")}
      </p>
    </div>
  );
}
