import { useEffect } from "react";
import { backend } from "./backend";
import { CommandPalette } from "./components/CommandPalette";
import { Dialogs } from "./components/Dialogs";
import { Main } from "./components/Main";
import { Home, Settings, ThreadsPage, WorkspacesPage } from "./components/Pages";
import { BoardView } from "./components/BoardView";
import { FilesPage, KnowledgePage, PeoplePage, RunnersPage } from "./components/More";
import { StudioPage } from "./components/Studio";
import { AutomationsPage, IssuesPage, PullRequestsPage } from "./components/Work";
import { Panel } from "./components/Panel";
import { Rail } from "./components/Rail";
import { Sidebar } from "./components/Sidebar";
import { useT } from "./i18n";
import { extOverlays, findPage, useExtVersion } from "./ext/areas";
import { applyTheme, useStore, useWorkspaceThreads } from "./store";

export function App() {
  const t = useT();
  useExtVersion();
  const ready = useStore((s) => s.ready);
  const view = useStore((s) => s.view);
  const panelOpen = useStore((s) => s.panel.open);
  const panelWide = useStore((s) => s.panel.wide);
  const theme = useStore((s) => s.theme);
  const workspaceId = useStore((s) => s.workspaceId);
  const threads = useWorkspaceThreads();
  const thread = view.kind === "thread" ? threads.find((x) => x.id === view.id) ?? null : null;

  useEffect(() => {
    // A runner that fails to answer must not leave a blank window.
    useStore
      .getState()
      .init()
      .catch((e) => {
        useStore.setState({ ready: true });
        useStore.getState().notify(String(e));
      });
  }, []);

  // The sidebar shows open issues; settings decide which dev tools show.
  useEffect(() => {
    if (!workspaceId) return;
    useStore.getState().load("issues");
    useStore.getState().load("settings");
  }, [workspaceId]);

  // Follow the OS when the theme is "system".
  useEffect(() => {
    if (theme !== "system") return;
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const on = () => applyTheme("system");
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [theme]);

  const inWorkspace = view.kind === "thread" || view.kind === "draft";
  const extPage = view.kind === "ext" ? findPage(view.id) : undefined;
  const showSidebar =
    !!workspaceId && view.kind !== "home" && view.kind !== "workspaces" && view.kind !== "settings" && view.kind !== "rail" && extPage?.place !== "rail";
  const toast = useStore((s) => s.toast);

  return (
    <div className={`app ${ready ? "ready" : ""}`}>
      <Rail />
      {showSidebar && <Sidebar />}
      <div className={`stage ${showSidebar ? "" : "full"}`}>
        <div className={`sheet ${inWorkspace && panelOpen ? "with-panel" : ""} ${panelWide ? "panel-wide" : ""}`}>
          {inWorkspace ? <Main thread={thread} /> : <PageView />}
          {inWorkspace && panelOpen && <Panel thread={thread} />}
        </div>
      </div>
      {!backend.live && <div className="preview-note">{t("common.preview")}</div>}
      {toast && (
        <div className="toast" role="status" onClick={() => useStore.setState({ toast: null })}>
          {toast}
        </div>
      )}
      {extOverlays().map((o) => (
        <o.component key={o.id} />
      ))}
      <Dialogs />
      <CommandPalette />
    </div>
  );
}

/** Old routes that now live in a feature area. */
function ExtRedirect({ id }: { id: string }) {
  useEffect(() => useStore.getState().go({ kind: "ext", id }), [id]);
  return null;
}

function PageView() {
  const view = useStore((s) => s.view);
  return (
    <section className={`main page-host ${view.kind === "board" || (view.kind === "page" && view.page === "chat") || (view.kind === "ext" && findPage(view.id)?.flush) ? "flush" : ""}`}>
      {view.kind === "home" && <Home />}
      {view.kind === "settings" && <Settings />}
      {view.kind === "workspaces" && <WorkspacesPage />}
      {view.kind === "threads" && <ThreadsPage />}
      {view.kind === "rail" && view.page === "runners" && <RunnersPage />}
      {view.kind === "rail" && view.page === "people" && <PeoplePage />}
      {view.kind === "page" && view.page === "issues" && <IssuesPage />}
      {view.kind === "page" && view.page === "pullRequests" && <PullRequestsPage />}
      {view.kind === "page" && view.page === "automations" && <AutomationsPage />}
      {view.kind === "page" && view.page === "studio" && <StudioPage sub={view.sub} />}
      {view.kind === "page" && view.page === "files" && <FilesPage />}
      {view.kind === "page" && view.page === "knowledge" && <KnowledgePage />}
      {view.kind === "page" && view.page === "chat" && <ExtRedirect id="comms.chat" />}
      {view.kind === "board" && <BoardView id={view.id} />}
      {view.kind === "ext" && (() => {
        const P = findPage(view.id);
        return P ? <P.component sub={view.sub} /> : null;
      })()}
    </section>
  );
}
