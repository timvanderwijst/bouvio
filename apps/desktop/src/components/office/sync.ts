// One live Y.Doc per open document, shared by every component showing it.
// Local edits are batched (~100 ms) into `doc_update`; remote `office-update`
// notices are applied with origin "remote". Presence goes through
// y-protocols/awareness, carried by `doc_awareness` / `office-awareness`.

import { useEffect, useState, useSyncExternalStore } from "react";
import * as Y from "yjs";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import { backend } from "../../backend";
import { personColor } from "../Sidebar";
import { rpc, useStore } from "../../store";

export const REMOTE = "remote";

export function toB64(u: Uint8Array): string {
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export interface Peer {
  clientId: number;
  name: string;
  color: string;
}

/** This window's id, so it can skip its own echoes. */
const CLIENT = Math.random().toString(36).slice(2, 12);

export class Session {
  readonly ydoc = new Y.Doc();
  readonly awareness = new Awareness(this.ydoc);
  ready = false;
  error: string | null = null;
  refs = 0;
  private queue: Uint8Array[] = [];
  private timer = 0;
  private awTimer = 0;
  private awChanged = new Set<number>();
  private subs = new Set<() => void>();
  private off: (() => void)[] = [];
  private readyWait: Promise<void>;
  private version = 0;

  constructor(
    readonly id: string,
    readonly ws: string,
  ) {
    const name = useStore.getState().hub.user?.name ?? useStore.getState().userName;
    this.awareness.setLocalStateField("user", { name, color: personColor(name) });

    this.ydoc.on("update", (u: Uint8Array, origin: unknown) => {
      if (origin === REMOTE) return;
      this.queue.push(u);
      if (!this.timer) this.timer = window.setTimeout(() => this.flush(), 100);
    });
    this.awareness.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      if (origin === REMOTE) {
        // Someone new: tell them who is here.
        if (added.length) this.sendAwareness([this.ydoc.clientID]);
        this.emit();
        return;
      }
      this.sendAwareness([...added, ...updated, ...removed]);
    });
    this.off.push(
      backend.on<{ workspace_id: string; kind: string; payload: any }>("workspace-notice", ({ kind, payload }) => {
        if (payload?.id !== this.id) return;
        if (kind === "office-update" && payload.client !== CLIENT) {
          Y.applyUpdate(this.ydoc, fromB64(payload.update), REMOTE);
        } else if (kind === "office-awareness" && payload.state?.client !== CLIENT && typeof payload.state?.u === "string") {
          applyAwarenessUpdate(this.awareness, fromB64(payload.state.u), REMOTE);
        }
      }),
    );
    this.readyWait = rpc<string>("get_doc_state", { id }, ws)
      .then((state) => {
        Y.applyUpdate(this.ydoc, fromB64(state), REMOTE);
        this.ready = true;
        this.sendAwareness([this.ydoc.clientID]);
      })
      .catch((e) => {
        this.error = String(e);
      })
      .finally(() => this.emit());
  }

  loaded() {
    return this.readyWait;
  }

  /** Send queued local edits now. */
  async flush() {
    window.clearTimeout(this.timer);
    this.timer = 0;
    if (!this.queue.length) return;
    const update = this.queue.length === 1 ? this.queue[0] : Y.mergeUpdates(this.queue);
    this.queue = [];
    try {
      await rpc("doc_update", { id: this.id, update: toB64(update), client: CLIENT }, this.ws);
    } catch (e) {
      // Keep it for the next try; Yjs merges duplicates.
      this.queue.unshift(update);
      useStore.getState().notify(String(e));
    }
  }

  private sendAwareness(ids: number[]) {
    ids.forEach((i) => this.awChanged.add(i));
    if (this.awTimer) return;
    this.awTimer = window.setTimeout(() => {
      this.awTimer = 0;
      const changed = [...this.awChanged];
      this.awChanged.clear();
      if (!this.ready || !changed.length) return;
      const u = encodeAwarenessUpdate(this.awareness, changed);
      rpc("doc_awareness", { id: this.id, state: { u: toB64(u), client: CLIENT } }, this.ws).catch(() => {});
    }, 80);
  }

  peers(): Peer[] {
    const out: Peer[] = [];
    const seen = new Set<string>();
    this.awareness.getStates().forEach((s, clientId) => {
      const u = s.user as { name?: string; color?: string } | undefined;
      if (clientId === this.ydoc.clientID || !u?.name || seen.has(u.name)) return;
      seen.add(u.name);
      out.push({ clientId, name: u.name, color: u.color ?? personColor(u.name) });
    });
    return out;
  }

  subscribe = (cb: () => void) => {
    this.subs.add(cb);
    return () => void this.subs.delete(cb);
  };
  getVersion = () => this.version;
  private emit() {
    this.version++;
    this.subs.forEach((f) => f());
  }

  async destroy() {
    await this.flush();
    removeAwarenessStates(this.awareness, [this.ydoc.clientID], "local");
    window.clearTimeout(this.awTimer);
    const u = encodeAwarenessUpdate(this.awareness, [this.ydoc.clientID]);
    rpc("doc_awareness", { id: this.id, state: { u: toB64(u), client: CLIENT } }, this.ws).catch(() => {});
    this.off.forEach((f) => f());
    this.awareness.destroy();
    this.ydoc.destroy();
  }
}

const sessions = new Map<string, Session>();

/** Take a reference to a doc's session; release it when done. */
export function acquire(id: string, ws: string): Session {
  let s = sessions.get(id);
  if (!s) {
    s = new Session(id, ws);
    sessions.set(id, s);
  }
  s.refs++;
  return s;
}

export function release(s: Session) {
  s.refs--;
  // Leave a moment for the same doc to be picked up again (a re-render, a route change).
  window.setTimeout(() => {
    if (s.refs <= 0 && sessions.get(s.id) === s) {
      sessions.delete(s.id);
      s.destroy();
    }
  }, 300);
}

/** The live session of a doc while the component is mounted. */
export function useSession(id: string | undefined): Session | null {
  const ws = useStore((s) => s.workspaceId);
  const [session, setSession] = useState<Session | null>(null);
  useEffect(() => {
    if (!id || !ws) return;
    const s = acquire(id, ws);
    setSession(s);
    return () => {
      release(s);
      setSession(null);
    };
  }, [id, ws]);
  useSyncExternalStore(session?.subscribe ?? noopSub, session?.getVersion ?? zero);
  return session;
}

const noopSub = () => () => {};
const zero = () => 0;

/** Re-render whenever a Yjs type (or anything inside it) changes. */
export function useY<T>(type: Y.AbstractType<any> | null | undefined, read: () => T): T {
  const [, bump] = useState(0);
  useEffect(() => {
    if (!type) return;
    const f = () => bump((n) => n + 1);
    type.observeDeep(f);
    return () => type.unobserveDeep(f);
  }, [type]);
  return read();
}

/** Re-render on presence changes; returns the other people in the doc. */
export function usePeers(session: Session | null): Peer[] {
  const [peers, setPeers] = useState<Peer[]>([]);
  useEffect(() => {
    if (!session) return;
    const f = () => setPeers(session.peers());
    f();
    session.awareness.on("change", f);
    return () => session.awareness.off("change", f);
  }, [session]);
  return peers;
}

export const shortId = () => Math.random().toString(36).slice(2, 12);
