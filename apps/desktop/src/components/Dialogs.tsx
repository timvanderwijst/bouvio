import { Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { backend } from "../backend";
import { useT } from "../i18n";
import type { Automation } from "../protocol/Automation";
import type { Member } from "../protocol/Member";
import type { Role } from "../protocol/Role";
import type { Workspace } from "../protocol/Workspace";
import { rpc, useStore, useWorkspace, useWorkspaceCaptains, useWsData } from "../store";
import { Dialog } from "./Dialog";
import { Menu } from "./Menu";
import { PixelAvatar } from "./PixelAvatar";
import { personColor } from "./Sidebar";
import { describeCron } from "./Work";
import { TemplatePicker } from "./platform/TemplatePicker";

export function Dialogs() {
  const dialog = useStore((s) => s.dialog);
  if (dialog === "workspace") return <WorkspaceDialog />;
  if (dialog === "captain") return <CaptainDialog />;
  if (dialog === "issue") return <IssueDialog />;
  if (dialog === "automation") return <AutomationDialog />;
  if (dialog === "signin") return <SignInDialog />;
  if (dialog === "join") return <JoinDialog />;
  if (dialog === "share") return <ShareDialog />;
  return null;
}

function WorkspaceDialog() {
  const t = useT();
  const setDialog = useStore((s) => s.setDialog);
  const create = useStore((s) => s.createWorkspace);
  const notify = useStore((s) => s.notify);
  const [name, setName] = useState("");
  const [root, setRoot] = useState<string | null>(null);
  const [template, setTemplate] = useState<string | null>(null);
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
          if (!template) return create(name.trim(), root);
          // A template sets up captains, issues and automations in one go.
          rpc<Workspace>("create_workspace_from_template", { name: name.trim(), root, template_id: template }, null)
            .then(async (w) => {
              useStore.setState((s) => ({ workspaces: [...s.workspaces, w], dialog: null }));
              await useStore.getState().selectWorkspace(w.id);
            })
            .catch((e) => notify(String(e)));
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
        <TemplatePicker value={template} onChange={(id) => setTemplate(id)} blank />
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

function useShake() {
  const [shake, setShake] = useState(false);
  return [shake, () => (setShake(true), setTimeout(() => setShake(false), 400))] as const;
}

function IssueDialog() {
  const t = useT();
  const setDialog = useStore((s) => s.setDialog);
  const notify = useStore((s) => s.notify);
  const captains = useWorkspaceCaptains();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [captain, setCaptain] = useState<string | null>(null);
  const [shake, nudge] = useShake();
  return (
    <Dialog title={t("issues.new")} onClose={() => setDialog(null)}>
      <form
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!title.trim()) return nudge();
          try {
            await rpc("create_issue", { workspace_id: useStore.getState().workspaceId, title: title.trim(), body, captain_id: captain });
            setDialog(null);
          } catch (err) {
            notify(String(err));
          }
        }}
      >
        <input className={`input big ${shake ? "nudge" : ""}`} autoFocus value={title} placeholder={t("issues.titleHint")} onChange={(e) => setTitle(e.target.value)} />
        <textarea className="input" rows={5} value={body} placeholder={t("issues.bodyHint")} onChange={(e) => setBody(e.target.value)} />
        <div className="form-actions spread">
          <Menu
            value={captain}
            items={[{ value: null, label: t("issues.noCaptain") }, ...captains.map((c) => ({ value: c.id as string | null, label: c.name, icon: <PixelAvatar seed={c.avatar_seed} size={14} /> }))]}
            onChange={setCaptain}
          />
          <button type="submit" className="btn primary">
            {t("issues.create")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

const SCHEDULES = ["0 8 * * 1-5", "0 9 * * *", "30 7 * * 1", "0 16 * * 5", "0 * * * *"];

function AutomationDialog() {
  const t = useT();
  const setDialog = useStore((s) => s.setDialog);
  const existing = useStore((s) => s.dialogArg) as Automation | null;
  const notify = useStore((s) => s.notify);
  const captains = useWorkspaceCaptains();
  const [a, setA] = useState<Automation>(
    existing ?? {
      id: "00000000-0000-0000-0000-000000000000",
      workspace_id: useStore.getState().workspaceId!,
      name: "",
      schedule: "0 8 * * 1-5",
      prompt: "",
      captain_id: null,
      enabled: true,
      last_run: null,
      last_thread: null,
    },
  );
  const [shake, nudge] = useShake();
  const lang = document.documentElement.lang;
  return (
    <Dialog title={existing ? existing.name : t("auto.new")} onClose={() => setDialog(null)}>
      <form
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!a.name.trim() || !a.prompt.trim()) return nudge();
          try {
            await rpc(existing ? "update_automation" : "create_automation", { automation: a });
            setDialog(null);
          } catch (err) {
            notify(String(err));
            nudge();
          }
        }}
      >
        <input className={`input big ${shake ? "nudge" : ""}`} autoFocus value={a.name} placeholder={t("auto.nameHint")} onChange={(e) => setA({ ...a, name: e.target.value })} />
        <textarea className="input" rows={4} value={a.prompt} placeholder={t("auto.promptHint")} onChange={(e) => setA({ ...a, prompt: e.target.value })} />
        <div className="field">
          <span>{t("auto.when")}</span>
          <div className="schedule">
            {SCHEDULES.map((c) => (
              <button type="button" key={c} className={`chip-btn ${a.schedule === c ? "on" : ""}`} onClick={() => setA({ ...a, schedule: c })}>
                {describeCron(c, lang)}
              </button>
            ))}
          </div>
          <input className="input mono" value={a.schedule} onChange={(e) => setA({ ...a, schedule: e.target.value })} />
        </div>
        <div className="form-actions spread">
          <Menu
            value={a.captain_id}
            items={[{ value: null, label: t("issues.noCaptain") }, ...captains.map((c) => ({ value: c.id as string | null, label: c.name, icon: <PixelAvatar seed={c.avatar_seed} size={14} /> }))]}
            onChange={(c) => setA({ ...a, captain_id: c })}
          />
          <div className="form-actions">
            {existing && (
              <button
                type="button"
                className="btn ghost"
                onClick={async () => {
                  await rpc("delete_automation", { id: existing.id });
                  setDialog(null);
                }}
              >
                {t("common.delete")}
              </button>
            )}
            <button type="submit" className="btn primary">
              {t("common.save")}
            </button>
          </div>
        </div>
      </form>
    </Dialog>
  );
}

function SignInDialog() {
  const t = useT();
  const hub = useStore((s) => s.hub);
  const setDialog = useStore((s) => s.setDialog);
  const refreshHub = useStore((s) => s.refreshHub);
  const [url, setUrl] = useState(hub.url ?? "");
  const [step, setStep] = useState<"url" | "email" | "code" | "paste">(hub.url ? "email" : "url");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [shake, nudge] = useShake();
  const fail = (e: unknown) => (setError(String(e).replace(/^Error: /, "")), nudge());
  const done = async () => {
    await refreshHub();
    setDialog(null);
  };
  const oauth = async (p: "google" | "github") => {
    await backend.openUrl(`${url.replace(/\/$/, "")}/auth/${p}/start`);
    setStep("paste");
  };

  return (
    <Dialog title={t("hub.signIn")} onClose={() => setDialog(null)}>
      <form
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          try {
            if (step === "url") {
              await backend.hub.setUrl(url);
              setStep("email");
            } else if (step === "email") {
              await backend.hub.request("POST", "/auth/email/start", { email });
              setStep("code");
            } else if (step === "code") {
              await backend.hub.signIn("/auth/email/verify", { email, code: code.trim() });
              await done();
            } else {
              await backend.hub.signIn("/auth/exchange", { code: code.trim() });
              await done();
            }
          } catch (err) {
            fail(err);
          }
        }}
      >
        {step === "url" && (
          <label className="field">
            <span>{t("hub.address")}</span>
            <input className={`input ${shake ? "nudge" : ""}`} autoFocus value={url} placeholder="https://hub.example.com" onChange={(e) => setUrl(e.target.value)} />
            <span className="field-hint">{t("hub.addressHint")}</span>
          </label>
        )}
        {step === "email" && (
          <>
            <div className="oauth">
              <button type="button" className="btn" onClick={() => oauth("google")}>
                Google
              </button>
              <button type="button" className="btn" onClick={() => oauth("github")}>
                GitHub
              </button>
            </div>
            <div className="or">{t("hub.orEmail")}</div>
            <input className={`input ${shake ? "nudge" : ""}`} type="email" autoFocus value={email} placeholder="you@example.com" onChange={(e) => setEmail(e.target.value)} />
          </>
        )}
        {(step === "code" || step === "paste") && (
          <label className="field">
            <span>{step === "code" ? t("hub.codeSent", { email }) : t("hub.pasteCode")}</span>
            <input className={`input big mono center ${shake ? "nudge" : ""}`} autoFocus value={code} onChange={(e) => setCode(e.target.value)} />
          </label>
        )}
        {error && <p className="form-error">{error}</p>}
        <div className="form-actions">
          <button type="button" className="btn ghost" onClick={() => setDialog(null)}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn primary">
            {step === "url" || step === "email" ? t("common.continue") : t("hub.signIn")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function JoinDialog() {
  const t = useT();
  const setDialog = useStore((s) => s.setDialog);
  const refreshHub = useStore((s) => s.refreshHub);
  const [code, setCode] = useState("");
  const [shake, nudge] = useShake();
  return (
    <Dialog title={t("people.join")} onClose={() => setDialog(null)}>
      <form
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await backend.hub.join(code);
            await refreshHub();
            setDialog(null);
          } catch {
            nudge();
          }
        }}
      >
        <input className={`input big mono center ${shake ? "nudge" : ""}`} autoFocus value={code} placeholder="K7Q2MX9A2B" onChange={(e) => setCode(e.target.value)} />
        <div className="form-actions">
          <button type="submit" className="btn primary">
            {t("people.join")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

const ROLES: Role[] = ["viewer", "commenter", "prompter", "operator", "admin"];

function ShareDialog() {
  const t = useT();
  const ws = useWorkspace();
  const hub = useStore((s) => s.hub);
  const setDialog = useStore((s) => s.setDialog);
  const notify = useStore((s) => s.notify);
  const refreshHub = useStore((s) => s.refreshHub);
  const load = useStore((s) => s.load);
  const data = useWsData();
  const [role, setRole] = useState<Role>("operator");
  const [invite, setInvite] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const shared = ws?.kind === "shared";
  const mine = shared && !ws?.host;
  useEffect(() => {
    if (shared) load("members", true);
  }, [shared, load]);

  if (!hub.user) {
    return (
      <Dialog title={t("share.title")} onClose={() => setDialog(null)}>
        <p className="dialog-text">{t("share.needHub")}</p>
        <div className="form-actions">
          <button className="btn primary" onClick={() => setDialog("signin")}>
            {t("hub.signIn")}
          </button>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog title={t("share.titleWs", { name: ws?.name ?? "" })} onClose={() => setDialog(null)}>
      {!shared ? (
        <>
          <p className="dialog-text">{t("share.explain")}</p>
          <div className="form-actions">
            <button
              className="btn primary"
              onClick={async () => {
                try {
                  await backend.hub.share(ws!.id);
                  await refreshHub();
                } catch (e) {
                  notify(String(e));
                }
              }}
            >
              {t("share.start")}
            </button>
          </div>
        </>
      ) : (
        <div className="form">
          {mine && (
            <div className="invite">
              <Menu value={role} items={ROLES.map((r) => ({ value: r, label: t(`role.${r}`), hint: t(`role.${r}.hint`) }))} onChange={setRole} />
              {invite ? (
                <button
                  className="code-copy grow"
                  onClick={() => {
                    navigator.clipboard.writeText(invite);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  }}
                >
                  <code className="truncate">{invite}</code>
                  <Copy size={13} />
                  {copied && <span className="copied">{t("common.copied")}</span>}
                </button>
              ) : (
                <button
                  className="btn primary"
                  onClick={async () => {
                    try {
                      const r = await backend.hub.request<{ url: string }>("POST", `/workspaces/${ws!.id}/invites`, { role });
                      setInvite(r.url);
                    } catch (e) {
                      notify(String(e));
                    }
                  }}
                >
                  {t("share.invite")}
                </button>
              )}
            </div>
          )}
          <div className="members">
            {(data.members ?? []).map((m: Member) => (
              <div key={m.user.id} className="member">
                <span className="person-avatar lg" style={{ background: personColor(m.user.name) }}>
                  {m.user.name.slice(0, 1)}
                  {m.online && <i className="dot-online" />}
                </span>
                <span className="user-text">
                  <b>{m.user.name}</b>
                  <span className="user-ws">{m.user.email}</span>
                </span>
                <div className="composer-spacer" />
                {mine && m.user.id !== hub.user!.id ? (
                  <Menu
                    value={m.role}
                    items={ROLES.map((r) => ({ value: r, label: t(`role.${r}`) }))}
                    onChange={async (r) => {
                      await backend.hub.request("PATCH", `/workspaces/${ws!.id}/members/${m.user.id}`, { role: r });
                      load("members", true);
                    }}
                  />
                ) : (
                  <span className="list-meta">{t(`role.${m.role}`)}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </Dialog>
  );
}
