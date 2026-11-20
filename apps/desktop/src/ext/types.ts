import type { LucideIcon } from "lucide-react";
import type { ComponentType } from "react";
import type { Thread } from "../protocol/Thread";

/**
 * A feature area plugs into the app through this one object. The app shell
 * (sidebar, rail, panel, home, settings, palette) renders whatever areas
 * register, so an area never edits shared files.
 */
export interface ExtArea {
  id: string;
  /** Full pages. `workspace` shows in the workspace sidebar, `rail` in the hover rail. */
  pages?: ExtPage[];
  /** Extra tabs in the right panel next to a thread. */
  panels?: ExtPanel[];
  /** Blocks on Home, above the overview. */
  home?: ExtBlock[];
  /** Sections on the Settings page. */
  settings?: ExtBlock[];
  /** Entries in the Ctrl+K palette. */
  commands?: ExtCommand[];
  /** Always-mounted pieces: listeners, floating UI (a huddle bar, a notifier). */
  overlays?: ExtBlock[];
}

export interface ExtPage {
  id: string;
  place: "workspace" | "rail";
  /** i18n key */
  label: string;
  icon: LucideIcon;
  component: ComponentType<{ sub?: string }>;
  /** Lower comes first. Built-in workspace pages use 0-80. */
  order?: number;
  /** Fill the sheet edge to edge (boards, editors) instead of a centred page. */
  flush?: boolean;
  /** Small number next to the label (unread, open items). */
  useBadge?: () => number | undefined;
}

export interface ExtPanel {
  id: string;
  label: string;
  component: ComponentType<{ thread: Thread | null }>;
}

export interface ExtBlock {
  id: string;
  component: ComponentType;
}

export interface ExtCommand {
  id: string;
  label: string;
  icon: LucideIcon;
  run: () => void;
}
