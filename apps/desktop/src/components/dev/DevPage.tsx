import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { useWorkspace } from "../../store";
import { Empty } from "../Panel";
import { ApiTab } from "./Api";
import { ChecksTab } from "./Checks";
import { DataTab } from "./Data";
import { GitTab } from "./Git";
import { DEV_TABS, useDev, type DevTab } from "./state";

/** One page for the developer tools, with a segmented control like the panel's tabs. */
export function DevPage({ sub }: { sub?: string }) {
  const t = useT();
  const ws = useWorkspace();
  const tab = useDev((s) => s.tab);
  const setTab = useDev((s) => s.setTab);
  const bar = useRef<HTMLDivElement>(null);
  const [ind, setInd] = useState({ x: 0, w: 0 });

  useEffect(() => {
    if (sub && (DEV_TABS as string[]).includes(sub)) setTab(sub as DevTab);
  }, [sub, setTab]);

  useLayoutEffect(() => {
    const el = bar.current?.querySelector<HTMLElement>(`[data-tab="${tab}"]`);
    if (el) setInd({ x: el.offsetLeft, w: el.offsetWidth });
  }, [tab, t]);

  return (
    <div className="dv">
      <header className="dv-head">
        <h1 className="dv-title">{t("dev.page")}</h1>
        <div className="seg" ref={bar} role="tablist">
          <span className="seg-ind" style={{ transform: `translateX(${ind.x}px)`, width: ind.w }} />
          {DEV_TABS.map((id) => (
            <button key={id} role="tab" aria-selected={tab === id} data-tab={id} className={`seg-btn ${tab === id ? "on" : ""}`} onClick={() => setTab(id)}>
              {t(`dev.tab.${id}`)}
            </button>
          ))}
        </div>
      </header>
      <div className="dv-body">
        {!ws ? (
          <Empty text={t("dev.noWorkspace")} />
        ) : tab === "checks" ? (
          <ChecksTab key={ws.id} />
        ) : tab === "git" ? (
          <GitTab key={ws.id} />
        ) : tab === "data" ? (
          <DataTab key={ws.id} />
        ) : (
          <ApiTab key={ws.id} />
        )}
      </div>
    </div>
  );
}
