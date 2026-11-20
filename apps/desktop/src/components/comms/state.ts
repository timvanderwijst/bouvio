// Chat state for the comms area: messages per channel, thread replies, reply
// counts, channels, pins and who is in a huddle. Kept apart from the app store,
// fed by hub events and the hub's REST endpoints.

import { create } from "zustand";
import { backend } from "../../backend";
import type { ChatChannel } from "../../protocol/ChatChannel";
import type { ChatMessage } from "../../protocol/ChatMessage";
import type { HubUser } from "../../protocol/HubUser";
import type { HuddleState } from "../../protocol/HuddleState";
import type { ReplySummary } from "../../protocol/ReplySummary";
import type { Role } from "../../protocol/Role";
import type { Workspace } from "../../protocol/Workspace";
import { useStore } from "../../store";

export const GENERAL = "general";
const key = (ws: string, channel: string) => `${ws}/${channel}`;

export interface HuddlePeerInfo {
  user: HubUser;
  /** The hub connection the peer joined from; a person can join from one tab. */
  conn?: number;
}

interface CommsState {
  /** `ws/channel` → top-level messages, oldest first. */
  messages: Record<string, ChatMessage[]>;
  /** `ws/channel` → no older messages left to load. */
  complete: Record<string, boolean>;
  /** parent id → replies, oldest first. */
  replies: Record<string, ChatMessage[]>;
  /** parent id → count and authors. */
  summaries: Record<string, ReplySummary>;
  channels: Record<string, ChatChannel[]>;
  pinned: Record<string, ChatMessage[]>;
  /** workspace → people in its huddle (by user id). */
  huddles: Record<string, Record<string, HuddlePeerInfo>>;
  /** `ws/channel` → messages that arrived while the channel was not open. */
  unread: Record<string, number>;
  /** The channel on screen, so new messages there are not unread. */
  open: string | null;
}

export const useComms = create<CommsState>(() => ({
  messages: {},
  complete: {},
  replies: {},
  summaries: {},
  channels: {},
  pinned: {},
  huddles: {},
  unread: {},
  open: null,
}));

const set = useComms.setState;
const get = useComms.getState;

// ---- roles -----------------------------------------------------------------------

const ORDER: Role[] = ["viewer", "commenter", "prompter", "operator", "admin"];
/** My role in a workspace: the host (no role set) is admin. */
export const roleIn = (ws: Workspace | undefined): Role => ws?.role ?? "admin";
export const atLeast = (role: Role, min: Role) => ORDER.indexOf(role) >= ORDER.indexOf(min);

export const me = () => useStore.getState().hub.user;

// ---- loading ---------------------------------------------------------------------

const PAGE = 60;

export async function loadChannel(ws: string, channel: string) {
  const list = (await backend.hub.request<ChatMessage[]>("GET", `/workspaces/${ws}/chat?channel=${encodeURIComponent(channel)}&limit=${PAGE}`)) ?? [];
  set((s) => ({
    messages: { ...s.messages, [key(ws, channel)]: mergeById(s.messages[key(ws, channel)], list) },
    complete: { ...s.complete, [key(ws, channel)]: list.length < PAGE },
  }));
  loadSummaries(ws, channel).catch(() => {});
}

export async function loadOlder(ws: string, channel: string) {
  const k = key(ws, channel);
  const first = get().messages[k]?.[0];
  if (!first || get().complete[k]) return;
  const list =
    (await backend.hub.request<ChatMessage[]>("GET", `/workspaces/${ws}/chat?channel=${encodeURIComponent(channel)}&limit=${PAGE}&before=${encodeURIComponent(first.at)}`)) ?? [];
  set((s) => ({
    messages: { ...s.messages, [k]: mergeById(s.messages[k], list) },
    complete: { ...s.complete, [k]: list.length < PAGE },
  }));
}

export async function loadSummaries(ws: string, channel: string) {
  const list = (await backend.hub.request<ReplySummary[]>("GET", `/workspaces/${ws}/chat/replies?channel=${encodeURIComponent(channel)}`)) ?? [];
  set((s) => {
    const summaries = { ...s.summaries };
    for (const r of list) summaries[r.parent] = r;
    return { summaries };
  });
}

export async function loadThread(ws: string, parent: string) {
  const list = (await backend.hub.request<ChatMessage[]>("GET", `/workspaces/${ws}/chat?parent=${parent}&limit=200`)) ?? [];
  set((s) => ({ replies: { ...s.replies, [parent]: mergeById(s.replies[parent], list) } }));
}

export async function loadChannels(ws: string) {
  const list = (await backend.hub.request<ChatChannel[]>("GET", `/workspaces/${ws}/channels`)) ?? [];
  set((s) => ({ channels: { ...s.channels, [ws]: list.length ? list : [{ name: GENERAL, created_at: new Date(0).toISOString(), created_by: null }] } }));
}

export async function loadPinned(ws: string) {
  const list = (await backend.hub.request<ChatMessage[]>("GET", `/workspaces/${ws}/chat/pinned`)) ?? [];
  set((s) => ({ pinned: { ...s.pinned, [ws]: list } }));
}

export async function loadHuddle(ws: string) {
  const h = await backend.hub.request<HuddleState | null>("GET", `/workspaces/${ws}/huddle`);
  if (!h) return;
  set((s) => {
    const prev = s.huddles[ws] ?? {};
    const map: Record<string, HuddlePeerInfo> = {};
    for (const u of h.participants) map[u.id] = prev[u.id] ?? { user: u };
    return { huddles: { ...s.huddles, [ws]: map } };
  });
}

export async function createChannel(ws: string, name: string): Promise<ChatChannel> {
  const ch = await backend.hub.request<ChatChannel>("POST", `/workspaces/${ws}/channels`, { name });
  set((s) => {
    const list = s.channels[ws] ?? [];
    if (list.some((c) => c.name === ch.name)) return s;
    const [general, ...rest] = list;
    return { channels: { ...s.channels, [ws]: [general ?? ch, ...[...rest, ch].filter((c) => c.name !== GENERAL).sort((a, b) => a.name.localeCompare(b.name))] } };
  });
  return ch;
}

// ---- sending ---------------------------------------------------------------------

export const send = (ws: string, channel: string, text: string) => backend.hub.send({ t: "chat", workspace_id: ws, channel, text });
export const reply = (ws: string, parent: string, text: string) => backend.hub.send({ t: "chat_reply", workspace_id: ws, parent, text });
export const react = (ws: string, message_id: string, emoji: string) => backend.hub.send({ t: "react", workspace_id: ws, message_id, emoji });
export const pin = (ws: string, message_id: string, pinned: boolean) => backend.hub.send({ t: "pin", workspace_id: ws, message_id, pinned });

export function markRead(ws: string, channel: string) {
  const k = key(ws, channel);
  set((s) => ({ open: k, unread: s.unread[k] ? { ...s.unread, [k]: 0 } : s.unread }));
}
export function closeChannel() {
  set({ open: null });
}

// ---- live updates ----------------------------------------------------------------

function mergeById(old: ChatMessage[] | undefined, incoming: ChatMessage[]) {
  const map = new Map((old ?? []).map((m) => [m.id, m]));
  for (const m of incoming) map.set(m.id, m);
  return [...map.values()].sort((a, b) => a.at.localeCompare(b.at));
}

const replaceIn = (list: ChatMessage[] | undefined, m: ChatMessage) => (list?.some((x) => x.id === m.id) ? list.map((x) => (x.id === m.id ? m : x)) : list);

function onChat(m: ChatMessage) {
  set((s) => {
    if (m.parent) {
      const prev = s.summaries[m.parent];
      const authors = [m.author, ...(prev?.authors ?? []).filter((a) => a.id !== m.author.id)].slice(0, 5);
      return {
        replies: s.replies[m.parent] ? { ...s.replies, [m.parent]: mergeById(s.replies[m.parent], [m]) } : s.replies,
        summaries: { ...s.summaries, [m.parent]: { parent: m.parent, count: (prev?.count ?? 0) + 1, last_at: m.at, authors } },
      };
    }
    const k = key(m.workspace_id, m.channel);
    const channels = s.channels[m.workspace_id];
    const mine = m.author.id === me()?.id;
    return {
      messages: s.messages[k] ? { ...s.messages, [k]: mergeById(s.messages[k], [m]) } : s.messages,
      unread: s.open === k || mine ? s.unread : { ...s.unread, [k]: (s.unread[k] ?? 0) + 1 },
      channels:
        channels && !channels.some((c) => c.name === m.channel)
          ? { ...s.channels, [m.workspace_id]: [...channels, { name: m.channel, created_at: m.at, created_by: m.author.id }] }
          : s.channels,
    };
  });
}

function onChatUpdated(m: ChatMessage) {
  set((s) => {
    const k = key(m.workspace_id, m.channel);
    const pinnedList = s.pinned[m.workspace_id];
    return {
      messages: s.messages[k] ? { ...s.messages, [k]: replaceIn(s.messages[k], m)! } : s.messages,
      replies: m.parent && s.replies[m.parent] ? { ...s.replies, [m.parent]: replaceIn(s.replies[m.parent], m)! } : s.replies,
      pinned: pinnedList
        ? { ...s.pinned, [m.workspace_id]: m.pinned ? [m, ...pinnedList.filter((x) => x.id !== m.id)] : pinnedList.filter((x) => x.id !== m.id) }
        : s.pinned,
    };
  });
}

export interface SignalEvent {
  workspace_id: string;
  from: HubUser;
  kind: string;
  payload: Record<string, any>;
}

/** Keeps track of who is in each workspace's huddle from join/leave signals. */
function onSignal(e: SignalEvent) {
  if (e.kind !== "join" && e.kind !== "leave") return;
  // A leave from a connection other than the one that joined (a second tab) keeps them in.
  set((s) => {
    const map = { ...(s.huddles[e.workspace_id] ?? {}) };
    if (e.kind === "join") map[e.from.id] = { user: e.from, conn: e.payload?.conn };
    else if (!e.payload?.conn || !map[e.from.id]?.conn || map[e.from.id].conn === e.payload.conn) delete map[e.from.id];
    return { huddles: { ...s.huddles, [e.workspace_id]: map } };
  });
}

let started = false;
/** Subscribe to hub events once; called by the comms overlay at startup. */
export function startComms() {
  if (started) return;
  started = true;
  backend.on<ChatMessage>("hub-chat", onChat);
  backend.on<ChatMessage>("hub-chat-updated", onChatUpdated);
  backend.on<SignalEvent>("hub-signal", onSignal);
}

/** Unread messages across the channels of one workspace. */
export function useUnread(ws: string | null) {
  return useComms((s) => {
    if (!ws) return 0;
    let n = 0;
    for (const [k, v] of Object.entries(s.unread)) if (k.startsWith(`${ws}/`)) n += v;
    return n;
  });
}

export const channelKey = key;
