// Pure pieces of the web backend, kept free of the DOM so a Node script can
// test them (web/web-rpc.test.mjs): RPC ids matched to results, hub messages
// mapped to the event names the desktop emits, hub workspaces to Workspace.

import type { Workspace } from "../protocol/Workspace";

export interface RpcResultMsg {
  id: number | bigint;
  ok: unknown;
  err: string | null;
}

interface Waiting {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

/** Outstanding RPCs over one socket: each gets an id, its result settles it once. */
export class RpcTable {
  private next = 1;
  private waiting = new Map<number, Waiting>();
  private timeoutMs: number;

  constructor(timeoutMs = 90_000) {
    this.timeoutMs = timeoutMs;
  }

  /** A fresh id and the promise its result will settle. */
  open<T = unknown>(): { id: number; promise: Promise<T> } {
    const id = this.next++;
    const promise = new Promise<T>((resolve, reject) => {
      const timer =
        this.timeoutMs > 0
          ? setTimeout(() => {
              if (this.waiting.delete(id)) reject(new Error("The workspace's host did not answer in time."));
            }, this.timeoutMs)
          : null;
      this.waiting.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
    });
    return { id, promise };
  }

  /** Settle the call a result belongs to. False when nobody waits for it (late, duplicate, unknown). */
  settle(msg: RpcResultMsg): boolean {
    const id = Number(msg.id);
    const w = this.waiting.get(id);
    if (!w) return false;
    this.waiting.delete(id);
    if (w.timer) clearTimeout(w.timer);
    if (msg.err != null) w.reject(new Error(msg.err));
    else w.resolve(msg.ok ?? null);
    return true;
  }

  /** Give up on one call, e.g. when it could not be sent. */
  fail(id: number, reason: string) {
    this.settle({ id, ok: null, err: reason });
  }

  /** The socket went away: nothing in flight will be answered. */
  failAll(reason: string) {
    for (const id of [...this.waiting.keys()]) this.fail(id, reason);
  }

  get size() {
    return this.waiting.size;
  }
}

/** A message from the hub as the app's event bus sees it, or null for none. */
export function eventFor(msg: { t: string; [k: string]: any }): { name: string; payload: unknown } | null {
  switch (msg.t) {
    case "event":
      // Runner events keep their names (`thread-event`, `thread-changed`, …); notices get the desktop's.
      return { name: msg.kind === "notice" ? "workspace-notice" : msg.kind, payload: msg.payload };
    case "chat":
      return { name: "hub-chat", payload: msg.message };
    case "chat_updated":
      return { name: "hub-chat-updated", payload: msg.message };
    case "presence":
      return { name: "hub-presence", payload: { presence: msg.presence, online: msg.online } };
    case "host_status":
      return { name: "hub-host", payload: { workspace_id: msg.workspace_id, online: msg.online } };
    case "signal":
      return { name: "hub-signal", payload: { workspace_id: msg.workspace_id, from: msg.from, kind: msg.kind, payload: msg.payload } };
    case "welcome":
      return { name: "hub-status", payload: { user: msg.user } };
    default:
      return null;
  }
}

/** `GET /workspaces` entries as the shared workspaces the app lists. */
export function toWorkspaces(entries: unknown): Workspace[] {
  if (!Array.isArray(entries)) return [];
  const now = new Date().toISOString();
  return entries.map((w: any) => ({
    id: w.id,
    name: w.name ?? "",
    kind: "shared",
    root: null,
    created_at: w.created_at ?? now,
    role: w.role ?? null,
    host: w.host ?? null,
  }));
}
