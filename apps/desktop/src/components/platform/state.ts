import { create } from "zustand";

export type UpdatePhase = "unknown" | "off" | "idle" | "checking" | "none" | "available" | "downloading" | "ready" | "error";

/** This area's own UI state: its dialogs and the update check. */
export interface PlatformState {
  dialog: null | "template";
  version: string | null;
  phase: UpdatePhase;
  /** The version on offer, when `available` or later. */
  next: string | null;
  /** 0..1 while downloading, null when the size is unknown. */
  progress: number | null;
  error: string | null;
  checkedAt: number | null;
  /** Bumped to reload plugins. */
  pluginsRev: number;
}

export const usePlatform = create<PlatformState>(() => ({
  dialog: null,
  version: null,
  phase: "unknown",
  next: null,
  progress: null,
  error: null,
  checkedAt: null,
  pluginsRev: 0,
}));
