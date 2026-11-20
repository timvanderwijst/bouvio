import { ChevronDown, Maximize2, Minimize2, PanelRightClose, RotateCw } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useT } from "../i18n";
import type { Thread } from "../protocol/Thread";
import { rpc, useStore, useWorkspaceCaptains, useWorkspaceThreads, type PanelTab } from "../store";
import { ArtifactPreview } from "./Studio";
import { DevBar } from "./ThreadExtras";
import { extPanels } from "../ext/areas";
import { parseDiff, type DiffFile } from "../lib/diff";
import { ago } from "../lib/format";
import { PixelAvatar } from "./PixelAvatar";
import { StatusIcon } from "./StatusIcon";
import { Terminal } from "./Terminal";

export function Panel({ thread }: { thread: Thread | null }) {
  const t = useT();
  const panel = useStore((s) => s.panel);
  const setPanel = useStore((s) => s.setPanel);
  const tabs: { id: PanelTab; label: string }[] = [
    { id: "overview", label: t("panel.overview") },
    { id: "changes", label: t("panel.changes") },
    { id: "terminal", label: t("panel.terminal") },
    ...extPanels().map((p) => ({ id: p.id as PanelTab, label: t(p.label) })),
    ...(panel.artifact ? [{ id: "preview" as PanelTab, label: t("panel.preview") }] : []),
  ];
  const bar = useRef<HTMLDivElement>(null);
  const [ind, setInd] = useState({ x: 0, w: 0 });

  // The indicator slides to the chosen tab instead of jumping.
  useLayoutEffect(() => {
    const el = bar.current?.querySelector<HTMLElement>(`[data-tab="${panel.tab}"]`);
    if (el) setInd({ x: el.offsetLeft, w: el.offsetWidth });
  }, [panel.tab, t, tabs.length]);

  return (
    <section className={`panel ${panel.wide ? "wide" : ""}`} aria-label={t("panel.overview")}>
      <header className="panel-head">
        <div className="seg" ref={bar}>
          <span className="seg-ind" style={{ transform: `translateX(${ind.x}px)`, width: ind.w }} />
          {tabs.map((tab) => (
            <button key={tab.id} data-tab={tab.id} className={`seg-btn ${panel.tab === tab.id ? "on" : ""}`} onClick={() => setPanel({ tab: tab.id })}>
              {tab.label}
            </button>
          ))}
        </div>
        <div className="panel-actions">
          <button className="icon-btn" onClick={() => setPanel({ wide: !panel.wide })} aria-label={t("panel.expand")} title={t("panel.expand")}>
            {panel.wide ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
          <button className="icon-btn" onClick={() => setPanel({ open: false })} aria-label={t("panel.close")} title={t("panel.close")}>
            <PanelRightClose size={15} />
          </button>
        </div>
      </header>
      <div className="panel-body">
        {panel.tab === "overview" && <Overview />}
        {panel.tab === "changes" && <Changes thread={thread} />}
        {panel.tab === "terminal" && (thread ? <Terminal key={thread.id} threadId={thread.id} /> : <Empty text={t("panel.nothing")} />)}
        {panel.tab === "preview" && panel.artifact && <ArtifactPreview key={panel.artifact.id} artifact={panel.artifact} />}
        {extPanels()
          .filter((p) => p.id === panel.tab)
          .map((p) => (
            <p.component key={p.id} thread={thread} />
          ))}
      </div>
    </section>
  );
}

export function Overview({ threads: given, showWorkspace = false }: { threads?: Thread[]; showWorkspace?: boolean }) {
  const t = useT();
  const own = useWorkspaceThreads();
  const threads = given ?? own;
  const needs = threads.filter((x) => x.status === "blocked" || x.status === "error");
  const working = threads.filter((x) => x.status === "working");
  const recent = threads.filter((x) => x.status === "idle" || x.status === "done").sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 8);
  return (
    <div className="overview">
      <Group title={t("panel.needsYou")} items={needs} showWorkspace={showWorkspace} />
      <Group title={t("panel.inProgress")} items={working} showWorkspace={showWorkspace} />
      <Group title={t("panel.recent")} items={recent} showWorkspace={showWorkspace} />
    </div>
  );
}

function Group({ title, items, showWorkspace }: { title: string; items: Thread[]; showWorkspace: boolean }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="group">
      <button className="group-head" onClick={() => setOpen((o) => !o)}>
        <span>{title}</span>
        <span className="group-count">{items.length}</span>
        <ChevronDown size={12} className={open ? "" : "rot"} />
      </button>
      {open && items.map((th) => <OverviewRow key={th.id} thread={th} showWorkspace={showWorkspace} />)}
    </div>
  );
}

function OverviewRow({ thread, showWorkspace }: { thread: Thread; showWorkspace: boolean }) {
  const openThread = useStore((s) => s.openThread);
  const captains = useWorkspaceCaptains();
  const allCaptains = useStore((s) => s.captains);
  const wsName = useStore((s) => s.workspaces.find((w) => w.id === thread.workspace_id)?.name);
  const captain = (showWorkspace ? allCaptains[thread.workspace_id] ?? [] : captains).find((c) => c.id === thread.captain_id);
  const meta = [showWorkspace ? wsName : null, captain?.name, thread.branch].filter(Boolean).join(" · ");
  return (
    <button className="ov-row" onClick={() => openThread(thread.id)}>
      <StatusIcon status={thread.status} />
      <span className="ov-text">
        <span className="ov-title truncate">{thread.title}</span>
        <span className="ov-meta truncate">
          {captain && <PixelAvatar seed={captain.avatar_seed} size={12} />}
          {meta}
        </span>
      </span>
      <span className="ov-when">{ago(thread.updated_at)}</span>
    </button>
  );
}

function Changes({ thread }: { thread: Thread | null }) {
  const t = useT();
  const [raw, setRaw] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const turns = useStore((s) => (thread ? (s.events[thread.id] ?? []).filter((e) => e.event.type === "turn_complete").length : 0));

  const load = useCallback(async () => {
    if (!thread?.cwd) return setRaw("");
    setBusy(true);
    try {
      setRaw(await rpc<string>("thread_diff", { thread_id: thread.id }));
    } catch (e) {
      setRaw(`error: ${e}`);
    } finally {
      setBusy(false);
    }
  }, [thread?.id, thread?.cwd]);

  // Reload after every finished turn: that is when files change.
  useEffect(() => {
    load();
  }, [load, turns]);

  const files = useMemo(() => parseDiff(raw ?? ""), [raw]);
  if (!thread) return <Empty text={t("panel.nothing")} />;
  if (!thread.cwd) return <Empty text={t("panel.noRepo")} />;
  if (raw?.startsWith("error:")) return <Empty text={raw} />;
  const adds = files.reduce((a, f) => a + f.adds, 0);
  const dels = files.reduce((a, f) => a + f.dels, 0);

  return (
    <div className="changes">
      <div className="changes-head">
        <span>{t("panel.files", { count: files.length })}</span>
        <span className="add">+{adds}</span>
        <span className="del">−{dels}</span>
        <div className="composer-spacer" />
        <button className={`icon-btn ${busy ? "spin" : ""}`} onClick={load} aria-label={t("panel.refresh")} title={t("panel.refresh")}>
          <RotateCw size={13} />
        </button>
      </div>
      <DevBar thread={thread} hasChanges={files.length > 0} />
      {raw !== null && files.length === 0 ? <Empty text={t("panel.noChanges")} /> : files.map((f) => <FileDiff key={f.path} file={f} />)}
    </div>
  );
}

function FileDiff({ file }: { file: DiffFile }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="file">
      <button className="file-head" onClick={() => setOpen((o) => !o)}>
        <ChevronDown size={12} className={open ? "" : "rot"} />
        <span className="file-path truncate">{file.path}</span>
        <span className="add">+{file.adds}</span>
        <span className="del">−{file.dels}</span>
      </button>
      {open && (
        <div className="diff">
          {file.hunks.map((h, i) => (
            <div key={i}>
              <div className="diff-hunk">{h.header}</div>
              {h.lines.map((l, j) => (
                <div key={j} className={`diff-line ${l.kind}`}>
                  <span className="ln">{l.kind === "del" ? l.old : l.new}</span>
                  <span className="sign">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : ""}</span>
                  <span className="code">{l.text || " "}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function Empty({ text }: { text: string }) {
  return <div className="empty">{text}</div>;
}
