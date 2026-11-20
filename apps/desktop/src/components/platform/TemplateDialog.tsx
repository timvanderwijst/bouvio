import { useState } from "react";
import { backend } from "../../backend";
import { useT } from "../../i18n";
import type { Workspace } from "../../protocol/Workspace";
import { rpc, useStore } from "../../store";
import { Dialog } from "../Dialog";
import { usePlatform } from "./state";
import { TemplatePicker, useTemplates } from "./TemplatePicker";

/** "New workspace from template…": a name, an optional folder, a template. */
export function TemplateDialog() {
  const t = useT();
  const templates = useTemplates();
  const [template, setTemplate] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [root, setRoot] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => usePlatform.setState({ dialog: null });
  const chosen = template ?? templates?.[0]?.id ?? null;

  const pick = async () => {
    const dir = await backend.pickFolder();
    if (!dir) return;
    setRoot(dir);
    if (!name) setName(dir.split(/[\\/]/).filter(Boolean).pop() ?? "");
  };

  const submit = async () => {
    if (!chosen || busy) return;
    setBusy(true);
    setError(null);
    try {
      const fallback = templates?.find((x) => x.id === chosen)?.name ?? "";
      const w = await rpc<Workspace>("create_workspace_from_template", { name: name.trim() || fallback, root, template_id: chosen }, null);
      useStore.setState((s) => ({ workspaces: [...s.workspaces, w] }));
      close();
      await useStore.getState().selectWorkspace(w.id);
    } catch (e) {
      setError(String(e).replace(/^Error: /, ""));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title={t("platform.templates.title")} onClose={close}>
      <form
        className="form pf-template-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="field">
          <span>{t("platform.templates.pick")}</span>
          <TemplatePicker blank={false} value={chosen} onChange={(id) => setTemplate(id)} templates={templates ?? undefined} />
        </div>
        <label className="field">
          <span>{t("ws.name")}</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={templates?.find((x) => x.id === chosen)?.name ?? ""} />
        </label>
        <div className="field">
          <span>{t("ws.folder")}</span>
          <div className="folder">
            <span className={`folder-path mono truncate ${root ? "" : "muted"}`}>{root ?? t("ws.folderNone")}</span>
            <button type="button" className="btn" onClick={pick}>
              {t("ws.chooseFolder")}
            </button>
          </div>
        </div>
        {error && <p className="form-error">{error}</p>}
        <div className="form-actions">
          <button type="button" className="btn ghost" onClick={close}>
            {t("common.cancel")}
          </button>
          <button type="submit" className={`btn primary ${busy ? "is-busy" : ""}`} disabled={!chosen || busy}>
            {t("platform.templates.create")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
