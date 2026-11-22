import { Cpu, X } from "lucide-react";
import { useState } from "react";
import { useT } from "../../i18n";
import { useStore } from "../../store";
import { openLocalSettings } from "./open";
import "./local.css";

const HIDE = "cuna.local.homeHidden";

function hidden() {
  try {
    return localStorage.getItem(HIDE) === "1";
  } catch {
    return false;
  }
}

/** Shown only to someone with no keys and no local models yet. */
export function LocalHome() {
  const t = useT();
  const providers = useStore((s) => s.providers);
  const models = useStore((s) => s.models);
  const [gone, setGone] = useState(hidden);
  const anything = providers.some((p) => p.configured) || models.some((m) => m.provider === "local");
  if (gone || providers.length === 0 || anything) return null;

  return (
    <div className="local-home">
      <span className="local-home-icon">
        <Cpu size={16} />
      </span>
      <div className="local-home-text">
        <div className="local-home-title">{t("local.home.title")}</div>
        <p>{t("local.home.body")}</p>
      </div>
      <button className="btn primary small" onClick={openLocalSettings}>
        {t("local.home.action")}
      </button>
      <button
        className="icon-btn"
        title={t("local.home.dismiss")}
        aria-label={t("local.home.dismiss")}
        onClick={() => {
          try {
            localStorage.setItem(HIDE, "1");
          } catch {}
          setGone(true);
        }}
      >
        <X size={14} />
      </button>
    </div>
  );
}
