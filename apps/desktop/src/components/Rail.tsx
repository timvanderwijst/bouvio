import { Home, Layers, Settings } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n";
import { useStore } from "../store";
import { extPages, useExtVersion } from "../ext/areas";
import { NAV_GROUPS, groupActive, groupKey, groupedIds, openGroup, useGroupBadge, type NavGroup } from "./NavGroups";

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

  // Rail: Home, Inbox (inbox + my work), Workspaces, Team (people + machines), then plugin pages.
  useExtVersion();
  const group = (id: string) => NAV_GROUPS.find((g) => g.id === id)!;
  type Item = { key: string; icon: typeof Home; label: string; active: boolean; open: () => void; group?: NavGroup; badge?: () => number | undefined };
  const viaGroup = (g: NavGroup): Item => ({ key: g.id, icon: g.icon, label: t(g.label), active: groupActive(g, view), open: () => openGroup(g), group: g });
  const items: Item[] = [
    { key: "home", icon: Home, label: t("nav.home"), active: view.kind === "home", open: () => go({ kind: "home" }) },
    viaGroup(group("inbox")),
    { key: "workspaces", icon: Layers, label: t("nav.workspaces"), active: view.kind === "workspaces", open: () => go({ kind: "workspaces" }) },
    viaGroup(group("team")),
    ...extPages("rail")
      .filter((p) => !groupedIds.has(p.id))
      .map((p) => ({
        key: p.id,
        icon: p.icon,
        label: t(p.label),
        active: view.kind === "ext" && view.id === p.id,
        open: () => go({ kind: "ext", id: p.id }),
        badge: p.useBadge,
      })),
  ];

  return (
    <>
      <div className="rail-edge" onMouseEnter={show} onMouseLeave={later} aria-hidden />
      <nav className={`rail ${open ? "open" : ""}`} onMouseEnter={show} onMouseLeave={later} aria-label="App">
        <div className="rail-mark" aria-label="Cuna">
          <CunaMark />
        </div>
        {items.map((it) => (
          <button
            key={it.key}
            className={`rail-btn ${it.active ? "active" : ""}`}
            onClick={() => {
              it.open();
              setOpen(false);
            }}
            data-tip={it.label}
            aria-label={it.label}
          >
            <it.icon size={18} strokeWidth={1.75} />
            {it.group ? <GroupBadge key={groupKey(it.group)} group={it.group} /> : it.badge ? <RailBadge use={it.badge} /> : null}
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

function GroupBadge({ group }: { group: NavGroup }) {
  const n = useGroupBadge(group);
  return n ? <span className="rail-badge">{n > 99 ? "99+" : n}</span> : null;
}

function RailBadge({ use }: { use: () => number | undefined }) {
  const n = use();
  return n ? <span className="rail-badge">{n > 99 ? "99+" : n}</span> : null;
}

/** Placeholder mark until the wordmark is designed: a b built from two rounded blocks. */
export function CunaMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <rect x="4" y="2.5" width="5.5" height="19" rx="2.75" fill="currentColor" />
      <rect x="4" y="10" width="16" height="11.5" rx="5.75" fill="currentColor" opacity=".55" />
    </svg>
  );
}
