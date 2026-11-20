import { FolderOpen, Plus, RefreshCw, ShieldAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { backend, target } from "../../backend";
import { useT } from "../../i18n";
import type { PluginInfo } from "../../protocol/PluginInfo";
import { useStore } from "../../store";
import { loadErrors, syncPlugins } from "./plugins";
import { usePlatform } from "./state";

/** Settings → Plugins: what is in the plugins folder, with a switch each. */
export function PluginsSettings() {
  const t = useT();
  const notify = useStore((s) => s.notify);
  const rev = usePlatform((s) => s.pluginsRev);
  const [list, setList] = useState<PluginInfo[] | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async (reload = false) => {
    setBusy(true);
    try {
      setList(await syncPlugins(reload));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh, rev]);

  if (target === "web") return null;

  const run = async (f: () => Promise<unknown>) => {
    try {
      await f();
    } catch (e) {
      notify(String(e));
    }
  };
  const toggle = (p: PluginInfo, enabled: boolean) =>
    run(async () => {
      await backend.app("plugin_set_enabled", { id: p.manifest.id, enabled });
      await refresh();
    });
  const create = () =>
    run(async () => {
      const p = await backend.app<PluginInfo>("plugin_create");
      await refresh();
      notify(t("platform.plugins.created", { name: p.manifest.name, path: p.path }));
    });

  return (
    <section className="set-group pf-plugins">
      <div className="pf-head">
        <h2>{t("platform.plugins")}</h2>
        <div className="pf-actions">
          <button className="btn small ghost" onClick={() => run(() => backend.app("plugins_dir", { open: true }))}>
            <FolderOpen size={13} />
            {t("platform.plugins.openFolder")}
          </button>
          <button className={`btn small ghost ${busy ? "is-busy" : ""}`} onClick={() => refresh(true)} title={t("platform.plugins.reload")}>
            <RefreshCw size={13} />
            {t("platform.plugins.reload")}
          </button>
          <button className="btn small" onClick={create}>
            <Plus size={13} />
            {t("platform.plugins.create")}
          </button>
        </div>
      </div>
      <p className="pf-trust">
        <ShieldAlert size={14} />
        <span>{t("platform.plugins.trust")}</span>
      </p>
      {list?.length === 0 && <p className="page-note">{t("platform.plugins.empty")}</p>}
      {list?.map((p) => {
        const m = p.manifest;
        const err = p.error ?? (p.enabled ? loadErrors.get(m.id) : undefined);
        return (
          <div className="set-row pf-plugin" key={m.id}>
            <span className="pf-col">
              <span className="pf-name">
                {m.name}
                {m.version && <span className="pf-ver mono">{m.version}</span>}
                {m.permissions.map((perm) => (
                  <span key={perm} className="pf-perm">
                    {t(`platform.plugins.perm.${perm}`)}
                  </span>
                ))}
              </span>
              {err ? <span className="pf-hint fail">{t("platform.plugins.failed", { error: err })}</span> : m.description && <span className="pf-hint">{m.description}</span>}
            </span>
            <label className="toggle" title={t("platform.plugins.enable", { name: m.name })}>
              <input type="checkbox" checked={p.enabled} disabled={!!p.error} onChange={(e) => toggle(p, e.target.checked)} aria-label={t("platform.plugins.enable", { name: m.name })} />
            </label>
          </div>
        );
      })}
    </section>
  );
}
