// The browser client, served by the hub at /app/. Everything goes to the hub on
// the same origin: REST for sign-in and lists, the WebSocket for RPCs to the
// runner that hosts a workspace and for live events. No local runner, no keys.

import type { HubStatus } from "../protocol/HubStatus";
import type { HubUser } from "../protocol/HubUser";
import type { Workspace } from "../protocol/Workspace";
import { t } from "../i18n";
import type { Backend, Unlisten } from "./types";
import { RpcTable, eventFor, toWorkspaces } from "./web-rpc";

const TOKEN_KEY = "cuna.hub.token";

const store = {
  get(): string | null {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set(v: string | null) {
    try {
      if (v) localStorage.setItem(TOKEN_KEY, v);
      else localStorage.removeItem(TOKEN_KEY);
    } catch {}
  },
};

let token = store.get();
let user: HubUser | null = null;
let socket: WebSocket | null = null;
let opened: Promise<void> | null = null;
let connected = false;
let retry = 0;
const table = new RpcTable();
const listeners = new Map<string, Set<(p: any) => void>>();

// ---- sign-in state, for the sign-in screen --------------------------------------------

const authSubs = new Set<() => void>();
let authWaiters: (() => void)[] = [];

/** Signed in or not, for components (useSyncExternalStore). */
export const webAuth = {
  signedIn: () => !!token,
  subscribe(cb: () => void) {
    authSubs.add(cb);
    return () => void authSubs.delete(cb);
  },
};

function authChanged() {
  authSubs.forEach((f) => f());
  if (token) {
    const w = authWaiters;
    authWaiters = [];
    w.forEach((f) => f());
  }
}

/** Calls made before sign-in wait for it, so the app starts behind the sign-in screen. */
const authed = () => (token ? Promise.resolve() : new Promise<void>((r) => authWaiters.push(r)));

function emit(name: string, payload: unknown) {
  listeners.get(name)?.forEach((f) => {
    try {
      f(payload);
    } catch (e) {
      console.error(e);
    }
  });
}

function signedOut() {
  token = null;
  user = null;
  store.set(null);
  socket?.close();
  socket = null;
  opened = null;
  authChanged();
}

// ---- REST ----------------------------------------------------------------------------------

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined && body !== null) headers["Content-Type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: body == null ? undefined : JSON.stringify(body) });
  } catch {
    throw new Error("Cannot reach the hub.");
  }
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 401 && token) signedOut();
    let msg = text;
    try {
      msg = JSON.parse(text).error ?? text;
    } catch {}
    throw new Error(msg || `${res.status} ${res.statusText}`);
  }
  if (!text) return null as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as T;
  }
}

// ---- WebSocket -----------------------------------------------------------------------------

function connect(): Promise<void> {
  if (opened) return opened;
  if (!token) return Promise.reject(new Error("Sign in first."));
  const url = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws?token=${encodeURIComponent(token)}`;
  const ws = new WebSocket(url);
  socket = ws;
  opened = new Promise<void>((resolve, reject) => {
    ws.onopen = () => {
      connected = true;
      retry = 0;
      resolve();
      emit("hub-status", { connected: true });
    };
    ws.onmessage = (e) => {
      let msg: any;
      try {
        msg = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (msg.t === "rpc_result") {
        table.settle(msg);
        return;
      }
      if (msg.t === "welcome") user = msg.user;
      if (msg.t === "error") console.warn("hub:", msg.message);
      const ev = eventFor(msg);
      if (ev) emit(ev.name, ev.payload);
    };
    ws.onclose = () => {
      const was = connected;
      connected = false;
      if (socket === ws) {
        socket = null;
        opened = null;
      }
      table.failAll("Lost the connection to the hub. Try again in a moment.");
      reject(new Error("Cannot reach the hub."));
      if (was) emit("hub-status", { connected: false });
      // Come back on our own while signed in, slower each time.
      if (token && socket === null) {
        const wait = Math.min(30_000, 1000 * 2 ** retry++);
        setTimeout(() => token && !socket && connect().catch(() => {}), wait);
      }
    };
  });
  opened.catch(() => {});
  return opened;
}

function send(msg: object) {
  if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("Not connected to the hub.");
  socket.send(JSON.stringify(msg));
}

async function rpc<T>(workspaceId: string | null, method: string, params: Record<string, unknown> = {}): Promise<T> {
  if (method === "detect_harnesses") return [] as T;
  if (method === "list_workspaces") {
    await authed();
    return toWorkspaces(await request("GET", "/workspaces")) as T;
  }
  if (!workspaceId) throw new Error(t("platform.web.desktopOnly"));
  await authed();
  await connect();
  const { id, promise } = table.open<T>();
  try {
    send({ t: "rpc", id, workspace_id: workspaceId, method, params });
  } catch (e) {
    table.fail(id, String(e instanceof Error ? e.message : e));
  }
  return promise;
}

if (token) connect().catch(() => {});

// ---- the Backend ---------------------------------------------------------------------------

const desktopOnly = async (): Promise<never> => {
  throw new Error(t("platform.web.desktopOnly"));
};

export const webBackend: Backend = {
  live: true,
  rpc,
  on(event, cb) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event)!.add(cb as (p: any) => void);
    return (() => listeners.get(event)?.delete(cb as (p: any) => void)) as Unlisten;
  },
  app: desktopOnly,
  pickFolder: async () => null,
  openUrl: async (url) => {
    window.open(url, "_blank", "noopener");
  },
  providers: async () => [],
  setKey: desktopOnly,
  listModels: desktopOnly,
  generateMedia: desktopOnly,
  transcribe: desktopOnly,
  hub: {
    async status(): Promise<HubStatus> {
      if (token && !user) user = await request<HubUser>("GET", "/me").catch(() => null);
      return { url: location.origin, user, connected };
    },
    async setUrl() {
      // The web client always talks to the hub that serves it.
    },
    request,
    async signIn(path, body) {
      const v = await request<{ token: string; user: HubUser }>("POST", path, body);
      if (!v?.token) throw new Error("The hub did not return a session.");
      token = v.token;
      user = v.user;
      store.set(token);
      connect().catch(() => {});
      authChanged();
      emit("hub-status", { user });
      return v.user;
    },
    async logout() {
      await request("POST", "/auth/logout").catch(() => {});
      signedOut();
      location.reload();
    },
    async refresh(): Promise<Workspace[]> {
      return rpc<Workspace[]>(null, "list_workspaces");
    },
    async share() {
      throw new Error("Share a workspace from the desktop app that hosts it.");
    },
    async join(code) {
      const c = code.trim().split("/").pop() ?? "";
      await request("POST", `/invites/${encodeURIComponent(c)}/accept`);
      return rpc<Workspace[]>(null, "list_workspaces");
    },
    async send(msg) {
      send(msg);
    },
  },
};
