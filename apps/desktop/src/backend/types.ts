import type { Artifact } from "../protocol/Artifact";
import type { ClientMsg } from "../protocol/ClientMsg";
import type { HubStatus } from "../protocol/HubStatus";
import type { HubUser } from "../protocol/HubUser";
import type { ModelInfo } from "../protocol/ModelInfo";
import type { ProviderInfo } from "../protocol/ProviderInfo";
import type { ProviderKind } from "../protocol/ProviderKind";
import type { Workspace } from "../protocol/Workspace";

export type Unlisten = () => void;

/** Events the runner and the hub send to the window. */
export type EventName =
  | "thread-event"
  | "thread-changed"
  | "workspace-notice"
  | "terminal-chunk"
  | "terminal-exit"
  | "hub-chat"
  | "hub-presence"
  | "hub-host"
  | "hub-status";

/** Everything the UI needs from the app. Tauri in the app, a mock in the browser. */
export interface Backend {
  /** False in the browser preview, where sample data stands in for a runner. */
  readonly live: boolean;

  /** Any runner method; through the hub when someone else hosts the workspace. */
  rpc<T = unknown>(workspaceId: string | null, method: string, params?: Record<string, unknown>): Promise<T>;
  on<T = unknown>(event: EventName, cb: (payload: T) => void): Unlisten;

  pickFolder(): Promise<string | null>;
  openUrl(url: string): Promise<void>;

  providers(): Promise<ProviderInfo[]>;
  setKey(provider: ProviderKind, key: string | null): Promise<void>;
  listModels(): Promise<ModelInfo[]>;
  generateMedia(p: { workspaceId: string; threadId?: string | null; kind: "image" | "video" | "speech"; model: string; prompt: string }): Promise<Artifact>;
  transcribe(audioBase64: string, mime: string): Promise<string>;

  hub: {
    status(): Promise<HubStatus>;
    setUrl(url: string): Promise<void>;
    request<T = unknown>(method: string, path: string, body?: unknown): Promise<T>;
    signIn(path: string, body: unknown): Promise<HubUser>;
    logout(): Promise<void>;
    refresh(): Promise<Workspace[]>;
    share(workspaceId: string): Promise<Workspace>;
    join(code: string): Promise<Workspace[]>;
    send(msg: ClientMsg): Promise<void>;
  };
}
