import { useState } from "react";
import { backend } from "../backend";
import { useT } from "../i18n";
import { useStore } from "../store";
import { Dialog } from "./Dialog";

export function Dialogs() {
  const dialog = useStore((s) => s.dialog);
  if (dialog === "workspace") return <WorkspaceDialog />;
  if (dialog === "captain") return <CaptainDialog />;
  return null;
}

function WorkspaceDialog() {
  const t = useT();
  const setDialog = useStore((s) => s.setDialog);
  const create = useStore((s) => s.createWorkspace);
  const [name, setName] = useState("");
  const [root, setRoot] = useState<string | null>(null);
  const [shake, setShake] = useState(false);

  const pick = async () => {
    const dir = await backend.pickFolder();
    if (!dir) return;
    setRoot(dir);
    if (!name) setName(dir.split(/[\\/]/).filter(Boolean).pop() ?? "");
  };

  return (
    <Dialog title={t("ws.create")} onClose={() => setDialog(null)}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) {
            setShake(true);
            setTimeout(() => setShake(false), 400);
            return;
          }
          create(name.trim(), root);
        }}
      >
        <label className="field">
          <span>{t("ws.name")}</span>
          <input className={`input ${shake ? "nudge" : ""}`} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Bouvio" />
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
        <div className="form-actions">
          <button type="button" className="btn ghost" onClick={() => setDialog(null)}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn primary">
            {t("ws.createButton")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function CaptainDialog() {
  const t = useT();
  const setDialog = useStore((s) => s.setDialog);
  const create = useStore((s) => s.createCaptain);
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [shake, setShake] = useState(false);
  return (
    <Dialog title={t("ws.newCaptain")} onClose={() => setDialog(null)}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) {
            setShake(true);
            setTimeout(() => setShake(false), 400);
            return;
          }
          create(name.trim(), instructions);
        }}
      >
        <label className="field">
          <span>{t("captain.name")}</span>
          <input className={`input ${shake ? "nudge" : ""}`} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Web" />
        </label>
        <label className="field">
          <span>{t("captain.instructions")}</span>
          <textarea className="input" rows={4} value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder={t("captain.instructionsHint")} />
        </label>
        <div className="form-actions">
          <button type="button" className="btn ghost" onClick={() => setDialog(null)}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn primary">
            {t("captain.create")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
