// Automatic updates: the Tauri updater plugin, checked once a day in the
// background and on demand from Settings. Nothing installs without a click.

import type { Update } from "@tauri-apps/plugin-updater";
import { backend, target } from "../../backend";
import type { AppInfo } from "../../protocol/AppInfo";
import { usePlatform } from "./state";

const LAST = "cuna.updates.checkedAt";
const DAY = 24 * 60 * 60 * 1000;
let pending: Update | null = null;
let started = false;

const set = usePlatform.setState;
const get = usePlatform.getState;

function lastChecked(): number | null {
  try {
    const v = Number(localStorage.getItem(LAST));
    return v > 0 ? v : null;
  } catch {
    return null;
  }
}

async function loadInfo() {
  if (target === "web") return set({ phase: "off" });
  try {
    const info = await backend.app<AppInfo>("app_info");
    set({ version: info.version, phase: info.updater ? "idle" : "off", checkedAt: lastChecked() });
  } catch {
    set({ phase: "off" });
  }
}

/** Ask the release endpoint. `quiet` keeps background failures out of sight. */
export async function checkNow(quiet = false) {
  const { phase } = get();
  if (phase === "off" || phase === "checking" || phase === "downloading" || phase === "ready") return;
  set({ phase: "checking", error: null });
  try {
    const now = Date.now();
    let next: string | null = null;
    if (target === "preview") {
      // Sample data: pretend a release exists, so the flow can be seen in a browser.
      await new Promise((r) => setTimeout(r, 600));
      next = "0.2.0";
    } else {
      const { check } = await import("@tauri-apps/plugin-updater");
      pending = await check({ timeout: 30_000 });
      next = pending?.version ?? null;
    }
    try {
      localStorage.setItem(LAST, String(now));
    } catch {}
    set({ phase: next ? "available" : "none", next, checkedAt: now });
  } catch (e) {
    set(quiet ? { phase: "idle" } : { phase: "error", error: String(e).replace(/^Error: /, "") });
  }
}

/** Download with progress, then install; the app finishes on restart. */
export async function install() {
  if (get().phase !== "available") return;
  set({ phase: "downloading", progress: 0, error: null });
  try {
    if (target === "preview") {
      for (let i = 1; i <= 10; i++) {
        await new Promise((r) => setTimeout(r, 150));
        set({ progress: i / 10 });
      }
    } else {
      if (!pending) throw new Error("check again first");
      let total = 0;
      let got = 0;
      await pending.downloadAndInstall((ev) => {
        if (ev.event === "Started") {
          total = ev.data.contentLength ?? 0;
          set({ progress: total ? 0 : null });
        } else if (ev.event === "Progress") {
          got += ev.data.chunkLength;
          if (total) set({ progress: Math.min(1, got / total) });
        }
      });
    }
    set({ phase: "ready", progress: 1 });
  } catch (e) {
    set({ phase: "error", error: String(e).replace(/^Error: /, "") });
  }
}

export async function restart() {
  if (target !== "desktop") return location.reload();
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}

/** Once per app start: read the version, check soon if a day has passed, then daily. */
export function startUpdates() {
  if (started) return;
  started = true;
  loadInfo().then(() => {
    if (get().phase === "off" || target === "preview") return;
    const last = get().checkedAt;
    const due = !last || Date.now() - last > DAY - 60_000;
    if (due) setTimeout(() => checkNow(true), 15_000);
    setInterval(() => checkNow(true), DAY);
  });
}
