import { Copy, RotateCw, Tag } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useT } from "../../i18n";
import { ago } from "../../lib/format";
import type { CommitDetail } from "../../protocol/CommitDetail";
import type { GitGraph } from "../../protocol/GitGraph";
import type { GraphCommit } from "../../protocol/GraphCommit";
import type { Thread } from "../../protocol/Thread";
import { rpc, useStore, useWorkspaceCaptains, useWorkspaceThreads } from "../../store";
import { Empty } from "../Panel";
import { PixelAvatar } from "../PixelAvatar";
import { errText, laneColor } from "./state";

const ROW = 30;
const LANE = 14;
const PAD = 12;

/** Every lane line and node of the graph as one SVG behind the rows. */
function GraphSvg({ commits, lanes, head }: { commits: GraphCommit[]; lanes: number; head: string | null }) {
  const width = PAD * 2 + Math.max(lanes - 1, 0) * LANE;
  const x = (l: number) => PAD + l * LANE;
  const y = (i: number) => i * ROW + ROW / 2;
  return (
    <svg className="dv-graph-svg" width={width} height={commits.length * ROW} aria-hidden>
      {commits.flatMap((c, i) =>
        c.edges.map((e, k) => {
          const x1 = x(e.from);
          const x2 = x(e.to);
          const y1 = y(i);
          const y2 = y(i) + ROW;
          const d = x1 === x2 ? `M${x1} ${y1}V${y2}` : `M${x1} ${y1}C${x1} ${y1 + ROW * 0.6} ${x2} ${y2 - ROW * 0.6} ${x2} ${y2}`;
          return <path key={`${i}-${k}`} d={d} stroke={laneColor(e.color)} strokeWidth={2} fill="none" strokeLinecap="round" />;
        }),
      )}
      {commits.map((c, i) => {
        const merge = c.parents.length > 1;
        const isHead = c.sha === head;
        return (
          <g key={c.sha}>
            {isHead && <circle cx={x(c.lane)} cy={y(i)} r={7} fill="none" stroke={laneColor(c.color)} strokeWidth={1.5} opacity={0.5} />}
            <circle cx={x(c.lane)} cy={y(i)} r={merge ? 3.5 : 4.5} fill={merge ? "var(--sheet)" : laneColor(c.color)} stroke={laneColor(c.color)} strokeWidth={merge ? 2 : 0} />
          </g>
        );
      })}
    </svg>
  );
}

function RefBadge({ name, color, thread, head }: { name: string; color: string; thread?: Thread; head: boolean }) {
  const captains = useWorkspaceCaptains();
  const openThread = useStore((s) => s.openThread);
  const remote = /^[^/]+\/.+/.test(name) && !name.startsWith("bouvio/") && name.split("/")[0] === "origin";
  const tag = /^v?\d+(\.\d+)+/.test(name);
  if (thread) {
    const c = captains.find((x) => x.id === thread.captain_id);
    return (
      <span
        className={`dv-ref thread ${head ? "head" : ""}`}
        style={{ ["--ref" as string]: color }}
        title={name}
        role="link"
        tabIndex={0}
        onClick={(e) => {
          e.stopPropagation();
          openThread(thread.id);
        }}
        onKeyDown={(e) => e.key === "Enter" && openThread(thread.id)}
      >
        {c && <PixelAvatar seed={c.avatar_seed} size={12} />}
        <span className="truncate">{thread.title}</span>
      </span>
    );
  }
  return (
    <span className={`dv-ref ${remote ? "remote" : ""} ${head ? "head" : ""}`} style={{ ["--ref" as string]: color }} title={name}>
      {tag && <Tag size={10} />}
      <span className="truncate">{name}</span>
    </span>
  );
}

export function GitTab() {
  const t = useT();
  const ws = useStore((s) => s.workspaceId);
  const threads = useWorkspaceThreads();
  const [graph, setGraph] = useState<GitGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [limit, setLimit] = useState(300);
  const [sel, setSel] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      setGraph(await rpc<GitGraph>("git_graph", { workspace_id: ws, limit }));
      setError(null);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }, [ws, limit]);
  useEffect(() => {
    load();
  }, [load]);

  const byBranch = useMemo(() => {
    const m = new Map<string, Thread>();
    for (const th of threads) if (th.branch?.startsWith("bouvio/")) m.set(th.branch, th);
    return m;
  }, [threads]);

  const commits = graph?.commits ?? [];
  const width = PAD * 2 + Math.max((graph?.lanes ?? 1) - 1, 0) * LANE;

  return (
    <div className={`dv-split ${sel ? "with-side" : ""}`}>
      <div className="dv-main">
        <div className="dv-toolbar">
          <span className="dv-toolbar-label">{graph ? t("dev.git.commits", { count: commits.length }) : ""}</span>
          <div className="composer-spacer" />
          <button className={`icon-btn ${busy ? "spin" : ""}`} onClick={load} title={t("dev.refresh")} aria-label={t("dev.refresh")}>
            <RotateCw size={14} />
          </button>
        </div>
        <div className="dv-scroll">
          {error ? (
            <Empty text={error} />
          ) : !graph ? (
            <Empty text={t("dev.loading")} />
          ) : commits.length === 0 ? (
            <Empty text={t("dev.git.none")} />
          ) : (
            <div className="dv-graph" style={{ ["--graph-w" as string]: `${width}px` }}>
              <GraphSvg commits={commits} lanes={graph.lanes} head={graph.head} />
              {commits.map((c) => (
                <button key={c.sha} className={`dv-commit ${sel === c.sha ? "on" : ""}`} style={{ height: ROW }} onClick={() => setSel(sel === c.sha ? null : c.sha)}>
                  <span className="dv-commit-msg">
                    {c.refs
                      .filter((r) => r !== "HEAD")
                      .map((r) => (
                        <RefBadge key={r} name={r} color={laneColor(c.color)} thread={byBranch.get(r)} head={c.sha === graph.head && c.refs[0] === "HEAD" && c.refs[1] === r} />
                      ))}
                    <span className="truncate">{c.subject}</span>
                  </span>
                  <span className="dv-commit-author truncate">{c.author}</span>
                  <span className="mono dv-commit-sha">{c.sha.slice(0, 7)}</span>
                  <span className="list-meta when">{ago(c.date)}</span>
                </button>
              ))}
              {commits.length >= limit && (
                <button className="btn ghost small dv-more" onClick={() => setLimit((l) => l + 300)}>
                  {t("dev.git.more")}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      {sel && <CommitPane key={sel} sha={sel} onPick={setSel} />}
    </div>
  );
}

function CommitPane({ sha, onPick }: { sha: string; onPick: (sha: string) => void }) {
  const t = useT();
  const ws = useStore((s) => s.workspaceId);
  const notify = useStore((s) => s.notify);
  const [c, setC] = useState<CommitDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    rpc<CommitDetail>("get_commit", { workspace_id: ws, sha }).then(setC, (e) => setError(errText(e)));
  }, [ws, sha]);
  if (error) return <aside className="dv-side"><Empty text={error} /></aside>;
  if (!c) return <aside className="dv-side"><Empty text={t("dev.loading")} /></aside>;
  const adds = c.files.reduce((a, f) => a + (f.adds ?? 0), 0);
  const dels = c.files.reduce((a, f) => a + (f.dels ?? 0), 0);
  return (
    <aside className="dv-side">
      <div className="dv-commit-head">
        <h2>{c.subject}</h2>
        {c.body && <p className="dv-commit-body">{c.body}</p>}
        <div className="dv-props">
          <span>{t("dev.git.author")}</span>
          <span className="truncate" title={c.email}>{c.author}</span>
          <span>{t("dev.git.date")}</span>
          <span title={c.date}>{new Date(c.date).toLocaleString()}</span>
          <span>{t("dev.git.commit")}</span>
          <span className="dv-sha">
            <span className="mono">{c.sha.slice(0, 12)}</span>
            <button
              className="icon-btn"
              title={t("dev.copy")}
              aria-label={t("dev.copy")}
              onClick={() => navigator.clipboard?.writeText(c.sha).then(() => notify(t("dev.copied")))}
            >
              <Copy size={12} />
            </button>
          </span>
          {c.parents.length > 0 && (
            <>
              <span>{t("dev.git.parents")}</span>
              <span className="dv-parents">
                {c.parents.map((p) => (
                  <button key={p} className="mono dv-link" onClick={() => onPick(p)}>
                    {p.slice(0, 7)}
                  </button>
                ))}
              </span>
            </>
          )}
        </div>
      </div>
      <div className="changes-head dv-files-head">
        <span>{t("dev.git.files", { count: c.files.length })}</span>
        <span className="add">+{adds}</span>
        <span className="del">−{dels}</span>
      </div>
      <div className="dv-files">
        {c.files.map((f) => (
          <div key={f.path} className="dv-file">
            <span className="mono truncate" title={f.path}>{f.path}</span>
            {f.adds === null ? (
              <span className="dv-row-meta">{t("dev.git.binary")}</span>
            ) : (
              <>
                <span className="add">+{f.adds}</span>
                <span className="del">−{f.dels}</span>
                <StatBar adds={f.adds} dels={f.dels ?? 0} />
              </>
            )}
          </div>
        ))}
      </div>
    </aside>
  );
}

function StatBar({ adds, dels }: { adds: number; dels: number }) {
  const total = adds + dels || 1;
  const n = 5;
  const a = Math.round((adds / total) * n);
  return (
    <span className="dv-statbar" aria-hidden>
      {Array.from({ length: n }, (_, i) => (
        <i key={i} className={i < a ? "a" : i < Math.min(n, a + Math.max(dels ? 1 : 0, Math.round((dels / total) * n))) ? "d" : ""} />
      ))}
    </span>
  );
}
