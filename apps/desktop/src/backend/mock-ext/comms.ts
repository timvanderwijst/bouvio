// Browser-preview stand-ins for this area's runner methods (`handlers`) and
// desktop-only app methods (`app`). See ../mock-bus.ts to fire live events.
//
// Comms talks to the hub, not the runner, so this mock wraps the preview hub
// (`mockBackend.hub`) once it exists: channels, threads, reactions, pins,
// @lead replies, and a fake huddle participant.

import type { ChatMessage } from "../../protocol/ChatMessage";
import type { ClientMsg } from "../../protocol/ClientMsg";
import type { HubUser } from "../../protocol/HubUser";
import type { Member } from "../../protocol/Member";
import { mockFire } from "../mock-bus";

export const handlers: Record<string, (p: Record<string, any>) => unknown> = {};
export const app: Record<string, (p: Record<string, any>) => unknown> = {};

const uid = () => crypto.randomUUID();
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface State {
  me: HubUser;
  members: HubUser[];
  messages: ChatMessage[];
  channels: { name: string; created_at: string; created_by: string | null }[];
  huddle: Map<string, { user: HubUser; conn: number }>;
}
let st: State | null = null;

/** Seeds from the preview hub's own sample chat and members. */
async function state(orig: { request: (m: string, p: string, b?: unknown) => Promise<unknown>; status: () => Promise<{ user: HubUser | null }> }, ws: string): Promise<State> {
  if (st) return st;
  const me = (await orig.status()).user!;
  const members = (((await orig.request("GET", `/workspaces/${ws}/members`)) as Member[]) ?? []).map((m) => m.user);
  const seed = (((await orig.request("GET", `/workspaces/${ws}/chat?channel=general`)) as ChatMessage[]) ?? []).map((m) => ({ ...m }));
  const [jonas, noor] = [members.find((u) => u.name === "Jonas") ?? me, members.find((u) => u.name === "Noor") ?? me];
  const at = (min: number) => ago(min);
  const msg = (author: HubUser, text: string, min: number, extra: Partial<ChatMessage> = {}): ChatMessage => ({
    id: uid(),
    workspace_id: ws,
    channel: "general",
    author,
    text,
    at: at(min),
    parent: null,
    reactions: [],
    pinned: false,
    ...extra,
  });
  const earlier = [
    msg(noor, "Release notes for this week are in **#design**. Shout if anything is missing.", 60 * 26, { pinned: true }),
    msg(jonas, "Morning! Picking up the hub invites today.", 60 * 25),
  ];
  if (seed[0]) seed[0].reactions = [["👀", [me.id]]];
  if (seed[1]) seed[1].reactions = [["🎉", [jonas.id, noor.id]], ["👍", [jonas.id]]];
  const root = seed[2] ?? seed[0];
  const replies = root
    ? [
        msg(me, "Resend is fine. Free tier covers us, and it is plain SMTP for self-hosters anyway.", 9, { parent: root.id }),
        msg(jonas, `Agreed. @${me.name} can you update the compose file?`, 7, { parent: root.id }),
      ]
    : [];
  const design = [msg(noor, "Dark diff colours: two options in the board. I lean to the softer one.", 90, { channel: "design" })];
  st = {
    me,
    members,
    messages: [...earlier, ...seed, ...replies, ...design],
    channels: [
      { name: "general", created_at: at(9000), created_by: null },
      { name: "design", created_at: at(5000), created_by: noor.id },
      { name: "releases", created_at: at(4000), created_by: me.id },
    ],
    huddle: new Map(),
  };
  return st;
}

function summaries(s: State, ws: string, channel: string) {
  const map = new Map<string, ChatMessage[]>();
  for (const m of s.messages) if (m.workspace_id === ws && m.channel === channel && m.parent) map.set(m.parent, [...(map.get(m.parent) ?? []), m]);
  return [...map].map(([parent, list]) => ({
    parent,
    count: list.length,
    last_at: list[list.length - 1].at,
    authors: [...new Map([...list].reverse().map((m) => [m.author.id, m.author])).values()].slice(0, 5),
  }));
}

const query = (path: string) => new URLSearchParams(path.split("?")[1] ?? "");

function wrap(mock: { hub: Record<string, any> }) {
  const orig = { ...mock.hub } as any;
  const hub = mock.hub;

  hub.request = async (method: string, path: string, body?: any) => {
    const m = path.match(/^\/workspaces\/([^/?]+)(\/[^?]*)?/);
    if (path.startsWith("/ice")) return { iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }], ttl: 43200 };
    if (!m) return orig.request(method, path, body);
    const ws = m[1];
    const rest = m[2] ?? "";
    if (rest === "/members" || rest === "/invites") return orig.request(method, path, body);
    const s = await state(orig, ws);
    const q = query(path);
    if (rest === "/channels" && method === "POST") {
      const name = String(body?.name ?? "").trim().toLowerCase().replace(/^#/, "").replace(/[^\p{L}\p{N}_]+/gu, "-").replace(/^-|-$/g, "").slice(0, 64);
      if (!name) throw new Error("a channel name needs letters or digits");
      let ch = s.channels.find((c) => c.name === name);
      if (!ch) s.channels.push((ch = { name, created_at: new Date().toISOString(), created_by: s.me.id }));
      return ch;
    }
    if (rest === "/channels") {
      const [g, ...others] = s.channels;
      return [g, ...others.sort((a, b) => a.name.localeCompare(b.name))];
    }
    if (rest === "/chat/pinned") return s.messages.filter((x) => x.pinned && (!q.get("channel") || x.channel === q.get("channel"))).reverse();
    if (rest === "/chat/replies") return summaries(s, ws, q.get("channel") ?? "general");
    if (rest === "/huddle") return { workspace_id: ws, participants: [...s.huddle.values()].map((p) => p.user), since: s.huddle.size ? new Date().toISOString() : null };
    if (rest === "/chat") {
      const parent = q.get("parent");
      if (parent) return s.messages.filter((x) => x.parent === parent);
      const channel = q.get("channel") ?? "general";
      const before = q.get("before");
      const list = s.messages.filter((x) => !x.parent && x.channel === channel && (!before || x.at < before));
      return list.slice(-Number(q.get("limit") ?? 50));
    }
    return orig.request(method, path, body);
  };

  hub.send = async (msg: ClientMsg) => {
    if (!("workspace_id" in msg)) return orig.send(msg);
    const ws = msg.workspace_id;
    const s = await state(orig, ws);
    const post = (m: ChatMessage) => {
      s.messages.push(m);
      mockFire("hub-chat", m);
    };
    const update = (m: ChatMessage) => mockFire("hub-chat-updated", { ...m, reactions: m.reactions.map(([e, u]) => [e, [...u]]) });
    const base = { id: uid(), workspace_id: ws, author: s.me, at: new Date().toISOString(), reactions: [], pinned: false };
    switch (msg.t) {
      case "chat": {
        const m: ChatMessage = { ...base, channel: msg.channel, text: msg.text, parent: null };
        post(m);
        lead(s, m);
        if (/\?\s*$/.test(msg.text)) {
          const other = s.members.find((u) => u.id !== s.me.id);
          if (other) setTimeout(() => post({ ...base, id: uid(), author: other, at: new Date().toISOString(), channel: msg.channel, text: "Looking at it now.", parent: null }), 1800);
        }
        return;
      }
      case "chat_reply": {
        const root = s.messages.find((x) => x.id === msg.parent);
        if (!root) return;
        post({ ...base, channel: root.channel, text: msg.text, parent: root.parent ?? root.id });
        return;
      }
      case "react": {
        const m = s.messages.find((x) => x.id === msg.message_id);
        if (!m) return;
        const i = m.reactions.findIndex(([e]) => e === msg.emoji);
        if (i < 0) m.reactions.push([msg.emoji, [s.me.id]]);
        else {
          const users = m.reactions[i][1];
          m.reactions[i][1] = users.includes(s.me.id) ? users.filter((u) => u !== s.me.id) : [...users, s.me.id];
          if (!m.reactions[i][1].length) m.reactions.splice(i, 1);
        }
        update(m);
        return;
      }
      case "pin": {
        const m = s.messages.find((x) => x.id === msg.message_id);
        if (!m) return;
        m.pinned = msg.pinned;
        update(m);
        return;
      }
      case "signal": {
        if (msg.to === null && msg.kind === "join") fakeHuddle(s, ws);
        if (msg.to === null && msg.kind === "leave") {
          s.huddle.clear();
          stopFake();
        }
        return;
      }
      default:
        return orig.send(msg);
    }
  };
}

/** `@Lead …` in the preview: the replies a hosting runner would post. */
async function lead(s: State, m: ChatMessage) {
  const match = m.text.match(/^@(Desktop|Runner|Hub|Design|Docs)\b[:,]?\s*(.*)$/is);
  if (!match) return;
  const reply = (text: string, after: number) =>
    wait(after).then(() => {
      const r: ChatMessage = { id: uid(), workspace_id: m.workspace_id, channel: m.channel, author: s.me, text, at: new Date().toISOString(), parent: m.id, reactions: [], pinned: false };
      s.messages.push(r);
      mockFire("hub-chat", r);
    });
  const title = (match[2] || "New thread").split("\n")[0].slice(0, 60);
  const fakeId = "00000000-0000-4000-8000-000000000000";
  await reply(`Started [${title}](cuna://thread/${fakeId})`, 700);
  await reply(`This is the browser preview, so no agent ran. In the app, ${match[1]} works on this on the host's runner and posts its answer here.\n\n[${title}](cuna://thread/${fakeId})`, 2500);
}

// ---- a fake huddle participant ------------------------------------------------------

let fakeTimer = 0;
function stopFake() {
  window.clearInterval(fakeTimer);
  fakeTimer = 0;
}

function fakeHuddle(s: State, ws: string) {
  const jonas = s.members.find((u) => u.name === "Jonas");
  if (!jonas) return;
  const peer = "preview-jonas";
  s.huddle.set(jonas.id, { user: jonas, conn: 9001 });
  const signal = (kind: string, payload: Record<string, unknown>) => mockFire("hub-signal", { workspace_id: ws, from: jonas, kind, payload: { peer, conn: 9001, ...payload } });
  setTimeout(() => signal("join", { media: { muted: false, camera: false, screen: false } }), 900);
  let muted = false;
  stopFake();
  fakeTimer = window.setInterval(() => {
    muted = !muted;
    signal("state", { media: { muted, camera: false, screen: false } });
  }, 6000);
}

// The preview backend imports this module first, so wrap it once it is ready.
if (typeof window !== "undefined" && !("__TAURI_INTERNALS__" in window)) {
  import("../mock").then(({ mockBackend }) => wrap(mockBackend as unknown as { hub: Record<string, any> })).catch(() => {});
}
