// Inbox and OS notifications: @mentions of me in chat, threads that need me,
// and long runs that finished. Mentions and finished runs are kept in
// localStorage per hub user; threads that need me come live from the app store.

import { useMemo } from "react";
import { create } from "zustand";
import { backend } from "../../backend";
import { t } from "../../i18n";
import type { ChatMessage } from "../../protocol/ChatMessage";
import type { ThreadEnvelope } from "../../protocol/ThreadEnvelope";
import { useStore } from "../../store";
import { useComms, type SignalEvent } from "./state";

export const LONG_RUN_MS = 60_000;
const MAX_ITEMS = 200;

export interface InboxItem {
  id: string;
  kind: "mention" | "needs" | "finished";
  ws: string;
  title: string;
  body: string;
  at: string;
  who?: string;
  thread?: string;
  chat?: { channel: string; message: string; parent?: string | null };
}

interface InboxStore {
  owner: string;
  items: InboxItem[];
  read: Record<string, true>;
}

const ls = {
  get<T>(k: string, fallback: T): T {
    try {
      const v = localStorage.getItem(k);
      return v ? (JSON.parse(v) as T) : fallback;
    } catch {
      return fallback;
    }
  },
  set(k: string, v: unknown) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {}
  },
};

const ownerKey = () => useStore.getState().hub.user?.id ?? "local";

export const useInbox = create<InboxStore>(() => ({ owner: "", items: [], read: {} }));

/** Load the inbox of whoever is signed in now (once per user). */
function ensureOwner() {
  const owner = ownerKey();
  if (useInbox.getState().owner === owner) return;
  useInbox.setState({
    owner,
    items: ls.get<InboxItem[]>(`bouvio.comms.inbox.${owner}`, []),
    read: ls.get<Record<string, true>>(`bouvio.comms.read.${owner}`, {}),
  });
}

function persist() {
  const s = useInbox.getState();
  ls.set(`bouvio.comms.inbox.${s.owner}`, s.items);
  // Keep read marks only for things that still exist or may come back.
  ls.set(`bouvio.comms.read.${s.owner}`, s.read);
}

function add(item: InboxItem) {
  ensureOwner();
  useInbox.setState((s) => (s.items.some((x) => x.id === item.id) ? s : { items: [item, ...s.items].slice(0, MAX_ITEMS) }));
  persist();
}

export function markRead(ids: string[]) {
  ensureOwner();
  useInbox.setState((s) => {
    const read = { ...s.read };
    ids.forEach((id) => (read[id] = true));
    return { read };
  });
  persist();
}

export function clearRead() {
  ensureOwner();
  useInbox.setState((s) => ({ items: s.items.filter((i) => !s.read[i.id]) }));
  persist();
}

/** Threads that wait on a person or failed, as inbox items. Keyed by status and
 * time, so a thread that gets stuck again shows up unread again. */
function useNeeds(): InboxItem[] {
  const threads = useStore((s) => s.threads);
  const workspaces = useStore((s) => s.workspaces);
  return useMemo(() => {
    const out: InboxItem[] = [];
    for (const [ws, list] of Object.entries(threads)) {
      const wsName = workspaces.find((w) => w.id === ws)?.name ?? "";
      for (const th of list ?? []) {
        if (th.status !== "blocked" && th.status !== "error") continue;
        out.push({
          id: `needs:${th.id}:${th.status}:${th.updated_at}`,
          kind: "needs",
          ws,
          title: th.title,
          body: th.status === "blocked" ? t("comms.inbox.waiting", { ws: wsName }) : t("comms.inbox.failed", { ws: wsName }),
          at: th.updated_at,
          thread: th.id,
        });
      }
    }
    return out;
  }, [threads, workspaces]);
}

export function useInboxItems(): (InboxItem & { unread: boolean })[] {
  const items = useInbox((s) => s.items);
  const read = useInbox((s) => s.read);
  const needs = useNeeds();
  return useMemo(
    () => [...needs, ...items].map((i) => ({ ...i, unread: !read[i.id] })).sort((a, b) => b.at.localeCompare(a.at)),
    [needs, items, read],
  );
}

export function useInboxBadge() {
  const items = useInboxItems();
  const n = items.filter((i) => i.unread).length;
  return n || undefined;
}

// ---- detection --------------------------------------------------------------------

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `@Ada`, `@ada lovelace` and `@here` mention Ada Lovelace. */
export function mentions(text: string, name: string) {
  if (/(^|[^\p{L}\p{N}_])@here(?![\p{L}\p{N}_])/iu.test(text)) return true;
  const full = name.trim();
  if (!full) return false;
  const first = full.split(/\s+/)[0];
  return [full, first].some((n) => new RegExp(`(^|[^\\p{L}\\p{N}_])@${escapeRe(n)}(?![\\p{L}\\p{N}_])`, "iu").test(text));
}

// ---- notifications ------------------------------------------------------------------

export interface NotifyPrefs {
  approvals: boolean;
  mentions: boolean;
  longRuns: boolean;
  huddles: boolean;
}
const PREFS_KEY = "bouvio.comms.notify";
const DEFAULT_PREFS: NotifyPrefs = { approvals: true, mentions: true, longRuns: true, huddles: true };

export const useNotifyPrefs = create<NotifyPrefs>(() => ({ ...DEFAULT_PREFS, ...ls.get<Partial<NotifyPrefs>>(PREFS_KEY, {}) }));
export function setNotifyPref(p: Partial<NotifyPrefs>) {
  useNotifyPrefs.setState(p);
  ls.set(PREFS_KEY, useNotifyPrefs.getState());
  if (Object.values(p).some(Boolean)) ensurePermission().catch(() => {});
}

let permission: Promise<boolean> | null = null;

/** Ask the OS (or the browser) once; later calls reuse the answer. */
export function ensurePermission(): Promise<boolean> {
  permission ??= (async () => {
    if (backend.live) {
      const n = await import("@tauri-apps/plugin-notification");
      if (await n.isPermissionGranted()) return true;
      return (await n.requestPermission()) === "granted";
    }
    if (typeof Notification === "undefined") return false;
    if (Notification.permission === "granted") return true;
    if (Notification.permission === "denied") return false;
    return (await Notification.requestPermission()) === "granted";
  })().catch(() => false);
  return permission;
}

export async function osNotify(title: string, body: string) {
  if (typeof document !== "undefined" && document.hasFocus()) return;
  if (!(await ensurePermission())) return;
  try {
    if (backend.live) {
      const n = await import("@tauri-apps/plugin-notification");
      n.sendNotification({ title, body });
    } else {
      new Notification(title, { body, silent: false });
    }
  } catch {}
}

// ---- the listeners, mounted once by the comms overlay -------------------------------

const wsName = (id: string) => useStore.getState().workspaces.find((w) => w.id === id)?.name ?? "";
const threadOf = (id: string) => Object.values(useStore.getState().threads).flat().find((x) => x.id === id);
const clip = (s: string, n = 140) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

let started = false;
export function startInbox() {
  if (started) return;
  started = true;
  ensureOwner();
  useStore.subscribe((s, prev) => {
    if (s.hub.user?.id !== prev.hub.user?.id) ensureOwner();
  });

  backend.on<ChatMessage>("hub-chat", (m) => {
    const me = useStore.getState().hub.user;
    if (!me || m.author.id === me.id || !mentions(m.text, me.name)) return;
    add({
      id: `mention:${m.id}`,
      kind: "mention",
      ws: m.workspace_id,
      title: t("comms.inbox.mentioned", { name: m.author.name, channel: m.channel }),
      body: clip(m.text),
      at: m.at,
      who: m.author.name,
      chat: { channel: m.channel, message: m.parent ?? m.id, parent: m.parent },
    });
    if (useNotifyPrefs.getState().mentions) osNotify(t("comms.notify.mention", { name: m.author.name, ws: wsName(m.workspace_id) }), clip(m.text));
  });

  backend.on<ThreadEnvelope>("thread-event", (env) => {
    const e = env.event;
    if (e.type === "approval_request") {
      const th = threadOf(env.thread_id);
      if (useNotifyPrefs.getState().approvals) osNotify(t("comms.notify.approval", { title: th?.title ?? "" }), t("comms.notify.approvalBody", { tool: e.tool }));
    } else if (e.type === "turn_complete" && e.duration_ms >= LONG_RUN_MS) {
      const th = threadOf(env.thread_id);
      if (!th) return;
      const minutes = Math.max(1, Math.round(e.duration_ms / 60_000));
      add({
        id: `finished:${env.thread_id}:${env.seq}`,
        kind: "finished",
        ws: th.workspace_id,
        title: th.title,
        body: t("comms.inbox.finished", { minutes, ws: wsName(th.workspace_id) }),
        at: env.at,
        thread: th.id,
      });
      if (useNotifyPrefs.getState().longRuns) osNotify(t("comms.notify.finished", { title: th.title }), t("comms.inbox.finished", { minutes, ws: wsName(th.workspace_id) }));
    }
  });

  backend.on<SignalEvent>("hub-signal", (e) => {
    if (e.kind !== "join" || e.payload?.to_peer) return;
    const me = useStore.getState().hub.user;
    if (!me || e.from.id === me.id) return;
    const others = Object.keys(useComms.getState().huddles[e.workspace_id] ?? {}).filter((id) => id !== e.from.id);
    if (others.length === 0 && useNotifyPrefs.getState().huddles) {
      osNotify(t("comms.notify.huddle", { name: e.from.name }), wsName(e.workspace_id));
    }
  });
}
