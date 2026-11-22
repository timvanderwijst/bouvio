import { Plus } from "lucide-react";
import { useMemo } from "react";
import { LANGUAGES, getLang, setLang, useT, type Lang } from "../i18n";
import { useStore, useWorkspaceLeads, useWorkspaceThreads, type ThemePref } from "../store";
import { HubSettings, ProviderSettings } from "./More";
import { extHome, extSettings } from "../ext/areas";
import { ago, cost } from "../lib/format";
import { Overview } from "./Panel";
import { PixelAvatar } from "./PixelAvatar";
import { StatusIcon } from "./StatusIcon";
import { HARNESS_NAMES } from "./harness";

export function Home() {
  const t = useT();
  const name = useStore((s) => s.userName);
  const all = useStore((s) => s.threads);
  const workspaces = useStore((s) => s.workspaces);
  const selectWorkspace = useStore((s) => s.selectWorkspace);
  const setDialog = useStore((s) => s.setDialog);
  const threads = useMemo(() => Object.values(all).flat(), [all]);
  const h = new Date().getHours();
  const greet = h < 12 ? "home.greeting.morning" : h < 18 ? "home.greeting.afternoon" : "home.greeting.evening";

  return (
    <div className="page home">
      <h1 className="display">{t(greet, { name })}</h1>
      {extHome().map((b) => (
        <b.component key={b.id} />
      ))}
      {workspaces.length === 0 ? (
        <div className="home-empty">
          <p>{t("home.empty")}</p>
          <button className="btn primary" onClick={() => setDialog("workspace")}>
            <Plus size={15} />
            {t("ws.create")}
          </button>
        </div>
      ) : (
        <div className="home-grid">
          <Overview threads={threads} showWorkspace />
          <div className="home-ws">
            <div className="group-head static">
              <span>{t("home.allWorkspaces")}</span>
              <span className="group-count">{workspaces.length}</span>
            </div>
            {workspaces.map((w) => {
              const list = all[w.id] ?? [];
              const working = list.filter((x) => x.status === "working").length;
              const needs = list.filter((x) => x.status === "blocked" || x.status === "error").length;
              return (
                <button key={w.id} className="ov-row" onClick={() => selectWorkspace(w.id)}>
                  <span className="ws-initial">{w.name.slice(0, 1).toUpperCase()}</span>
                  <span className="ov-text">
                    <span className="ov-title truncate">{w.name}</span>
                    <span className="ov-meta truncate">{w.root ?? t("ws.folderNone")}</span>
                  </span>
                  {working > 0 && <StatusIcon status="working" />}
                  {needs > 0 && <span className="badge">{needs}</span>}
                </button>
              );
            })}
            <button className="ov-row add" onClick={() => setDialog("workspace")}>
              <Plus size={14} />
              <span className="ov-title">{t("ws.create")}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function ThreadsPage() {
  const t = useT();
  const threads = useWorkspaceThreads();
  const leads = useWorkspaceLeads();
  const openThread = useStore((s) => s.openThread);
  return (
    <div className="page">
      <h1 className="page-title">{t("ws.threads")}</h1>
      <div className="list">
        {threads.map((th) => {
          const c = leads.find((x) => x.id === th.lead_id);
          return (
            <button key={th.id} className="list-row" onClick={() => openThread(th.id)}>
              <StatusIcon status={th.status} />
              <span className="truncate list-title">{th.title}</span>
              <span className="list-meta">
                {c && <PixelAvatar seed={c.avatar_seed} size={14} />}
                {c?.name}
              </span>
              <span className="list-meta mono">{th.branch}</span>
              <span className="list-meta num">{th.cost_usd > 0 ? cost(th.cost_usd) : ""}</span>
              <span className="list-meta when">{ago(th.updated_at)}</span>
            </button>
          );
        })}
        {threads.length === 0 && <div className="empty">{t("panel.nothing")}</div>}
      </div>
    </div>
  );
}

export function WorkspacesPage() {
  const t = useT();
  const workspaces = useStore((s) => s.workspaces);
  const all = useStore((s) => s.threads);
  const selectWorkspace = useStore((s) => s.selectWorkspace);
  const setDialog = useStore((s) => s.setDialog);
  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">{t("nav.workspaces")}</h1>
        <button className="btn" onClick={() => setDialog("workspace")}>
          <Plus size={14} />
          {t("ws.create")}
        </button>
      </div>
      <div className="list">
        {workspaces.map((w) => (
          <button key={w.id} className="list-row" onClick={() => selectWorkspace(w.id)}>
            <span className="ws-initial">{w.name.slice(0, 1).toUpperCase()}</span>
            <span className="truncate list-title">{w.name}</span>
            <span className="list-meta">{w.kind === "personal" ? t("ws.personal") : t("ws.shared")}</span>
            <span className="list-meta mono truncate">{w.root ?? t("ws.folderNone")}</span>
            <span className="list-meta num">{(all[w.id] ?? []).length}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function Settings() {
  const t = useT();
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const name = useStore((s) => s.userName);
  const setUserName = useStore((s) => s.setUserName);
  const harnesses = useStore((s) => s.harnesses);
  const themes: ThemePref[] = ["system", "light", "dark"];

  return (
    <div className="page settings">
      <h1 className="page-title">{t("settings.title")}</h1>

      <section className="set-group">
        <h2>{t("settings.appearance")}</h2>
        <div className="set-row">
          <span>{t("settings.theme")}</span>
          <div className="choice">
            {themes.map((th) => (
              <button key={th} className={theme === th ? "on" : ""} onClick={() => setTheme(th)}>
                {t(`settings.theme.${th}`)}
              </button>
            ))}
          </div>
        </div>
        <div className="set-row">
          <span>{t("settings.language")}</span>
          <div className="choice">
            {(Object.keys(LANGUAGES) as Lang[]).map((l) => (
              <button key={l} className={getLang() === l ? "on" : ""} onClick={() => setLang(l)}>
                {LANGUAGES[l].name}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="set-group">
        <h2>{t("settings.you")}</h2>
        <label className="set-row">
          <span>{t("settings.displayName")}</span>
          <input className="input" value={name} onChange={(e) => setUserName(e.target.value)} />
        </label>
      </section>

      <ProviderSettings />
      {extSettings().map((b) => (
        <b.component key={b.id} />
      ))}
      <HubSettings />

      <section className="set-group">
        <h2>{t("settings.agents")}</h2>
        {harnesses.map((h) => (
          <div className="set-row" key={h.kind}>
            <span>{HARNESS_NAMES[h.kind]}</span>
            <span className={`set-state ${h.available ? (h.kind === "api" ? "" : "ok") : "off"}`}>
              {h.kind === "api" ? t("settings.needsKeys") : h.available ? h.version ?? t("settings.ready") : t("settings.notFound")}
            </span>
          </div>
        ))}
      </section>
    </div>
  );
}
