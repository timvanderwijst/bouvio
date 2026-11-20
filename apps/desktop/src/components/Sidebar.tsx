import { BookOpen, ChevronDown, CircleDashed, FolderTree, GitPullRequest, Hash, List, Palette, PenSquare, Plus, Search, UserPlus, Workflow } from "lucide-react";
import { useMemo, useState } from "react";
import { useT } from "../i18n";
import type { Captain } from "../protocol/Captain";
import type { Thread } from "../protocol/Thread";
import { useStore, useWorkspaceCaptains, useWorkspaceThreads, useWsData, type Page } from "../store";
import { ago } from "../lib/format";
import { PixelAvatar } from "./PixelAvatar";
import { StatusIcon } from "./StatusIcon";
import { BouvioMark } from "./Rail";
import { extPages } from "../ext/areas";
import { HuddleSidebarRow } from "./comms";
import type { ExtPage } from "../ext/types";

export function Sidebar() {
  const t = useT();
  const view = useStore((s) => s.view);
  const go = useStore((s) => s.go);
  const workspaces = useStore((s) => s.workspaces);
  const workspaceId = useStore((s) => s.workspaceId);
  const ws = workspaces.find((w) => w.id === workspaceId);
  const captains = useWorkspaceCaptains();
  const threads = useWorkspaceThreads();
  const [captainsOpen, setCaptainsOpen] = useState(true);
  const loose = threads.filter((x) => !x.captain_id);

  const data = useWsData();
  const openIssues = (data.issues ?? []).filter((i) => i.status === "todo" || i.status === "in_progress").length;
  // Daily things stay in view; the rest folds under "More" so captains keep their place.
  const primaryBuiltIn: { page: Page; icon: typeof List; label: string; count?: number }[] = [
    { page: "issues", icon: CircleDashed, label: t("ws.issues"), count: openIssues || undefined },
    { page: "pullRequests", icon: GitPullRequest, label: t("ws.pullRequests") },
    { page: "studio", icon: Palette, label: t("ws.studio") },
  ];
  const moreBuiltIn: typeof primaryBuiltIn = [
    { page: "automations", icon: Workflow, label: t("ws.automations") },
    { page: "files", icon: FolderTree, label: t("ws.files") },
    { page: "knowledge", icon: BookOpen, label: t("ws.knowledge") },
  ];
  // Search lives behind the search icon and Ctrl+K.
  const ext = extPages("workspace").filter((p) => p.id !== "knowledge.search");
  const extPrimary = ext.filter((p) => (p.order ?? 100) < 50);
  const extMore = ext.filter((p) => (p.order ?? 100) >= 50);
  const inMore =
    (view.kind === "page" && moreBuiltIn.some((p) => p.page === view.page)) || (view.kind === "ext" && extMore.some((p) => p.id === view.id));
  const [moreOpen, setMoreOpen] = useState(() => {
    try {
      return localStorage.getItem("bouvio.sb.more") === "1";
    } catch {
      return false;
    }
  });
  const toggleMore = () => {
    const next = !moreOpen;
    setMoreOpen(next);
    try {
      localStorage.setItem("bouvio.sb.more", next ? "1" : "0");
    } catch {}
  };
  const builtInRow = (p: (typeof primaryBuiltIn)[number]) => (
    <button
      key={p.page}
      className={`sb-row ${(view.kind === "page" && view.page === p.page) || (p.page === "studio" && view.kind === "board") ? "active" : ""}`}
      onClick={() => go({ kind: "page", page: p.page })}
    >
      <p.icon size={15} />
      <span className="truncate">{p.label}</span>
      {p.count ? <span className="sb-count">{p.count}</span> : null}
    </button>
  );

  return (
    <aside className="sidebar">
      <div className="sb-top">
        <WorkspaceSwitcher />
        <div className="sb-top-actions">
          <button className="icon-btn" onClick={() => go({ kind: "ext", id: "knowledge.search" })} aria-label="Search" title="Search">
            <Search size={15} />
          </button>
        </div>
      </div>

      <nav className="sb-nav">
        <button className={`sb-row ${view.kind === "draft" && !view.captainId ? "active" : ""}`} onClick={() => go({ kind: "draft", captainId: null })}>
          <PenSquare size={15} />
          <span>{t("ws.newThread")}</span>
        </button>
        <button className={`sb-row ${view.kind === "threads" ? "active" : ""}`} onClick={() => go({ kind: "threads" })}>
          <List size={15} />
          <span>{t("ws.threads")}</span>
        </button>
        {extPrimary.map((p) => (
          <ExtNav key={p.id} page={p} />
        ))}
        {primaryBuiltIn.map(builtInRow)}
        <button className={`sb-row sb-more-toggle ${inMore && !moreOpen ? "active" : ""}`} onClick={toggleMore} aria-expanded={moreOpen}>
          <ChevronDown size={15} className={moreOpen ? "" : "rot"} />
          <span>{t("ws.more")}</span>
        </button>
        {(moreOpen || inMore) && (
          <div className="sb-more-list">
            {moreBuiltIn.map(builtInRow)}
            {extMore.map((p) => (
              <ExtNav key={p.id} page={p} />
            ))}
          </div>
        )}
      </nav>

      <div className="sb-scroll">
        <div className="sb-section">
          <button className="sb-heading" onClick={() => setCaptainsOpen((o) => !o)}>
            <span>{t("ws.captains")}</span>
            <ChevronDown size={12} className={captainsOpen ? "" : "rot"} />
          </button>
          <button className="icon-btn sb-add" aria-label={t("ws.newCaptain")} title={t("ws.newCaptain")} onClick={() => useStore.getState().setDialog("captain")} disabled={!ws}>
            <Plus size={14} />
          </button>
        </div>
        {captainsOpen && captains.map((c) => <CaptainRow key={c.id} captain={c} threads={threads.filter((x) => x.captain_id === c.id)} />)}

        {loose.length > 0 && (
          <>
            <div className="sb-section">
              <span className="sb-heading static">{t("ws.threads")}</span>
            </div>
            {loose.slice(0, 8).map((th) => (
              <ThreadRow key={th.id} thread={th} />
            ))}
          </>
        )}

        <div className="sb-section">
          <span className="sb-heading static">{t("ws.people")}</span>
          <button className="icon-btn sb-add" aria-label={t("share.title")} title={t("share.title")} onClick={() => useStore.getState().setDialog("share")} disabled={!ws}>
            <UserPlus size={14} />
          </button>
        </div>
        <button className={`sb-row ${view.kind === "ext" && view.id === "comms.chat" ? "active" : ""}`} onClick={() => go({ kind: "ext", id: "comms.chat" })}>
          <Hash size={15} />
          <span>{t("ws.general")}</span>
        </button>
        <HuddleSidebarRow />
        <PeopleRows />
      </div>

      <UserRow />
    </aside>
  );
}

function CaptainRow({ captain, threads }: { captain: Captain; threads: Thread[] }) {
  const view = useStore((s) => s.view);
  const openCaptain = useStore((s) => s.openCaptain);
  // The oldest thread is the captain's own conversation; the rest nest under it.
  const sorted = useMemo(() => [...threads].sort((a, b) => a.created_at.localeCompare(b.created_at)), [threads]);
  const own = sorted[0];
  const children = sorted.slice(1).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const needs = threads.filter((t) => t.status === "blocked" || t.status === "error").length;
  const working = threads.some((t) => t.status === "working");
  const active = (view.kind === "thread" && view.id === own?.id) || (view.kind === "draft" && view.captainId === captain.id);
  const expanded = active || children.some((c) => view.kind === "thread" && view.id === c.id);

  return (
    <div className="captain">
      <button className={`sb-row captain-row ${active ? "active" : ""}`} onClick={() => openCaptain(captain)}>
        <span className={`avatar-wrap ${working ? "pulse" : ""}`}>
          <PixelAvatar seed={captain.avatar_seed} />
        </span>
        <span className="truncate">{captain.name}</span>
        {needs > 0 ? <span className="badge">{needs}</span> : working ? <StatusIcon status="working" size={13} /> : null}
      </button>
      {expanded && children.length > 0 && (
        <div className="captain-threads">
          {children.slice(0, 6).map((t) => (
            <ThreadRow key={t.id} thread={t} nested />
          ))}
        </div>
      )}
    </div>
  );
}

function ThreadRow({ thread, nested = false }: { thread: Thread; nested?: boolean }) {
  const view = useStore((s) => s.view);
  const openThread = useStore((s) => s.openThread);
  const active = view.kind === "thread" && view.id === thread.id;
  return (
    <button className={`sb-row thread-row ${nested ? "nested" : ""} ${active ? "active" : ""}`} onClick={() => openThread(thread.id)}>
      {thread.status !== "idle" && <StatusIcon status={thread.status} size={12} />}
      <span className="truncate">{thread.title}</span>
      <span className="sb-meta">{ago(thread.updated_at)}</span>
    </button>
  );
}

function WorkspaceSwitcher() {
  const t = useT();
  const workspaces = useStore((s) => s.workspaces);
  const workspaceId = useStore((s) => s.workspaceId);
  const selectWorkspace = useStore((s) => s.selectWorkspace);
  const setDialog = useStore((s) => s.setDialog);
  const [open, setOpen] = useState(false);
  const ws = workspaces.find((w) => w.id === workspaceId);

  return (
    <div className="ws-switch">
      <button className="ws-btn" onClick={() => setOpen((o) => !o)} aria-expanded={open} title={t("ws.switch")}>
        <span className="ws-mark">
          <BouvioMark size={16} />
        </span>
        <span className="truncate">{ws?.name ?? "Bouvio"}</span>
        <ChevronDown size={13} className="menu-chev" />
      </button>
      {open && (
        <>
          <div className="click-away" onClick={() => setOpen(false)} />
          <div className="menu-list ws-list">
            {workspaces.map((w) => (
              <button
                key={w.id}
                className="menu-item"
                onClick={() => {
                  selectWorkspace(w.id);
                  setOpen(false);
                }}
              >
                <span className="menu-icon ws-initial">{w.name.slice(0, 1).toUpperCase()}</span>
                <span className="menu-label">{w.name}</span>
                <span className="menu-hint">{w.kind === "personal" ? t("ws.personal") : t("ws.shared")}</span>
              </button>
            ))}
            <div className="menu-sep" />
            <button
              className="menu-item"
              onClick={() => {
                setDialog("workspace");
                setOpen(false);
              }}
            >
              <span className="menu-icon">
                <Plus size={14} />
              </span>
              <span className="menu-label">{t("ws.create")}</span>
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function ExtNav({ page }: { page: ExtPage }) {
  const t = useT();
  const view = useStore((s) => s.view);
  const go = useStore((s) => s.go);
  const badge = page.useBadge?.();
  return (
    <button className={`sb-row ${view.kind === "ext" && view.id === page.id ? "active" : ""}`} onClick={() => go({ kind: "ext", id: page.id })}>
      <page.icon size={15} />
      <span className="truncate">{t(page.label)}</span>
      {badge ? <span className="sb-count">{badge}</span> : null}
    </button>
  );
}

function PeopleRows() {
  const data = useWsData();
  const presence = Object.values(data.presence ?? {});
  const threads = useWorkspaceThreads();
  if (!presence.length) return null;
  return (
    <>
      {presence.map((p) => {
        const th = threads.find((x) => x.id === p.viewing);
        return (
          <div key={p.user.id} className="sb-row person">
            <span className="person-avatar" style={{ background: personColor(p.user.name) }}>
              {p.user.name.slice(0, 1)}
            </span>
            <span className="truncate">{p.user.name}</span>
            {th && <span className="sb-meta truncate person-where">{th.title}</span>}
          </div>
        );
      })}
    </>
  );
}

export function personColor(name: string) {
  const hues = [12, 32, 145, 200, 225, 262, 300, 340];
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `hsl(${hues[h % hues.length]} 62% 52%)`;
}

function UserRow() {
  const name = useStore((s) => s.hub.user?.name ?? s.userName);
  const ws = useStore((s) => s.workspaces.find((w) => w.id === s.workspaceId));
  const go = useStore((s) => s.go);
  return (
    <button className="user-row" onClick={() => go({ kind: "settings" })}>
      <span className="user-avatar">{name.slice(0, 1).toUpperCase()}</span>
      <span className="user-text">
        <span className="user-name">{name}</span>
        <span className="user-ws">{ws?.name ?? ""}</span>
      </span>
    </button>
  );
}
