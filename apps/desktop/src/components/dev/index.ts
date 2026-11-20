import { Code2, Database, Globe } from "lucide-react";
import type { ExtArea } from "../../ext/types";
import { t } from "../../i18n";
import { useStore } from "../../store";
import { BrowserPanel } from "./Browser";
import { DevPage } from "./DevPage";
import { ReviewPanel } from "./Review";
import { useDev } from "./state";
import "./dev.css";

export { useProxiedUrl } from "./Browser";

/** Show the thread's app in the panel: the open thread, or the latest one. */
async function openBrowser() {
  const s = useStore.getState();
  let id = s.view.kind === "thread" ? s.view.id : null;
  if (!id) {
    const threads = (s.workspaceId ? s.threads[s.workspaceId] : undefined) ?? [];
    id = [...threads].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).find((x) => x.cwd)?.id ?? null;
    if (!id) return s.notify(t("dev.browser.noThread"));
    await s.openThread(id);
  }
  useStore.getState().setPanel({ open: true, tab: "dev.browser" });
}

function runSql() {
  useDev.setState((d) => ({ tab: "data", dataMode: "sql", sqlFocus: d.sqlFocus + 1 }));
  useStore.getState().go({ kind: "ext", id: "dev", sub: "data" });
}

export const area: ExtArea = {
  id: "dev",
  pages: [{ id: "dev", place: "workspace", label: "dev.page", icon: Code2, component: DevPage, order: 55, flush: true }],
  panels: [
    { id: "dev.browser", label: "dev.browser", component: BrowserPanel },
    { id: "dev.review", label: "dev.review", component: ReviewPanel },
  ],
  commands: [
    { id: "dev.openBrowser", label: "dev.cmd.browser", icon: Globe, run: () => void openBrowser() },
    { id: "dev.runSql", label: "dev.cmd.sql", icon: Database, run: runSql },
  ],
};
