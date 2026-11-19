import { ArrowUpRight, Check, FileCode2, GitCommitHorizontal, GitPullRequestArrow, Image as ImageIcon, Music, Play, ShieldQuestion, Square, Video, X } from "lucide-react";
import { useState } from "react";
import { useT } from "../i18n";
import type { Artifact } from "../protocol/Artifact";
import type { Thread } from "../protocol/Thread";
import { rpc, useStore, useWsData } from "../store";
import { toolSummary } from "../lib/format";
import { StatusIcon } from "./StatusIcon";
import { backend } from "../backend";

/** An agent asks before it does something risky. Anyone allowed to steer may answer. */
export function ApprovalCard({ id, tool, input, resolved }: { id: string; tool: string; input: unknown; resolved?: { allowed: boolean; by: string } }) {
  const t = useT();
  const notify = useStore((s) => s.notify);
  const [busy, setBusy] = useState(false);
  const answer = async (allowed: boolean) => {
    setBusy(true);
    try {
      await rpc("resolve_approval", { id, allowed });
    } catch (e) {
      notify(String(e));
    } finally {
      setBusy(false);
    }
  };
  const detail = toolSummary(tool, input) || JSON.stringify(input).slice(0, 160);
  return (
    <div className={`approval ${resolved ? (resolved.allowed ? "allowed" : "denied") : "open"}`}>
      <div className="approval-head">
        <ShieldQuestion size={15} />
        <span>{resolved ? t(resolved.allowed ? "approval.allowedBy" : "approval.deniedBy", { name: resolved.by }) : t("approval.wants", { tool })}</span>
      </div>
      <pre className="approval-detail">{detail}</pre>
      {!resolved && (
        <div className="approval-actions">
          <button className="btn ghost" disabled={busy} onClick={() => answer(false)}>
            <X size={14} />
            {t("approval.deny")}
          </button>
          <button className="btn primary" disabled={busy} onClick={() => answer(true)}>
            <Check size={14} />
            {t("approval.allow")}
          </button>
        </div>
      )}
    </div>
  );
}

export function SpawnedRow({ threadId, title }: { threadId: string; title: string }) {
  const openThread = useStore((s) => s.openThread);
  const th = useStore((s) => Object.values(s.threads).flat().find((x) => x.id === threadId));
  return (
    <button className="spawned" onClick={() => openThread(threadId)}>
      <StatusIcon status={th?.status ?? "working"} size={13} />
      <span className="truncate">{title}</span>
      {th?.branch && <span className="mono spawned-branch">{th.branch}</span>}
      <ArrowUpRight size={13} />
    </button>
  );
}

export function artifactIcon(kind: Artifact["kind"]) {
  return kind === "image" || kind === "svg" ? ImageIcon : kind === "video" ? Video : kind === "audio" ? Music : FileCode2;
}

export function ArtifactCard({ artifact }: { artifact: Artifact }) {
  const openArtifact = useStore((s) => s.openArtifact);
  const Icon = artifactIcon(artifact.kind);
  return (
    <button className="artifact-card" onClick={() => openArtifact(artifact)}>
      <span className="artifact-icon">
        <Icon size={16} />
      </span>
      <span className="artifact-text">
        <span className="truncate artifact-title">{artifact.title}</span>
        <span className="artifact-kind">{artifact.kind}</span>
      </span>
      <ArrowUpRight size={14} className="artifact-go" />
    </button>
  );
}

/** Commit, open a PR, and run the app for this thread. */
export function DevBar({ thread, hasChanges }: { thread: Thread; hasChanges: boolean }) {
  const t = useT();
  const notify = useStore((s) => s.notify);
  const data = useWsData();
  const [busy, setBusy] = useState<string | null>(null);
  const [dev, setDev] = useState<string | null>(null);
  const run = async (key: string, f: () => Promise<unknown>) => {
    setBusy(key);
    try {
      const r = await f();
      if (typeof r === "string" && r.startsWith("http")) backend.openUrl(r);
      else if (typeof r === "string") notify(r);
    } catch (e) {
      notify(String(e));
    } finally {
      setBusy(null);
    }
  };
  if (!thread.branch) return null;
  return (
    <div className="devbar">
      <button className="btn small" disabled={!hasChanges || !!busy} onClick={() => run("commit", () => rpc("commit_thread", { thread_id: thread.id, message: thread.title }).then((h) => t("dev.committed", { hash: String(h) })))}>
        <GitCommitHorizontal size={14} />
        {t("dev.commit")}
      </button>
      <button className="btn small" disabled={!!busy || thread.branch === "main"} onClick={() => run("pr", () => rpc<string>("create_pull_request", { thread_id: thread.id }))}>
        <GitPullRequestArrow size={14} />
        {t("dev.openPr")}
      </button>
      <div className="composer-spacer" />
      {data.settings?.dev_command !== null && (
        dev ? (
          <>
            <button className="btn small ghost" onClick={() => backend.openUrl(dev)}>
              {dev.replace("http://", "")}
            </button>
            <button className="icon-btn" title={t("dev.stop")} onClick={() => run("dev", async () => (await rpc("stop_dev_server", { thread_id: thread.id }), setDev(null)))}>
              <Square size={11} fill="currentColor" />
            </button>
          </>
        ) : (
          <button className="btn small" disabled={!!busy} onClick={() => run("dev", async () => setDev((await rpc<{ url: string }>("start_dev_server", { thread_id: thread.id })).url))}>
            <Play size={13} />
            {t("dev.run")}
          </button>
        )
      )}
    </div>
  );
}
