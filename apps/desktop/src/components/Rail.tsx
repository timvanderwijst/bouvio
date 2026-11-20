import { Home, Layers, Server, Settings, Users } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n";
import { useStore, type View } from "../store";
import { extPages } from "../ext/areas";

/**
 * The outer layer: hidden until the pointer touches the left edge (or Ctrl+\),
 * so the workspace always has the whole window.
 */
export function Rail() {
  const t = useT();
  const view = useStore((s) => s.view);
  const go = useStore((s) => s.go);
  const [open, setOpen] = useState(false);
  const hide = useRef<number>(0);

  const show = () => {
    window.clearTimeout(hide.current);
    setOpen(true);
  };
  const later = () => {
    window.clearTimeout(hide.current);
    hide.current = window.setTimeout(() => setOpen(false), 260);
  };

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "\\") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);

  const items: { view: View; icon: typeof Home; label: string; active: boolean; badge?: () => number | undefined }[] = [
    { view: { kind: "home" }, icon: Home, label: t("nav.home"), active: view.kind === "home" },
    { view: { kind: "workspaces" }, icon: Layers, label: t("nav.workspaces"), active: view.kind === "workspaces" },
    { view: { kind: "rail", page: "runners" }, icon: Server, label: t("nav.runners"), active: view.kind === "rail" && view.page === "runners" },
    { view: { kind: "rail", page: "people" }, icon: Users, label: t("nav.people"), active: view.kind === "rail" && view.page === "people" },
    ...extPages("rail").map((p) => ({
      view: { kind: "ext", id: p.id } as View,
      icon: p.icon,
      label: t(p.label),
      active: view.kind === "ext" && view.id === p.id,
      badge: p.useBadge,
    })),
  ];

  return (
    <>
      <div className="rail-edge" onMouseEnter={show} onMouseLeave={later} aria-hidden />
      <nav className={`rail ${open ? "open" : ""}`} onMouseEnter={show} onMouseLeave={later} aria-label="App">
        <div className="rail-mark" aria-label="Bouvio">
          <BouvioMark />
        </div>
        {items.map((it) => (
          <button
            key={it.label}
            className={`rail-btn ${it.active ? "active" : ""}`}
            onClick={() => {
              go(it.view);
              setOpen(false);
            }}
            data-tip={it.label}
            aria-label={it.label}
          >
            <it.icon size={18} strokeWidth={1.75} />
            {it.badge ? <RailBadge use={it.badge} /> : null}
          </button>
        ))}
        <div className="rail-spacer" />
        <button
          className={`rail-btn ${view.kind === "settings" ? "active" : ""}`}
          onClick={() => {
            go({ kind: "settings" });
            setOpen(false);
          }}
          data-tip={t("nav.settings")}
          aria-label={t("nav.settings")}
        >
          <Settings size={18} strokeWidth={1.75} />
        </button>
      </nav>
    </>
  );
}

function RailBadge({ use }: { use: () => number | undefined }) {
  const n = use();
  return n ? <span className="rail-badge">{n > 99 ? "99+" : n}</span> : null;
}

/** Placeholder mark until the wordmark is designed: a b built from two rounded blocks. */
export function BouvioMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <rect x="4" y="2.5" width="5.5" height="19" rx="2.75" fill="currentColor" />
      <rect x="4" y="10" width="16" height="11.5" rx="5.75" fill="currentColor" opacity=".55" />
    </svg>
  );
}
