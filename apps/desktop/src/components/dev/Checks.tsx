import { ArrowUpRight, RotateCw, Sparkles } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { backend } from "../../backend";
import { useT } from "../../i18n";
import { ago } from "../../lib/format";
import type { CiLog } from "../../protocol/CiLog";
import type { CiRun } from "../../protocol/CiRun";
import type { Thread } from "../../protocol/Thread";
import { rpc, useStore, useWorkspaceCaptains, useWorkspaceThreads } from "../../store";
import { Empty } from "../Panel";
import { PixelAvatar } from "../PixelAvatar";
import { StatusIcon } from "../StatusIcon";
import { errText } from "./state";

type Filter = "all" | "failing" | "threads";

export const runState = (r: CiRun): "running" | "ok" | "fail" | "off" =>
  r.status !== "completed" ? "running" : r.conclusion === "success" ? "ok" : ["failure", "timed_out", "startup_failure", "action_required"].includes(r.conclusion ?? "") ? "fail" : "off";

export function RunIcon({ run, size = 14 }: { run: CiRun; size?: number }) {
  const s = runState(run);
  if (s === "running") return <StatusIcon status="working" size={size} />;
  return (
    <svg className={`dv-run is-${s}`} width={size} height={size} viewBox="0 0 14 14" aria-hidden>
      <circle cx="7" cy="7" r="6" fill="currentColor" />
      {s === "ok" && <path d="M4.4 7.2l1.8 1.8 3.5-3.6" fill="none" stroke="var(--sheet)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />}
      {s === "fail" && <path d="M5 5l4 4M9 5l-4 4" stroke="var(--sheet)" strokeWidth="1.5" strokeLinecap="round" />}
      {s === "off" && <path d="M4.5 7h5" stroke="var(--sheet)" strokeWidth="1.5" strokeLinecap="round" />}
    </svg>
  );
}

/** The thread a run belongs to: matched by the runner, or by branch here. */
export function useRunThread(run: CiRun | null): Thread | undefined {
  const threads = useWorkspaceThreads();
  if (!run) return undefined;
  return threads.find((t) => t.id === run.thread_id) ?? (run.branch ? threads.find((t) => t.branch === run.branch && t.branch !== "main") : undefined);
}

export function ChecksTab() {
  const t = useT();
  const ws = useStore((s) => s.workspaceId);
  const [runs, setRuns] = useState<CiRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState<number | null>(null);
  const threads = useWorkspaceThreads();

  const load = useCallback(async () => {
    setBusy(true);
    try {
      setRuns(await rpc<CiRun[]>("ci_runs", { workspace_id: ws }));
      setError(null);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }, [ws]);

  useEffect(() => {
    load();
    // Runs move on their own; look again now and then while the page is open.
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, [load]);

  const shown = useMemo(() => {
    const all = runs ?? [];
    if (filter === "failing") return all.filter((r) => runState(r) === "fail");
    if (filter === "threads") return all.filter((r) => r.thread_id || threads.some((x) => x.branch === r.branch && x.branch !== "main"));
    return all;
  }, [runs, filter, threads]);
  const selected = runs?.find((r) => r.id === open) ?? null;
  const failing = (runs ?? []).filter((r) => runState(r) === "fail").length;

  return (
    <div className={`dv-split ${selected ? "with-side" : ""}`}>
      <div className="dv-main">
        <div className="dv-toolbar">
          <div className="choice small">
            {(["all", "failing", "threads"] as const).map((f) => (
              <button key={f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>
                {t(`dev.checks.${f}`)}
                {f === "failing" && failing > 0 && <span className="dv-count">{failing}</span>}
              </button>
            ))}
          </div>
          <div className="composer-spacer" />
          <button className={`icon-btn ${busy ? "spin" : ""}`} onClick={load} title={t("dev.refresh")} aria-label={t("dev.refresh")}>
            <RotateCw size={14} />
          </button>
        </div>
        <div className="dv-scroll">
          {error ? (
            <div className="dv-empty">
              <p>{error}</p>
              <p className="dv-hint">{t("dev.checks.ghHint")}</p>
            </div>
          ) : runs === null ? (
            <Empty text={t("dev.loading")} />
          ) : shown.length === 0 ? (
            <Empty text={t(runs.length ? "dev.checks.noneHere" : "dev.checks.none")} />
          ) : (
            shown.map((r) => <RunRow key={r.id} run={r} on={open === r.id} onOpen={() => setOpen(open === r.id ? null : r.id)} />)
          )}
        </div>
      </div>
      {selected && <RunDetail key={selected.id} run={selected} />}
    </div>
  );
}

function ThreadChip({ thread }: { thread: Thread }) {
  const captains = useWorkspaceCaptains();
  const openThread = useStore((s) => s.openThread);
  const c = captains.find((x) => x.id === thread.captain_id);
  return (
    <span
      className="dv-thread"
      role="link"
      tabIndex={0}
      title={thread.branch ?? undefined}
      onClick={(e) => {
        e.stopPropagation();
        openThread(thread.id);
      }}
      onKeyDown={(e) => e.key === "Enter" && openThread(thread.id)}
    >
      {c ? <PixelAvatar seed={c.avatar_seed} size={13} /> : <StatusIcon status={thread.status} size={12} />}
      <span className="truncate">{thread.title}</span>
    </span>
  );
}

function RunRow({ run, on, onOpen }: { run: CiRun; on: boolean; onOpen: () => void }) {
  const thread = useRunThread(run);
  return (
    <button className={`list-row dv-row ${on ? "on" : ""}`} onClick={onOpen}>
      <RunIcon run={run} />
      <span className="dv-row-text">
        <span className="truncate list-title">{run.title || run.workflow}</span>
        <span className="dv-row-meta truncate">
          {run.workflow}
          <span className="mono">{run.branch}</span>
          {run.event}
        </span>
      </span>
      {thread && <ThreadChip thread={thread} />}
      <span className="list-meta when">{run.created_at ? ago(run.created_at) : ""}</span>
    </button>
  );
}

/** `job\tstep\t2026-…Z line` → grouped, without timestamps and colour codes. */
function parseLog(text: string) {
  const groups: { title: string; lines: string[] }[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, "");
    const parts = line.split("\t");
    let title = "";
    let body = line;
    if (parts.length >= 3) {
      title = `${parts[0]} › ${parts[1]}`;
      body = parts.slice(2).join("\t");
    }
    body = body.replace(/^﻿?\d{4}-\d\d-\d\dT[\d:.]+Z ?/, "");
    const last = groups[groups.length - 1];
    if (!last || last.title !== title) groups.push({ title, lines: [body] });
    else last.lines.push(body);
  }
  return groups.filter((g) => g.lines.some((l) => l.trim()));
}

function RunDetail({ run }: { run: CiRun }) {
  const t = useT();
  const ws = useStore((s) => s.workspaceId);
  const notify = useStore((s) => s.notify);
  const openThread = useStore((s) => s.openThread);
  const thread = useRunThread(run);
  const [log, setLog] = useState<CiLog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fixing, setFixing] = useState(false);
  const state = runState(run);

  useEffect(() => {
    if (state !== "fail") return;
    rpc<CiLog>("get_ci_log", { workspace_id: ws, run_id: run.id }).then(setLog, (e) => setError(errText(e)));
  }, [ws, run.id, state]);

  const groups = useMemo(() => (log ? parseLog(log.text) : []), [log]);

  const fix = async () => {
    setFixing(true);
    try {
      const th = await rpc<Thread>("fix_ci_run", { workspace_id: ws, run_id: run.id });
      await openThread(th.id);
    } catch (e) {
      notify(errText(e));
    } finally {
      setFixing(false);
    }
  };

  return (
    <aside className="dv-side">
      <div className="dv-side-head">
        <RunIcon run={run} size={16} />
        <div className="dv-side-title">
          <span className="truncate">{run.title || run.workflow}</span>
          <span className="dv-row-meta">
            {run.workflow} · <span className="mono">{run.branch}</span> · {t(`dev.run.${state}`)}
          </span>
        </div>
      </div>
      <div className="dv-side-actions">
        {state === "fail" && (
          <button className={`btn small primary ${fixing ? "is-busy" : ""}`} disabled={fixing} onClick={fix}>
            <Sparkles size={13} />
            {t("dev.checks.fix")}
          </button>
        )}
        <button className="btn small" onClick={() => backend.openUrl(run.url)}>
          <ArrowUpRight size={13} />
          GitHub
        </button>
        {thread && <ThreadChip thread={thread} />}
      </div>
      {state === "fail" && (
        <div className="dv-log">
          {error ? (
            <Empty text={error} />
          ) : !log ? (
            <Empty text={t("dev.loading")} />
          ) : (
            <>
              {log.truncated && <div className="dv-log-note">{t("dev.checks.truncated")}</div>}
              {groups.map((g, i) => (
                <div key={i} className="dv-log-group">
                  {g.title && <div className="dv-log-title truncate">{g.title}</div>}
                  <pre>
                    {g.lines.map((l, j) => (
                      <div key={j} className={/##\[error\]|\berror\b|\bFAIL(ED)?\b|panicked/i.test(l) ? "err" : /##\[warning\]|\bwarning\b/i.test(l) ? "warn" : undefined}>
                        {l.replace(/^##\[(error|warning|group|endgroup)\]/, "") || " "}
                      </div>
                    ))}
                  </pre>
                </div>
              ))}
            </>
          )}
        </div>
      )}
      {state !== "fail" && <Empty text={t(state === "running" ? "dev.checks.running" : "dev.checks.noLog")} />}
    </aside>
  );
}
