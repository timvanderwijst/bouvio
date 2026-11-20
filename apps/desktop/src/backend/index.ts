import { mockBackend } from "./mock";
import { tauriBackend } from "./tauri";
import type { Backend } from "./types";
import { webBackend } from "./web";

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Which app this is: the desktop (Tauri), the web client the hub serves, or the browser preview. */
export const target: "desktop" | "web" | "preview" = inTauri ? "desktop" : import.meta.env.VITE_TARGET === "web" ? "web" : "preview";

export const backend: Backend = target === "desktop" ? tauriBackend : target === "web" ? webBackend : mockBackend;
export { setActor } from "./tauri";
export type { Backend, EventName } from "./types";
