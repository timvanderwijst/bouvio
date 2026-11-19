import { useEffect } from "react";
import { backend } from "./backend";
import { CommandPalette } from "./components/CommandPalette";
import { Dialogs } from "./components/Dialogs";
import { Main } from "./components/Main";
import { Home, Settings, Soon, ThreadsPage, WorkspacesPage } from "./components/Pages";
import { Panel } from "./components/Panel";
import { Rail } from "./components/Rail";
import { Sidebar } from "./components/Sidebar";
import { useT } from "./i18n";
import { applyTheme, useStore, useWorkspaceThreads } from "./store";

export function App() {
  const t = useT();
  const ready = useStore((s) => s.ready);
  const view = useStore((s) => s.view);
  const panelOpen = useStore((s) => s.panel.open);
  const panelWide = useStore((s) => s.panel.wide);
  const theme = useStore((s) => s.theme);
  const workspaceId = useStore((s) => s.workspaceId);
  const threads = useWorkspaceThreads();
  const thread = view.kind === "thread" ? threads.find((x) => x.id === view.id) ?? null : null;

  useEffect(() => {
    useStore.getState().init();
  }, []);

  // Follow the OS when the theme is "system".
  useEffect(() => {
    if (theme !== "system") return;
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const on = () => applyTheme("system");
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [theme]);

  const inWorkspace = view.kind === "thread" || view.kind === "draft";
  const showSidebar = !!workspaceId && view.kind !== "home" && view.kind !== "workspaces" && view.kind !== "settings";

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
      <Dialogs />
      <CommandPalette />
    </div>
  );
}

function PageView() {
  const view = useStore((s) => s.view);
  return (
    <section className="main page-host">
      {view.kind === "home" && <Home />}
      {view.kind === "settings" && <Settings />}
      {view.kind === "workspaces" && <WorkspacesPage />}
      {view.kind === "threads" && <ThreadsPage />}
      {view.kind === "soon" && <Soon page={view.page} />}
    </section>
  );
}
