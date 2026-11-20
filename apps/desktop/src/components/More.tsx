import { ChevronRight, Copy, File, Folder, LogOut, Monitor, Plus, Server, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { backend } from "../backend";
import { useT } from "../i18n";
import type { FileEntry } from "../protocol/FileEntry";
import type { McpServer } from "../protocol/McpServer";
import type { ProviderKind } from "../protocol/ProviderKind";
import type { WorkspaceSettings } from "../protocol/WorkspaceSettings";
import { rpc, useStore, useWorkspace, useWsData } from "../store";
import { Markdown } from "./Markdown";
import { Empty } from "./Panel";
import { personColor } from "./Sidebar";
import { HARNESS_NAMES } from "./harness";

// ---- files -----------------------------------------------------------------------------------------

interface Preview {
  mime: string;
  text?: string;
  data_url?: string;
}

export function FilesPage({ sub }: { sub?: string } = {}) {
  const t = useT();
  const ws = useWorkspace();
  // `sub` is a path to open, e.g. from search.
  const [dir, setDir] = useState(sub ? sub.split("/").slice(0, -1).join("/") : "");
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const [file, setFile] = useState<string | null>(sub ?? null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!ws) return;
    setEntries(null);
    rpc<FileEntry[]>("list_files", { workspace_id: ws.id, dir })
      .then(setEntries)
      .catch((e) => setErr(String(e)));
  }, [ws, dir]);

  useEffect(() => {
    if (!ws || !file) return;
    setPreview(null);
    rpc<Preview>("read_file", { workspace_id: ws.id, path: file })
      .then(setPreview)
      .catch((e) => setPreview({ mime: "text/plain", text: String(e) }));
  }, [ws, file]);

  if (err) return <div className="page"><Empty text={err} /></div>;
  const crumbs = dir ? dir.split("/") : [];

  return (
    <div className="page wide files">
      <div className="page-head">
        <h1 className="page-title">{t("ws.files")}</h1>
      </div>
      <div className="files-split">
        <div className="files-list">
          <div className="crumbs">
            <button onClick={() => setDir("")}>{ws?.name}</button>
            {crumbs.map((c, i) => (
              <span key={i}>
                <ChevronRight size={12} />
                <button onClick={() => setDir(crumbs.slice(0, i + 1).join("/"))}>{c}</button>
              </span>
            ))}
          </div>
          {entries?.map((e) => (
            <button key={e.path} className={`file-row ${file === e.path ? "on" : ""}`} onClick={() => (e.dir ? setDir(e.path) : setFile(e.path))}>
              {e.dir ? <Folder size={14} /> : <File size={14} />}
              <span className="truncate">{e.name}</span>
              {!e.dir && <span className="sb-meta">{e.size < 1024 ? `${e.size} B` : `${Math.round(e.size / 1024)} KB`}</span>}
            </button>
          ))}
        </div>
        <div className="files-preview">
          {!file ? (
            <Empty text={t("files.pick")} />
          ) : !preview ? (
            <div className="preview-loading shimmer" />
          ) : preview.data_url && preview.mime.startsWith("image/") ? (
            <img src={preview.data_url} alt={file} />
          ) : preview.mime === "text/markdown" && preview.text ? (
            <div className="preview-doc">
              <Markdown text={preview.text} />
            </div>
          ) : (
            <pre className="preview-code">{preview.text ?? preview.mime}</pre>
          )}
        </div>
      </div>
    </div>
  );
}

// ---- knowledge: instructions, memory, MCP, dev server ---------------------------------------------

export function KnowledgePage() {
  const t = useT();
  const load = useStore((s) => s.load);
  const notify = useStore((s) => s.notify);
  const data = useWsData();
  const [s, setS] = useState<WorkspaceSettings | null>(null);
  const [saved, setSaved] = useState(true);
  useEffect(() => {
    load("settings");
  }, [load]);
  useEffect(() => {
    if (data.settings && saved) setS(data.settings);
  }, [data.settings]); // eslint-disable-line
  if (!s) return <div className="page"><div className="preview-loading shimmer" /></div>;
  const set = (p: Partial<WorkspaceSettings>) => {
    setS({ ...s, ...p });
    setSaved(false);
  };
  const setMcp = (i: number, p: Partial<McpServer>) => set({ mcp_servers: s.mcp_servers.map((m, j) => (j === i ? { ...m, ...p } : m)) });

  return (
    <div className="page knowledge">
      <div className="page-head">
        <h1 className="page-title">{t("ws.knowledge")}</h1>
        <div className="page-actions">
          <button
            className="btn primary"
            disabled={saved}
            onClick={async () => {
              try {
                await rpc("workspace_settings_set", { workspace_id: useStore.getState().workspaceId, settings: s });
                setSaved(true);
              } catch (e) {
                notify(String(e));
              }
            }}
          >
            {saved ? t("common.saved") : t("common.save")}
          </button>
        </div>
      </div>

      <section className="set-group">
        <h2>{t("knowledge.instructions")}</h2>
        <textarea className="input area" rows={6} value={s.instructions} placeholder={t("knowledge.instructionsHint")} onChange={(e) => set({ instructions: e.target.value })} />
      </section>
      <section className="set-group">
        <h2>{t("knowledge.memory")}</h2>
        <textarea className="input area mono" rows={6} value={s.memory} placeholder={t("knowledge.memoryHint")} onChange={(e) => set({ memory: e.target.value })} />
      </section>
      <section className="set-group">
        <h2>{t("knowledge.mcp")}</h2>
        {s.mcp_servers.map((m, i) => (
          <div className="mcp-row" key={i}>
            <input className="input" value={m.name} placeholder="name" onChange={(e) => setMcp(i, { name: e.target.value })} />
            <input
              className="input mono grow"
              value={[m.command, ...m.args].join(" ")}
              placeholder="npx -y @modelcontextprotocol/server-github"
              onChange={(e) => {
                const [command = "", ...args] = e.target.value.split(" ");
                setMcp(i, { command, args });
              }}
            />
            <button className="icon-btn" onClick={() => set({ mcp_servers: s.mcp_servers.filter((_, j) => j !== i) })}>
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        <button className="btn ghost" onClick={() => set({ mcp_servers: [...s.mcp_servers, { name: "", command: "", args: [], env: [] }] })}>
          <Plus size={14} />
          {t("knowledge.addMcp")}
        </button>
      </section>
      <section className="set-group">
        <h2>{t("knowledge.project")}</h2>
        <label className="set-row">
          <span>{t("knowledge.devCommand")}</span>
          <input className="input mono" value={s.dev_command ?? ""} placeholder="pnpm dev --port {port}" onChange={(e) => set({ dev_command: e.target.value || null })} />
        </label>
        <label className="set-row">
          <span>{t("knowledge.issuePrefix")}</span>
          <input className="input mono short" value={s.issue_prefix} onChange={(e) => set({ issue_prefix: e.target.value.toUpperCase().slice(0, 6) })} />
        </label>
        <label className="set-row">
          <span>{t("knowledge.github")}</span>
          <input className="input mono" value={s.github_repo ?? ""} placeholder="owner/repo" onChange={(e) => set({ github_repo: e.target.value || null })} />
        </label>
      </section>
    </div>
  );
}

// ---- rail: runners and people ---------------------------------------------------------------------------

export function RunnersPage() {
  const t = useT();
  const harnesses = useStore((s) => s.harnesses);
  const hub = useStore((s) => s.hub);
  const [copied, setCopied] = useState(false);
  const cmd = `bouvio-runner serve --hub ${hub.url ?? "https://your-hub"} --token <token>`;
  return (
    <div className="page">
      <h1 className="page-title">{t("nav.runners")}</h1>
      <div className="runner-card">
        <div className="runner-head">
          <Monitor size={16} />
          <b>{t("composer.thisComputer")}</b>
          <span className="online" />
        </div>
        {harnesses.map((h) => (
          <div key={h.kind} className="set-row">
            <span>{HARNESS_NAMES[h.kind]}</span>
            <span className={`set-state ${h.available ? (h.kind === "api" ? "" : "ok") : "off"}`}>
              {h.kind === "api" ? t("runners.apiLoop") : h.available ? h.version ?? t("settings.ready") : t("settings.notFound")}
            </span>
          </div>
        ))}
      </div>
      <div className="runner-card">
        <div className="runner-head">
          <Server size={16} />
          <b>{t("runners.vps")}</b>
        </div>
        <p className="runner-text">{t("runners.vpsHint")}</p>
        <div className="code-copy">
          <code>{cmd}</code>
          <button
            className="icon-btn"
            onClick={() => {
              navigator.clipboard.writeText(cmd);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            <Copy size={13} />
          </button>
          {copied && <span className="copied">{t("common.copied")}</span>}
        </div>
      </div>
    </div>
  );
}

export function PeoplePage() {
  const t = useT();
  const hub = useStore((s) => s.hub);
  const workspaces = useStore((s) => s.workspaces);
  const setDialog = useStore((s) => s.setDialog);
  const selectWorkspace = useStore((s) => s.selectWorkspace);
  const refreshHub = useStore((s) => s.refreshHub);
  const shared = useMemo(() => workspaces.filter((w) => w.kind === "shared"), [workspaces]);
  return (
    <div className="page">
      <h1 className="page-title">{t("nav.people")}</h1>
      {!hub.user ? (
        <div className="home-empty">
          <p>{t("people.signInHint")}</p>
          <button className="btn primary" onClick={() => setDialog("signin")}>
            {t("hub.signIn")}
          </button>
        </div>
      ) : (
        <>
          <div className="runner-card">
            <div className="runner-head">
              <span className="person-avatar lg" style={{ background: personColor(hub.user.name) }}>
                {hub.user.name.slice(0, 1)}
              </span>
              <span className="user-text">
                <b>{hub.user.name}</b>
                <span className="user-ws">
                  {hub.user.email} · {hub.url?.replace(/^https?:\/\//, "")}
                </span>
              </span>
              <span className={hub.connected ? "online" : "offline"} />
              <div className="composer-spacer" />
              <button
                className="icon-btn"
                title={t("hub.signOut")}
                onClick={async () => {
                  await backend.hub.logout();
                  refreshHub();
                }}
              >
                <LogOut size={14} />
              </button>
            </div>
          </div>
          <div className="page-head">
            <h2 className="sub-title">{t("people.shared")}</h2>
            <div className="page-actions">
              <button className="btn" onClick={() => setDialog("join")}>
                {t("people.join")}
              </button>
            </div>
          </div>
          <div className="list">
            {shared.map((w) => (
              <button key={w.id} className="list-row" onClick={() => selectWorkspace(w.id)}>
                <span className="ws-initial">{w.name.slice(0, 1).toUpperCase()}</span>
                <span className="truncate list-title">{w.name}</span>
                <span className="list-meta">{w.host ? t("people.hostedBy", { name: w.host.name }) : t("people.youHost")}</span>
                <span className="list-meta">{w.role ? t(`role.${w.role}`) : t("role.admin")}</span>
              </button>
            ))}
            {shared.length === 0 && <Empty text={t("people.none")} />}
          </div>
        </>
      )}
    </div>
  );
}

// ---- settings: providers and hub ---------------------------------------------------------------------------

const PROVIDER_NAMES: Record<ProviderKind, string> = {
  open_router: "OpenRouter",
  anthropic: "Anthropic",
  open_ai: "OpenAI",
  google: "Google AI",
  fal: "fal",
  replicate: "Replicate",
  eleven_labs: "ElevenLabs",
  local: "Local models",
};

export function ProviderSettings() {
  const t = useT();
  const providers = useStore((s) => s.providers);
  const refresh = useStore((s) => s.refreshProviders);
  const notify = useStore((s) => s.notify);
  const [edit, setEdit] = useState<ProviderKind | null>(null);
  const [key, setKey] = useState("");
  const save = async (p: ProviderKind, k: string | null) => {
    try {
      await backend.setKey(p, k);
      setEdit(null);
      setKey("");
      refresh();
    } catch (e) {
      notify(String(e));
    }
  };
  return (
    <section className="set-group">
      <h2>{t("settings.providers")}</h2>
      {providers.filter((p) => p.kind !== "local").map((p) => (
        <div key={p.kind} className="set-row">
          <span>{PROVIDER_NAMES[p.kind]}</span>
          {edit === p.kind ? (
            <form
              className="key-form"
              onSubmit={(e) => {
                e.preventDefault();
                save(p.kind, key);
              }}
            >
              <input className="input mono" type="password" autoFocus value={key} placeholder={t("settings.pasteKey")} onChange={(e) => setKey(e.target.value)} />
              <button className="btn primary small">{t("common.save")}</button>
            </form>
          ) : (
            <div className="key-state">
              <span className={`set-state ${p.configured ? "ok" : "off"}`}>{p.configured ? t("settings.keySet") : t("settings.noKey")}</span>
              <button className="btn small ghost" onClick={() => setEdit(p.kind)}>
                {p.configured ? t("settings.replace") : t("settings.addKey")}
              </button>
              {p.configured && (
                <button className="icon-btn" onClick={() => save(p.kind, null)} title={t("common.delete")}>
                  <Trash2 size={13} />
                </button>
              )}
            </div>
          )}
        </div>
      ))}
      <p className="page-note">{t("settings.keysNote")}</p>
    </section>
  );
}

export function HubSettings() {
  const t = useT();
  const hub = useStore((s) => s.hub);
  const setDialog = useStore((s) => s.setDialog);
  return (
    <section className="set-group">
      <h2>{t("settings.hub")}</h2>
      <div className="set-row">
        <span>{hub.url ?? t("hub.none")}</span>
        {hub.user ? (
          <span className="set-state ok">{hub.user.email}</span>
        ) : (
          <button className="btn small" onClick={() => setDialog("signin")}>
            {t("hub.signIn")}
          </button>
        )}
      </div>
    </section>
  );
}
