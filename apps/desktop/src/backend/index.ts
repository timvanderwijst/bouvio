import { mockBackend } from "./mock";
import { tauriBackend } from "./tauri";
import type { Backend } from "./types";

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const backend: Backend = inTauri ? tauriBackend : mockBackend;
export { setActor } from "./tauri";
export type { Backend, EventName } from "./types";
