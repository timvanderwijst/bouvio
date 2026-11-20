import { Download, Upload } from "lucide-react";
import { useState } from "react";
import { backend, target } from "../../backend";
import { t, useT } from "../../i18n";
import type { ExportSummary } from "../../protocol/ExportSummary";
import type { ImportSummary } from "../../protocol/ImportSummary";
import { rpc, useStore, useWorkspace } from "../../store";

const zipFilter = () => [{ name: t("platform.backup.fileType"), extensions: ["zip"] }];

/** Ask where to save, then write the current workspace there. */
export async function exportWorkspace() {
  const s = useStore.getState();
  const ws = s.workspaces.find((w) => w.id === s.workspaceId);
  if (!ws) return s.notify(t("platform.backup.noWorkspace"));
  if (ws.host) return s.notify(t("platform.backup.remote"));
  try {
    const stamp = new Date().toISOString().slice(0, 10);
    const safe = ws.name.replace(/[\\/:*?"<>|]+/g, "-").trim() || "workspace";
    const path = await backend.app<string | null>("dialog_save", { name: `${safe} ${stamp}.zip`, filters: zipFilter() });
    if (!path) return;
    const out = await rpc<ExportSummary>("export_workspace", { workspace_id: ws.id, path }, ws.id);
    let msg = t("platform.backup.exported", { threads: out.threads, path: out.path });
    if (out.artifacts_skipped) msg += ` ${t("platform.backup.skipped", { count: out.artifacts_skipped })}`;
    s.notify(msg);
  } catch (e) {
    s.notify(String(e));
  }
}

/** Ask for a backup zip and open it as a new workspace. */
export async function importWorkspace() {
  const s = useStore.getState();
  try {
    const path = await backend.app<string | null>("dialog_open", { filters: zipFilter() });
    if (!path) return;
    const out = await rpc<ImportSummary>("import_workspace", { path }, null);
    const w = out.workspace;
    useStore.setState((st) => ({ workspaces: [...st.workspaces.filter((x) => x.id !== w.id), w] }));
    await useStore.getState().selectWorkspace(w.id);
    s.notify(t("platform.backup.imported", { name: w.name, threads: out.threads, issues: out.issues }));
  } catch (e) {
    s.notify(String(e));
  }
}

/** Settings → Backup. */
export function BackupSettings() {
  const t = useT();
  const ws = useWorkspace();
  const [busy, setBusy] = useState<null | "export" | "import">(null);
  if (target === "web") return null;
  const run = async (which: "export" | "import", f: () => Promise<unknown>) => {
    setBusy(which);
    try {
      await f();
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="set-group">
      <h2>{t("platform.backup")}</h2>
      <div className="set-row">
        <span className="pf-col">
          <span>{ws ? ws.name : t("platform.backup.noWorkspace")}</span>
          <span className="pf-hint">{ws?.host ? t("platform.backup.remote") : t("platform.backup.exportHint")}</span>
        </span>
        <button className={`btn small ${busy === "export" ? "is-busy" : ""}`} disabled={!ws || !!ws.host || !!busy} onClick={() => run("export", exportWorkspace)}>
          <Download size={13} />
          {busy === "export" ? t("platform.backup.working") : t("platform.backup.export")}
        </button>
      </div>
      <div className="set-row">
        <span className="pf-hint">{t("platform.backup.importHint")}</span>
        <button className={`btn small ${busy === "import" ? "is-busy" : ""}`} disabled={!!busy} onClick={() => run("import", importWorkspace)}>
          <Upload size={13} />
          {busy === "import" ? t("platform.backup.working") : t("platform.backup.import")}
        </button>
      </div>
    </section>
  );
}
