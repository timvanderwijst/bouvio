import { PanelRight, Plus, X } from "lucide-react";
import { useT } from "../i18n";
import type { Thread } from "../protocol/Thread";
import { useStore, useWorkspaceCaptains, useWorkspaceThreads, useWsData } from "../store";
import { personColor } from "./Sidebar";
import { cost } from "../lib/format";
import { Composer } from "./Composer";
import { PixelAvatar } from "./PixelAvatar";
import { StatusIcon } from "./StatusIcon";
import { ThreadView } from "./ThreadView";

export function Main({ thread }: { thread: Thread | null }) {
  const t = useT();
  const view = useStore((s) => s.view);
  const captains = useWorkspaceCaptains();
  const captain = view.kind === "draft" ? captains.find((c) => c.id === view.captainId) : null;

  return (
    <section className="main">
      <TabBar thread={thread} />
      {thread ? (
        <>
          <ThreadView thread={thread} />
          <Composer thread={thread} />
        </>
      ) : (
        <div className="draft">
          <div className="draft-inner">
            {captain && (
              <span className="draft-avatar">
                <PixelAvatar seed={captain.avatar_seed} size={40} />
              </span>
            )}
            <h1 className="display">{captain ? t("thread.emptyIn", { name: captain.name }) : t("thread.empty")}</h1>
            <Composer thread={null} />
          </div>
        </div>
      )}
    </section>
  );
}

function TabBar({ thread }: { thread: Thread | null }) {
  const t = useT();
  const workspaceId = useStore((s) => s.workspaceId);
  const tabIds = useStore((s) => (workspaceId ? s.tabs[workspaceId] : undefined)) ?? NO_TABS;
  const threads = useWorkspaceThreads();
  const captains = useWorkspaceCaptains();
  const openThread = useStore((s) => s.openThread);
  const closeTab = useStore((s) => s.closeTab);
  const go = useStore((s) => s.go);
  const panel = useStore((s) => s.panel);
  const setPanel = useStore((s) => s.setPanel);

  return (
    <header className="tabbar">
      <div className="tabs">
        {tabIds.map((id) => {
          const th = threads.find((x) => x.id === id);
          if (!th) return null;
          const c = captains.find((x) => x.id === th.captain_id);
          const on = thread?.id === id;
          return (
            <div key={id} className={`tab ${on ? "on" : ""}`}>
              <button className="tab-main" onClick={() => openThread(id)} title={th.title}>
                {c ? <PixelAvatar seed={c.avatar_seed} size={16} /> : <StatusIcon status={th.status} size={13} />}
                <span className="truncate">{th.title}</span>
                {c && th.status !== "idle" && <StatusIcon status={th.status} size={12} />}
              </button>
              <button className="tab-x" onClick={() => closeTab(id)} aria-label="Close">
                <X size={12} />
              </button>
            </div>
          );
        })}
        <button className="icon-btn" onClick={() => go({ kind: "draft", captainId: null })} aria-label={t("ws.newThread")} title={t("ws.newThread")}>
          <Plus size={15} />
        </button>
      </div>
      <div className="tabbar-right">
        <Watchers threadId={thread?.id} />
        {thread && thread.cost_usd > 0 && <span className="cost num">{cost(thread.cost_usd)}</span>}
        {!panel.open && (
          <button className="icon-btn" onClick={() => setPanel({ open: true })} aria-label={t("panel.open")} title={t("panel.open")}>
            <PanelRight size={15} />
          </button>
        )}
      </div>
    </header>
  );
}

const NO_TABS: string[] = [];

/** Who else is looking at this thread right now. */
function Watchers({ threadId }: { threadId?: string }) {
  const presence = useWsData().presence;
  const me = useStore((s) => s.hub.user?.id);
  const here = Object.values(presence ?? {}).filter((p) => p.viewing === threadId && p.user.id !== me);
  if (!threadId || !here.length) return null;
  return (
    <div className="watchers">
      {here.map((p) => (
        <span key={p.user.id} className="person-avatar" style={{ background: personColor(p.user.name) }} title={p.user.name}>
          {p.user.name.slice(0, 1)}
        </span>
      ))}
    </div>
  );
}
