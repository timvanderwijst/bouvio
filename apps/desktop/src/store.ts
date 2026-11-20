import { create } from "zustand";
import { backend, setActor } from "./backend";
import type { ApprovalLevel } from "./protocol/ApprovalLevel";
import type { Artifact } from "./protocol/Artifact";
import type { Automation } from "./protocol/Automation";
import type { Board } from "./protocol/Board";
import type { Captain } from "./protocol/Captain";
import type { ChatMessage } from "./protocol/ChatMessage";
import type { Effort } from "./protocol/Effort";
import type { HarnessInfo } from "./protocol/HarnessInfo";
import type { HarnessKind } from "./protocol/HarnessKind";
import type { HubStatus } from "./protocol/HubStatus";
import type { Issue } from "./protocol/Issue";
import type { Member } from "./protocol/Member";
import type { ModelInfo } from "./protocol/ModelInfo";
import type { Presence } from "./protocol/Presence";
import type { ProviderInfo } from "./protocol/ProviderInfo";
import type { PullRequest } from "./protocol/PullRequest";
import type { Thread } from "./protocol/Thread";
import type { ThreadEnvelope } from "./protocol/ThreadEnvelope";
import type { Workspace } from "./protocol/Workspace";
import type { WorkspaceSettings } from "./protocol/WorkspaceSettings";

export type Page = "issues" | "pullRequests" | "automations" | "studio" | "files" | "chat" | "knowledge";
export type RailPage = "runners" | "people";

export type View =
  | { kind: "home" }
  | { kind: "settings" }
  | { kind: "workspaces" }
  | { kind: "threads" }
  | { kind: "page"; page: Page; sub?: string }
  | { kind: "rail"; page: RailPage }
  | { kind: "board"; id: string }
  /** A page registered by a feature area (see src/ext). */
  | { kind: "ext"; id: string; sub?: string }
  | { kind: "thread"; id: string }
  /** A thread that does not exist yet: the first message creates it. */
  | { kind: "draft"; captainId: string | null };

export type PanelTab = "overview" | "changes" | "terminal" | "preview" | (string & {});
export type ThemePref = "system" | "light" | "dark";

export interface ComposerPrefs {
  harness: HarnessKind;
  model: string | null;
  effort: Effort;
  approval: ApprovalLevel;
  isolate: boolean;
}

/** Per-workspace data that pages load when they open and events keep fresh. */
export interface WsData {
  issues?: Issue[];
  prs?: PullRequest[];
  automations?: Automation[];
  artifacts?: Artifact[];
  boards?: Board[];
  settings?: WorkspaceSettings;
  members?: Member[];
  chat?: Record<string, ChatMessage[]>;
  presence?: Record<string, Presence>;
}

interface State {
  ready: boolean;
  harnesses: HarnessInfo[];
  providers: ProviderInfo[];
  models: ModelInfo[];
  hub: HubStatus;
  workspaces: Workspace[];
  workspaceId: string | null;
  captains: Record<string, Captain[]>;
  threads: Record<string, Thread[]>;
  events: Record<string, ThreadEnvelope[]>;
  data: Record<string, WsData>;
  view: View;
  tabs: Record<string, string[]>;
  panel: { open: boolean; tab: PanelTab; wide: boolean; artifact: Artifact | null };
  drafts: Record<string, string>;
  prefs: ComposerPrefs;
  userName: string;
  theme: ThemePref;
  dialog: null | "workspace" | "captain" | "share" | "issue" | "automation" | "signin" | "join";
  dialogArg: unknown;
  palette: boolean;
  toast: string | null;

  init(): Promise<void>;
  go(view: View): void;
  selectWorkspace(id: string): Promise<void>;
  openThread(id: string): Promise<void>;
  closeTab(id: string): void;
  openCaptain(c: Captain): Promise<void>;
  send(text: string): Promise<void>;
  stop(threadId: string): Promise<void>;
  setDraft(key: string, text: string): void;
  setPrefs(p: Partial<ComposerPrefs>): void;
  setPanel(p: Partial<State["panel"]>): void;
  openArtifact(a: Artifact): void;
  createWorkspace(name: string, root: string | null): Promise<void>;
  createCaptain(name: string, instructions: string): Promise<void>;
  setUserName(n: string): void;
  setTheme(t: ThemePref): void;
  setDialog(d: State["dialog"], arg?: unknown): void;
  setPalette(open: boolean): void;
  notify(msg: string): void;
  load<K extends keyof WsData>(key: K, force?: boolean): Promise<void>;
  patch(ws: string, p: Partial<WsData>): void;
  refreshProviders(): Promise<void>;
  refreshHub(): Promise<void>;
}

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

export function applyTheme(pref: ThemePref) {
  const dark = pref === "dark" || (pref === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  const root = document.documentElement;
  const swap = () => (root.dataset.theme = dark ? "dark" : "light");
  const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
  if (doc.startViewTransition && root.dataset.theme && root.dataset.theme !== (dark ? "dark" : "light")) doc.startViewTransition(swap);
  else swap();
}

let initStarted = false;

export const draftKey = (v: View) => (v.kind === "thread" ? v.id : v.kind === "draft" ? `draft:${v.captainId ?? ""}` : "");

/** The workspace id to route a call to; null for app-level calls. */
export const wsOf = () => useStore.getState().workspaceId;
export const rpc = <T,>(method: string, params: Record<string, unknown> = {}, ws: string | null = wsOf()) => backend.rpc<T>(ws, method, params);

const upsertBy = <T extends { id: string }>(list: T[] | undefined, item: T) =>
  list ? (list.some((x) => x.id === item.id) ? list.map((x) => (x.id === item.id ? item : x)) : [item, ...list]) : list;

export const useStore = create<State>((set, get) => ({
  ready: false,
  harnesses: [],
  providers: [],
  models: [],
  hub: { url: null, user: null, connected: false },
  workspaces: [],
  workspaceId: null,
  captains: {},
  threads: {},
  events: {},
  data: {},
  view: { kind: "home" },
  tabs: {},
  panel: { open: true, tab: "overview", wide: false, artifact: null },
  drafts: {},
  prefs: { harness: "claude_code", model: null, effort: "medium", approval: "ask_risky", isolate: true },
  userName: ls.get("bouvio.name") || "Tim",
  theme: (ls.get("bouvio.theme") as ThemePref) || "system",
  dialog: null,
  dialogArg: null,
  palette: false,
  toast: null,

  async init() {
    if (initStarted) return;
    initStarted = true;
    setActor(get().userName);
    const [harnesses, workspaces, hub] = await Promise.all([
      backend.rpc<HarnessInfo[]>(null, "detect_harnesses"),
      backend.rpc<Workspace[]>(null, "list_workspaces"),
      backend.hub.status().catch(() => get().hub),
    ]);
    const lists = await Promise.all(
      workspaces.map((w) =>
        Promise.all([backend.rpc<Thread[]>(w.id, "list_threads", { workspace_id: w.id }), backend.rpc<Captain[]>(w.id, "list_captains", { workspace_id: w.id })]).catch(
          () => [[], []] as [Thread[], Captain[]],
        ),
      ),
    );
    const threads: State["threads"] = {};
    const captains: State["captains"] = {};
    workspaces.forEach((w, i) => {
      threads[w.id] = lists[i][0];
      captains[w.id] = lists[i][1];
    });
    const saved = ls.get("bouvio.workspace");
    const workspaceId = workspaces.find((w) => w.id === saved)?.id ?? workspaces[0]?.id ?? null;
    const preferred = harnesses.find((h) => h.available && h.kind !== "api")?.kind ?? "api";

    backend.on<ThreadEnvelope>("thread-event", (e) =>
      set((s) => {
        const list = s.events[e.thread_id];
        if (!list || list.some((x) => x.seq === e.seq)) return s;
        return { events: { ...s.events, [e.thread_id]: [...list, e] } };
      }),
    );
    backend.on<Thread>("thread-changed", (t) =>
      set((s) => {
        const list = s.threads[t.workspace_id] ?? [];
        const next = list.some((x) => x.id === t.id) ? list.map((x) => (x.id === t.id ? t : x)) : [t, ...list];
        return { threads: { ...s.threads, [t.workspace_id]: next } };
      }),
    );
    backend.on<{ workspace_id: string; kind: string; payload: any }>("workspace-notice", ({ workspace_id: w, kind, payload }) => {
      const d = get().data[w] ?? {};
      const p = get().patch;
      if (kind === "issue-changed") p(w, { issues: upsertBy(d.issues, payload) });
      else if (kind === "issue-deleted") p(w, { issues: d.issues?.filter((x) => x.id !== payload.id) });
      else if (kind === "automation-changed") p(w, { automations: upsertBy(d.automations, payload) });
      else if (kind === "automation-deleted") p(w, { automations: d.automations?.filter((x) => x.id !== payload.id) });
      else if (kind === "artifact-changed") p(w, { artifacts: upsertBy(d.artifacts, payload) });
      else if (kind === "settings-changed") p(w, { settings: payload });
      else if (kind === "pull-requests-changed") get().load("prs", true);
      else if (kind === "board-changed" || kind === "board-deleted") get().load("boards", true);
      boardListeners.forEach((f) => f(w, kind, payload));
    });
    backend.on<ChatMessage>("hub-chat", (m) => {
      if (m.parent) return; // thread replies live in the chat area
      const d = get().data[m.workspace_id] ?? {};
      const chat = { ...(d.chat ?? {}) };
      chat[m.channel] = [...(chat[m.channel] ?? []), m];
      get().patch(m.workspace_id, { chat });
    });
    backend.on<{ presence: Presence; online: boolean }>("hub-presence", ({ presence, online }) => {
      const w = presence.workspace_id;
      const map = { ...(get().data[w]?.presence ?? {}) };
      if (online) map[presence.user.id] = presence;
      else delete map[presence.user.id];
      get().patch(w, { presence: map });
    });
    backend.on("hub-status", () => get().refreshHub());

    set({
      ready: true,
      harnesses,
      hub,
      workspaces,
      workspaceId,
      threads,
      captains,
      prefs: { ...get().prefs, harness: preferred },
      view: workspaceId ? { kind: "draft", captainId: null } : { kind: "home" },
    });
    get().refreshProviders();
    const recent = workspaceId ? [...(threads[workspaceId] ?? [])].sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0] : null;
    if (recent) await get().openThread(recent.id);
  },

  go(view) {
    set({ view });
    const ws = get().workspaceId;
    if (ws && get().hub.connected) {
      const viewing = view.kind === "thread" ? view.id : view.kind === "board" ? view.id : null;
      backend.hub.send({ t: "presence", workspace_id: ws, viewing, cursor: null }).catch(() => {});
    }
  },

  async selectWorkspace(id) {
    ls.set("bouvio.workspace", id);
    set({ workspaceId: id });
    if (!get().threads[id]) {
      const [t, c] = await Promise.all([rpc<Thread[]>("list_threads", { workspace_id: id }, id), rpc<Captain[]>("list_captains", { workspace_id: id }, id)]).catch(
        () => [[], []] as [Thread[], Captain[]],
      );
      set((s) => ({ threads: { ...s.threads, [id]: t }, captains: { ...s.captains, [id]: c } }));
    }
    const tabs = get().tabs[id];
    if (tabs?.length) await get().openThread(tabs[tabs.length - 1]);
    else get().go({ kind: "draft", captainId: null });
  },

  async openThread(id) {
    const s = get();
    const t = Object.values(s.threads).flat().find((x) => x.id === id);
    if (!t) return;
    if (!s.events[id]) {
      const list = await rpc<ThreadEnvelope[]>("thread_events", { thread_id: id }, t.workspace_id);
      set((st) => ({ events: { ...st.events, [id]: list } }));
    }
    set((st) => {
      const tabs = st.tabs[t.workspace_id] ?? [];
      return { workspaceId: t.workspace_id, tabs: { ...st.tabs, [t.workspace_id]: tabs.includes(id) ? tabs : [...tabs, id] } };
    });
    get().go({ kind: "thread", id });
  },

  closeTab(id) {
    const s = get();
    const ws = s.workspaceId;
    if (!ws) return;
    const tabs = (s.tabs[ws] ?? []).filter((x) => x !== id);
    set({ tabs: { ...s.tabs, [ws]: tabs } });
    if (s.view.kind === "thread" && s.view.id === id) {
      if (tabs.length) get().openThread(tabs[tabs.length - 1]);
      else get().go({ kind: "draft", captainId: null });
    }
  },

  async openCaptain(c) {
    const own = (get().threads[c.workspace_id] ?? []).filter((t) => t.captain_id === c.id).sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
    if (own) await get().openThread(own.id);
    else get().go({ kind: "draft", captainId: c.id });
  },

  async send(text) {
    const s = get();
    const v = s.view;
    const body = text.trim();
    if (!body || !s.workspaceId) return;
    let threadId: string;
    try {
      if (v.kind === "thread") threadId = v.id;
      else if (v.kind === "draft") {
        const captain = v.captainId ? (s.captains[s.workspaceId] ?? []).find((c) => c.id === v.captainId) : null;
        const first = captain && !(s.threads[s.workspaceId] ?? []).some((t) => t.captain_id === captain.id);
        const ws = s.workspaces.find((w) => w.id === s.workspaceId);
        const t = await rpc<Thread>("create_thread", {
          thread: {
            workspace_id: s.workspaceId,
            captain_id: captain?.id ?? null,
            title: first ? captain!.name : null,
            harness: captain?.harness ?? s.prefs.harness,
            model: captain?.model ?? s.prefs.model,
            effort: captain?.effort ?? s.prefs.effort,
            approval: captain?.approval ?? s.prefs.approval,
            isolate: first || !ws?.root ? false : s.prefs.isolate,
          },
        });
        set((st) => {
          const list = st.threads[t.workspace_id] ?? [];
          return {
            threads: { ...st.threads, [t.workspace_id]: list.some((x) => x.id === t.id) ? list : [t, ...list] },
            events: { ...st.events, [t.id]: [] },
            drafts: { ...st.drafts, [draftKey(v)]: "" },
          };
        });
        await get().openThread(t.id);
        threadId = t.id;
      } else return;
      set((st) => ({ drafts: { ...st.drafts, [threadId]: "" } }));
      await rpc("send_message", { thread_id: threadId, text: body });
    } catch (e) {
      get().notify(String(e));
    }
  },

  async stop(threadId) {
    await rpc("stop_thread", { thread_id: threadId });
  },

  setDraft(key, text) {
    set((s) => ({ drafts: { ...s.drafts, [key]: text } }));
  },
  setPrefs(p) {
    set((s) => ({ prefs: { ...s.prefs, ...p } }));
  },
  setPanel(p) {
    set((s) => ({ panel: { ...s.panel, ...p } }));
  },
  openArtifact(a) {
    set((s) => ({ panel: { ...s.panel, open: true, tab: "preview", artifact: a } }));
  },

  async createWorkspace(name, root) {
    const w = await rpc<Workspace>("create_workspace", { name, root }, null);
    set((s) => ({ workspaces: [...s.workspaces, w], threads: { ...s.threads, [w.id]: [] }, captains: { ...s.captains, [w.id]: [] }, dialog: null }));
    await get().selectWorkspace(w.id);
  },

  async createCaptain(name, instructions) {
    const s = get();
    if (!s.workspaceId) return;
    const c = await rpc<Captain>("create_captain", {
      captain: { workspace_id: s.workspaceId, name, instructions, harness: s.prefs.harness, model: s.prefs.model, effort: s.prefs.effort, approval: s.prefs.approval },
    });
    set((st) => ({ captains: { ...st.captains, [c.workspace_id]: [...(st.captains[c.workspace_id] ?? []), c] }, dialog: null }));
    get().go({ kind: "draft", captainId: c.id });
  },

  setUserName(n) {
    ls.set("bouvio.name", n);
    setActor(n);
    set({ userName: n });
  },
  setTheme(t) {
    ls.set("bouvio.theme", t);
    applyTheme(t);
    set({ theme: t });
  },
  setDialog(d, arg = null) {
    set({ dialog: d, dialogArg: arg });
  },
  setPalette(open) {
    set({ palette: open });
  },
  notify(msg) {
    set({ toast: msg.replace(/^Error: /, "") });
    window.setTimeout(() => get().toast === msg.replace(/^Error: /, "") && set({ toast: null }), 5000);
  },

  async load(key, force = false) {
    const ws = get().workspaceId;
    if (!ws) return;
    if (!force && get().data[ws]?.[key] !== undefined) return;
    const w = { workspace_id: ws };
    try {
      let value: unknown;
      if (key === "issues") value = await rpc("list_issues", w);
      else if (key === "prs") value = await rpc("list_pull_requests", w);
      else if (key === "automations") value = await rpc("list_automations", w);
      else if (key === "artifacts") value = await rpc("list_artifacts", w);
      else if (key === "boards") value = await rpc("list_boards", w);
      else if (key === "settings") value = await rpc("workspace_settings", w);
      else if (key === "members") value = await backend.hub.request("GET", `/workspaces/${ws}/members`);
      else if (key === "chat") value = { general: (await backend.hub.request<ChatMessage[]>("GET", `/workspaces/${ws}/chat?channel=general&limit=100`)) ?? [] };
      else return;
      get().patch(ws, { [key]: value } as Partial<WsData>);
    } catch (e) {
      get().patch(ws, { [key]: key === "chat" ? {} : key === "settings" ? undefined : [] } as Partial<WsData>);
      if (key !== "members" && key !== "chat") get().notify(String(e));
    }
  },

  patch(ws, p) {
    set((s) => ({ data: { ...s.data, [ws]: { ...s.data[ws], ...p } } }));
  },

  async refreshProviders() {
    const [providers, models] = await Promise.all([backend.providers().catch(() => []), backend.listModels().catch(() => [])]);
    set({ providers, models });
  },

  async refreshHub() {
    const hub = await backend.hub.status().catch(() => get().hub);
    const workspaces = await backend.rpc<Workspace[]>(null, "list_workspaces");
    set({ hub, workspaces });
  },
}));

/** Boards subscribe to live document changes from other people. */
export const boardListeners = new Set<(ws: string, kind: string, payload: any) => void>();

export function useWorkspaceThreads() {
  return useStore((s) => (s.workspaceId ? s.threads[s.workspaceId] : undefined)) ?? EMPTY_T;
}
export function useWorkspaceCaptains() {
  return useStore((s) => (s.workspaceId ? s.captains[s.workspaceId] : undefined)) ?? EMPTY_C;
}
export function useWsData() {
  return useStore((s) => (s.workspaceId ? s.data[s.workspaceId] : undefined)) ?? EMPTY_D;
}
export function useWorkspace() {
  return useStore((s) => s.workspaces.find((w) => w.id === s.workspaceId));
}
const EMPTY_T: Thread[] = [];
const EMPTY_C: Captain[] = [];
const EMPTY_D: WsData = {};
