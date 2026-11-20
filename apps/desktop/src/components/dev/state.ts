import { useEffect, useRef } from "react";
import { create } from "zustand";
import { backend } from "../../backend";
import { useStore } from "../../store";

export type DevTab = "checks" | "git" | "data" | "api";
export const DEV_TABS: DevTab[] = ["checks", "git", "data", "api"];

const ls = {
  get(k: string) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
};

interface DevState {
  tab: DevTab;
  /** Data view: browse a table or write SQL. */
  dataMode: "rows" | "sql";
  /** Bumped to focus the SQL editor (palette "Run SQL"). */
  sqlFocus: number;
  setTab(t: DevTab): void;
  setDataMode(m: "rows" | "sql"): void;
}

export const useDev = create<DevState>((set) => ({
  tab: (DEV_TABS as string[]).includes(ls.get("bouvio.dev.tab") ?? "") ? (ls.get("bouvio.dev.tab") as DevTab) : "checks",
  dataMode: "rows",
  sqlFocus: 0,
  setTab(tab) {
    ls.set("bouvio.dev.tab", tab);
    set({ tab });
  },
  setDataMode(dataMode) {
    set({ dataMode });
  },
}));

export const prefs = ls;

/** Run `cb` when the runner announces `kind` for the current workspace. */
export function useDevNotice(kind: string, cb: (payload: any) => void) {
  const ref = useRef(cb);
  ref.current = cb;
  useEffect(
    () =>
      backend.on<{ workspace_id: string; kind: string; payload: unknown }>("workspace-notice", (n) => {
        if (n.kind === kind && n.workspace_id === useStore.getState().workspaceId) ref.current(n.payload);
      }),
    [kind],
  );
}

/** An error from the runner as one readable line. */
export const errText = (e: unknown) => String(e instanceof Error ? e.message : e).replace(/^Error:\s*/, "");

export function bytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} kB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Rail colours of the git graph, all derived from the theme tokens. */
export const LANE_COLORS = [
  "var(--accent)",
  "var(--ok)",
  "var(--warn)",
  "color-mix(in srgb, var(--accent) 55%, var(--fail))",
  "color-mix(in srgb, var(--ok) 55%, var(--accent))",
  "var(--fail)",
  "color-mix(in srgb, var(--warn) 60%, var(--fail))",
  "var(--ink-2)",
];
export const laneColor = (i: number) => LANE_COLORS[i % LANE_COLORS.length];
