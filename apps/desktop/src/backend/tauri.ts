import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Backend, Unlisten } from "./types";

/** Subscribe synchronously; the real unlisten arrives later. */
function sub<T>(name: string, cb: (p: T) => void): Unlisten {
  let un: (() => void) | null = null;
  let dead = false;
  listen<T>(name, (e) => cb(e.payload)).then((u) => (dead ? u() : (un = u)));
  return () => {
    dead = true;
    un?.();
  };
}

/** The name agents and people see as the author of what I type. */
let actor = "you";
export function setActor(name: string) {
  actor = name;
}

export const tauriBackend: Backend = {
  live: true,
  rpc: (workspaceId, method, params = {}) => invoke("rpc", { workspaceId, method, params, actor }),
  on: (event, cb) => sub(event, cb),
  pickFolder: () => invoke("pick_folder"),
  openUrl: (url) => openUrl(url),
  providers: () => invoke("providers"),
  setKey: (provider, key) => invoke("set_key", { provider, key }),
  listModels: () => invoke("list_models"),
  generateMedia: (p) => invoke("generate_media", { workspaceId: p.workspaceId, threadId: p.threadId ?? null, kind: p.kind, model: p.model, prompt: p.prompt }),
  transcribe: (audioBase64, mime) => invoke("transcribe", { audioBase64, mime, model: null }),
  hub: {
    status: () => invoke("hub_status"),
    setUrl: (url) => invoke("hub_set_url", { url }),
    request: (method, path, body) => invoke("hub_request", { method, path, body: body ?? null }),
    signIn: (path, body) => invoke("hub_sign_in", { path, body }),
    logout: () => invoke("hub_logout"),
    refresh: () => invoke("hub_refresh"),
    share: (workspaceId) => invoke("hub_share", { workspaceId }),
    join: (code) => invoke("hub_join", { code }),
    send: (msg) => invoke("hub_send", { msg }),
  },
};
