import { RefreshCw, Rocket } from "lucide-react";
import { target } from "../../backend";
import { getLang, useT } from "../../i18n";
import { checkNow, install, restart } from "./updates";
import { usePlatform } from "./state";

function ago(at: number) {
  const s = Math.round((at - Date.now()) / 1000);
  const f = new Intl.RelativeTimeFormat(getLang(), { numeric: "auto" });
  if (Math.abs(s) < 60) return f.format(0, "minute");
  if (Math.abs(s) < 3600) return f.format(Math.round(s / 60), "minute");
  if (Math.abs(s) < 86400) return f.format(Math.round(s / 3600), "hour");
  return f.format(Math.round(s / 86400), "day");
}

/** Settings → Updates: the version, a check, and download plus restart. */
export function UpdatesSettings() {
  const t = useT();
  const { version, phase, next, progress, error, checkedAt } = usePlatform();
  if (target === "web" || (phase === "unknown" && !version)) return null;

  const pct = progress === null ? null : Math.round(progress * 100);
  return (
    <section className="set-group pf-updates">
      <h2>{t("platform.updates")}</h2>
      <div className="set-row">
        <span>{t("platform.updates.version")}</span>
        <span className="set-state">{version ?? "–"}</span>
      </div>

      {phase === "off" ? (
        <p className="page-note">{t("platform.updates.off")}</p>
      ) : (
        <>
          {(phase === "available" || phase === "downloading" || phase === "ready") && (
            <div className={`pf-update ${phase}`} role="status">
              <Rocket size={15} className="pf-update-icon" />
              <div className="pf-update-text">
                <strong>{phase === "ready" ? t("platform.updates.ready") : t("platform.updates.available", { version: next ?? "" })}</strong>
                {phase === "downloading" && (
                  <>
                    <span className="pf-update-sub">{pct === null ? t("platform.updates.downloadingUnknown") : t("platform.updates.downloading", { percent: pct })}</span>
                    <span className={`pf-bar ${pct === null ? "indeterminate" : ""}`}>
                      <span style={{ width: `${pct ?? 30}%` }} />
                    </span>
                  </>
                )}
              </div>
              {phase === "available" && (
                <button className="btn small primary" onClick={() => install()}>
                  {t("platform.updates.download")}
                </button>
              )}
              {phase === "ready" && (
                <button className="btn small primary" onClick={() => restart()}>
                  {t("platform.updates.restart")}
                </button>
              )}
            </div>
          )}
          <div className="set-row">
            <span className="pf-col">
              <span>{phase === "none" ? t("platform.updates.upToDate") : t("platform.updates.auto")}</span>
              {checkedAt && <span className="pf-hint">{t("platform.updates.lastChecked", { when: ago(checkedAt) })}</span>}
            </span>
            <button className={`btn small ${phase === "checking" ? "is-busy" : ""}`} disabled={phase === "checking" || phase === "downloading"} onClick={() => checkNow()}>
              <RefreshCw size={13} />
              {phase === "checking" ? t("platform.updates.checking") : t("platform.updates.check")}
            </button>
          </div>
          {phase === "error" && error && <p className="form-error pf-error">{t("platform.updates.failed", { error })}</p>}
        </>
      )}
    </section>
  );
}
