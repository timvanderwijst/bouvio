import { ExternalLink, LoaderCircle, Plug, RefreshCw, Search, Trash2, WandSparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { backend } from "../../backend";
import { useT } from "../../i18n";
import type { InstalledSkill } from "../../protocol/InstalledSkill";
import type { McpCatalogEntry } from "../../protocol/McpCatalogEntry";
import type { McpServer } from "../../protocol/McpServer";
import type { SkillEntry } from "../../protocol/SkillEntry";
import type { WorkspaceSettings } from "../../protocol/WorkspaceSettings";
import { rpc, useStore, useWorkspace, useWsData } from "../../store";
import { Dialog } from "../Dialog";
import { Empty } from "../Panel";
import "./knowledge.css";

export function IntegrationsPage({ sub }: { sub?: string }) {
  const t = useT();
  const go = useStore((s) => s.go);
  const tab = sub === "skills" ? "skills" : "mcp";
  return (
    <div className="page wide kn-int">
      <div className="page-head">
        <h1 className="page-title">{t("knowledge.int.title")}</h1>
        <div className="choice small">
          <button className={tab === "mcp" ? "on" : ""} onClick={() => go({ kind: "ext", id: "knowledge.integrations", sub: "mcp" })}>
            <Plug size={13} />
            {t("knowledge.int.mcp")}
          </button>
          <button className={tab === "skills" ? "on" : ""} onClick={() => go({ kind: "ext", id: "knowledge.integrations", sub: "skills" })}>
            <WandSparkles size={13} />
            {t("knowledge.int.skills")}
          </button>
        </div>
      </div>
      {tab === "mcp" ? <McpTab /> : <SkillsTab />}
    </div>
  );
}

const errText = (e: unknown) => String(e).replace(/^Error: /, "");

// ---- MCP servers ---------------------------------------------------------------------------------

function McpTab() {
  const t = useT();
  const ws = useWorkspace();
  const data = useWsData();
  const load = useStore((s) => s.load);
  const patch = useStore((s) => s.patch);
  const notify = useStore((s) => s.notify);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<McpCatalogEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [installing, setInstalling] = useState<McpCatalogEntry | null>(null);

  useEffect(() => {
    load("settings");
  }, [load]);

  useEffect(() => {
    if (!ws) return;
    let live = true;
    setLoading(true);
    const timer = window.setTimeout(async () => {
      try {
        const r = await rpc<McpCatalogEntry[]>("search_mcp_registry", { workspace_id: ws.id, query: q.trim() }, ws.id);
        if (live) {
          setResults(r);
          setErr(null);
        }
      } catch (e) {
        if (live) setErr(errText(e));
      } finally {
        if (live) setLoading(false);
      }
    }, 300);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [q, ws]);

  const installed = data.settings?.mcp_servers ?? [];
  const applied = (s: WorkspaceSettings | null, servers: McpServer[]) => {
    if (!ws) return;
    // The runner also sends `settings-changed`; this keeps the page right without waiting.
    const next = s?.mcp_servers ? s : data.settings ? { ...data.settings, mcp_servers: servers } : null;
    if (next) patch(ws.id, { settings: next });
  };
  const remove = async (name: string) => {
    if (!ws) return;
    try {
      const s = await rpc<WorkspaceSettings>("remove_mcp", { workspace_id: ws.id, name }, ws.id);
      applied(s, installed.filter((m) => m.name !== name));
      notify(t("knowledge.int.removedOk", { name }));
    } catch (e) {
      notify(errText(e));
    }
  };

  return (
    <>
      <section className="set-group">
        <h2>{t("knowledge.int.installed")}</h2>
        {installed.length === 0 ? (
          <p className="kn-note">{t("knowledge.int.noMcp")}</p>
        ) : (
          <div className="kn-rows">
            {installed.map((m) => (
              <div key={m.name} className="kn-row">
                <span className="kn-row-icon">
                  <Plug size={15} />
                </span>
                <span className="kn-row-body">
                  <span className="kn-row-title">{m.name}</span>
                  <span className="kn-row-sub mono truncate">{[m.command, ...m.args].join(" ")}</span>
                </span>
                <button className="icon-btn" onClick={() => remove(m.name)} title={t("knowledge.int.remove")} aria-label={t("knowledge.int.remove")}>
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="set-group">
        <h2>{t("knowledge.int.catalog")}</h2>
        <div className="kn-find">
          <Search size={14} />
          <input className="input grow" value={q} placeholder={t("knowledge.int.searchMcp")} onChange={(e) => setQ(e.target.value)} />
          {loading && <LoaderCircle size={14} className="kn-spin" />}
        </div>
        {err ? (
          <Empty text={err} />
        ) : results === null ? (
          <div className="kn-rows">
            {[0, 1, 2].map((i) => (
              <div key={i} className="kn-row skeleton shimmer" />
            ))}
          </div>
        ) : results.length === 0 ? (
          <Empty text={t("knowledge.int.noMcpResults", { query: q.trim() })} />
        ) : (
          <div className="kn-rows">
            {results.map((e) => {
              const has = installed.some((m) => m.name === e.short_name);
              return (
                <div key={e.name} className="kn-row">
                  <span className="kn-row-icon">
                    <Plug size={15} />
                  </span>
                  <span className="kn-row-body">
                    <span className="kn-row-title">
                      {e.short_name}
                      <span className="kn-row-name truncate">{e.name}</span>
                    </span>
                    {e.description && <span className="kn-row-sub">{e.description}</span>}
                  </span>
                  <span className="kn-row-tags">
                    {e.runtime && <span className="kn-tag">{e.runtime === "remote" ? "mcp-remote" : e.runtime}</span>}
                    {e.repository && (
                      <button className="icon-btn" onClick={() => backend.openUrl(e.repository!)} title={t("knowledge.int.repo")} aria-label={t("knowledge.int.repo")}>
                        <ExternalLink size={13} />
                      </button>
                    )}
                  </span>
                  {e.command ? (
                    <button className="btn small" onClick={() => setInstalling(e)}>
                      {has ? t("knowledge.int.reinstall") : t("knowledge.int.install")}
                    </button>
                  ) : (
                    <span className="kn-tag muted">{t("knowledge.int.remoteOnly")}</span>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <p className="kn-note">{t("knowledge.int.registryNote")}</p>
      </section>

      {installing && (
        <InstallMcpDialog
          entry={installing}
          onClose={() => setInstalling(null)}
          onDone={(s, server) => {
            applied(s, [...installed.filter((m) => m.name !== server.name), server]);
            setInstalling(null);
            notify(t("knowledge.int.installedOk", { name: server.name }));
          }}
        />
      )}
    </>
  );
}

function InstallMcpDialog({ entry, onClose, onDone }: { entry: McpCatalogEntry; onClose: () => void; onDone: (s: WorkspaceSettings | null, server: McpServer) => void }) {
  const t = useT();
  const ws = useWorkspace();
  const [name, setName] = useState(entry.short_name);
  const [env, setEnv] = useState<Record<string, string>>(() => Object.fromEntries(entry.env.map((v) => [v.name, v.default ?? ""])));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const missing = entry.env.some((v) => v.required && !env[v.name]?.trim());

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ws || !entry.command) return;
    if (missing) return setErr(t("knowledge.int.envMissing"));
    const server: McpServer = {
      name: name.trim(),
      command: entry.command,
      args: entry.args,
      env: entry.env.filter((v) => env[v.name]?.trim()).map((v) => [v.name, env[v.name].trim()] as [string, string]),
    };
    setBusy(true);
    try {
      const s = await rpc<WorkspaceSettings>("install_mcp", { workspace_id: ws.id, server }, ws.id);
      onDone(s, server);
    } catch (x) {
      setErr(errText(x));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title={t("knowledge.int.envTitle", { name: entry.short_name })} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label className="field">
          <span>{t("knowledge.int.envName")}</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus={entry.env.length === 0} />
        </label>
        <div className="field">
          <span>{t("knowledge.int.envCommand")}</span>
          <code className="kn-cmd">{[entry.command, ...entry.args].join(" ")}</code>
        </div>
        {entry.env.length === 0 ? (
          <p className="field-hint">{t("knowledge.int.envNone")}</p>
        ) : (
          entry.env.map((v, i) => (
            <label key={v.name} className="field">
              <span className="kn-env-label">
                <span className="mono">{v.name}</span>
                {v.required && <span className="kn-tag">{t("knowledge.int.envRequired")}</span>}
              </span>
              <input
                className="input"
                type={v.secret ? "password" : "text"}
                autoFocus={i === 0}
                autoComplete="off"
                value={env[v.name] ?? ""}
                placeholder={v.default ?? ""}
                onChange={(e) => setEnv({ ...env, [v.name]: e.target.value })}
              />
              {v.description && <span className="field-hint">{v.description}</span>}
            </label>
          ))
        )}
        {err && <p className="form-error">{err}</p>}
        <div className="form-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className={`btn primary ${busy ? "is-busy" : ""}`} disabled={busy || !name.trim()}>
            {busy && <LoaderCircle size={14} />}
            {t("knowledge.int.install")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

// ---- skills --------------------------------------------------------------------------------------

function SkillsTab() {
  const t = useT();
  const ws = useWorkspace();
  const notify = useStore((s) => s.notify);
  const [installed, setInstalled] = useState<InstalledSkill[] | null>(null);
  const [catalog, setCatalog] = useState<SkillEntry[] | null>(null);
  const [catErr, setCatErr] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const hasFolder = !!ws?.root;

  const loadInstalled = () => {
    if (!ws) return;
    rpc<InstalledSkill[]>("list_installed_skills", { workspace_id: ws.id }, ws.id)
      .then(setInstalled)
      .catch((e) => {
        setInstalled([]);
        notify(errText(e));
      });
  };
  const loadCatalog = async (refresh = false) => {
    if (!ws) return;
    setRefreshing(refresh);
    try {
      setCatalog(await rpc<SkillEntry[]>("list_skills_catalog", { workspace_id: ws.id, refresh }, ws.id));
      setCatErr(null);
    } catch (e) {
      setCatErr(errText(e));
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    loadInstalled();
    loadCatalog();
    if (!ws) return;
    return backend.on<{ workspace_id: string; kind: string }>("workspace-notice", (n) => {
      if (n.workspace_id === ws.id && n.kind === "knowledge-skills") loadInstalled();
    });
  }, [ws?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (catalog ?? []).filter((s) => !f || s.name.toLowerCase().includes(f) || s.description.toLowerCase().includes(f));
  }, [catalog, filter]);

  const install = async (s: SkillEntry) => {
    if (!ws) return;
    setBusy(s.url);
    try {
      const done = await rpc<InstalledSkill>("install_skill", { workspace_id: ws.id, source: s.source }, ws.id);
      notify(t("knowledge.int.installedOk", { name: done.name }));
      loadInstalled();
    } catch (e) {
      notify(errText(e));
    } finally {
      setBusy(null);
    }
  };
  const remove = async (s: InstalledSkill) => {
    if (!ws) return;
    try {
      await rpc("remove_skill", { workspace_id: ws.id, name: s.name }, ws.id);
      notify(t("knowledge.int.removedOk", { name: s.name }));
      loadInstalled();
    } catch (e) {
      notify(errText(e));
    }
  };
  const isInstalled = (s: SkillEntry) => !!installed?.some((i) => i.name === s.name || i.path.replace(/\\/g, "/").endsWith(`/${s.source.path.split("/").pop()}`));

  return (
    <>
      <section className="set-group">
        <h2>{t("knowledge.int.installed")}</h2>
        {!hasFolder ? (
          <p className="kn-note">{t("knowledge.int.noFolder")}</p>
        ) : installed === null ? (
          <div className="kn-row skeleton shimmer" />
        ) : installed.length === 0 ? (
          <p className="kn-note">{t("knowledge.int.noSkills")}</p>
        ) : (
          <div className="kn-rows">
            {installed.map((s) => (
              <div key={s.path} className="kn-row">
                <span className="kn-row-icon">
                  <WandSparkles size={15} />
                </span>
                <span className="kn-row-body">
                  <span className="kn-row-title">{s.name}</span>
                  {s.description && <span className="kn-row-sub">{s.description}</span>}
                </span>
                <button className="icon-btn" onClick={() => remove(s)} title={t("knowledge.int.remove")} aria-label={t("knowledge.int.remove")}>
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="set-group">
        <h2>{t("knowledge.int.catalog")}</h2>
        <div className="kn-find">
          <Search size={14} />
          <input className="input grow" value={filter} placeholder={t("knowledge.int.searchSkills")} onChange={(e) => setFilter(e.target.value)} />
          <button className={`icon-btn ${refreshing ? "spin" : ""}`} onClick={() => loadCatalog(true)} disabled={refreshing} title={t("knowledge.int.refresh")} aria-label={t("knowledge.int.refresh")}>
            <RefreshCw size={14} />
          </button>
        </div>
        {catErr ? (
          <Empty text={catErr} />
        ) : catalog === null ? (
          <div className="kn-rows">
            {[0, 1, 2].map((i) => (
              <div key={i} className="kn-row skeleton shimmer" />
            ))}
          </div>
        ) : (
          <div className="kn-rows">
            {shown.map((s) => {
              const has = isInstalled(s);
              return (
                <div key={s.url} className="kn-row">
                  <span className="kn-row-icon">
                    <WandSparkles size={15} />
                  </span>
                  <span className="kn-row-body">
                    <span className="kn-row-title">
                      {s.name}
                      <span className="kn-row-name truncate">{s.source.repo}</span>
                    </span>
                    {s.description && <span className="kn-row-sub">{s.description}</span>}
                  </span>
                  <span className="kn-row-tags">
                    <button className="icon-btn" onClick={() => backend.openUrl(s.url)} title={t("knowledge.int.repo")} aria-label={t("knowledge.int.repo")}>
                      <ExternalLink size={13} />
                    </button>
                  </span>
                  <button className={`btn small ${busy === s.url ? "is-busy" : ""}`} disabled={!hasFolder || busy !== null} onClick={() => install(s)}>
                    {busy === s.url && <LoaderCircle size={13} />}
                    {has ? t("knowledge.int.reinstall") : t("knowledge.int.install")}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <SkillSources onSaved={() => loadCatalog(true)} />
    </>
  );
}

function SkillSources({ onSaved }: { onSaved: () => void }) {
  const t = useT();
  const ws = useWorkspace();
  const notify = useStore((s) => s.notify);
  const [text, setText] = useState<string | null>(null);
  const [saved, setSaved] = useState("");
  const remote = !!ws?.role;

  useEffect(() => {
    if (!ws || remote) return;
    rpc<string[]>("get_skill_sources", { workspace_id: ws.id }, ws.id)
      .then((s) => {
        setText(s.join("\n"));
        setSaved(s.join("\n"));
      })
      .catch(() => setText(""));
  }, [ws?.id, remote]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sources are a setting of the runner's own machine.
  if (remote || text === null) return null;
  const save = async () => {
    try {
      const list = await rpc<string[]>("set_skill_sources", { sources: text.split("\n") }, null);
      setText(list.join("\n"));
      setSaved(list.join("\n"));
      onSaved();
    } catch (e) {
      notify(errText(e));
    }
  };
  return (
    <section className="set-group">
      <h2>{t("knowledge.int.sources")}</h2>
      <textarea className="input area mono" rows={3} value={text} placeholder="owner/repo" onChange={(e) => setText(e.target.value)} spellCheck={false} />
      <div className="kn-sources-foot">
        <span className="field-hint">{t("knowledge.int.sourcesHint")}</span>
        <button className="btn small" disabled={text === saved} onClick={save}>
          {t("knowledge.int.sourcesSave")}
        </button>
      </div>
    </section>
  );
}
