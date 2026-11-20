import { invoke } from "@tauri-apps/api/core";
import { backend } from "../../backend";
import { t } from "../../i18n";
import type { Artifact } from "../../protocol/Artifact";
import { rpc, useStore } from "../../store";

export const IMPORT_EXTENSIONS = ["pdf", "docx", "xlsx", "xlsm", "xls", "ods", "csv", "tsv", "md", "markdown", "txt", "html", "htm", "json"];

/** The workspace imports go to, or an error message key when there is none or it lives elsewhere. */
function target(): { ws: string } | { error: string } {
  const s = useStore.getState();
  const ws = s.workspaces.find((w) => w.id === s.workspaceId);
  if (!ws) return { error: "knowledge.import.noWorkspace" };
  return { ws: ws.id };
}

/** Whether the runner of the current workspace is on another machine. */
export function isRemote() {
  const s = useStore.getState();
  return !!s.workspaces.find((w) => w.id === s.workspaceId)?.role;
}

const nameOf = (path: string) => path.split(/[\\/]/).pop() || path;

async function run<T>(items: T[], name: (x: T) => string, one: (ws: string, x: T) => Promise<Artifact>) {
  const tg = target();
  const notify = useStore.getState().notify;
  if ("error" in tg) return notify(t(tg.error));
  if (!items.length) return;
  notify(t("knowledge.import.busy", { count: items.length }));
  let done = 0;
  for (const x of items) {
    try {
      await one(tg.ws, x);
      done++;
    } catch (e) {
      notify(t("knowledge.import.failed", { name: name(x), error: String(e).replace(/^Error: /, "") }));
    }
  }
  if (done) {
    notify(t("knowledge.import.done", { count: done }));
    useStore.getState().load("artifacts", true);
  }
}

/** Files on the runner's own disk (the desktop app with a local workspace). */
export function importPaths(paths: string[]) {
  if (isRemote()) return useStore.getState().notify(t("knowledge.import.remote"));
  return run(paths, nameOf, (ws, path) => rpc<Artifact>("import_file", { workspace_id: ws, path }, ws));
}

/** Files the window received (browser drops, file inputs); sent as bytes, so this works through the hub too. */
export function importFiles(files: File[]) {
  return run(files, (f) => f.name, async (ws, f) => rpc<Artifact>("import_bytes", { workspace_id: ws, name: f.name, base64: await toBase64(f) }, ws));
}

function toBase64(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",", 2)[1] ?? "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });
}

/** Ask for files: the native dialog in the app, a file input in the browser. */
export async function pickAndImport() {
  if (backend.live && !isRemote()) {
    const picked = await invoke<string[] | string | null>("plugin:dialog|open", {
      options: { multiple: true, directory: false, filters: [{ name: "Documents", extensions: IMPORT_EXTENSIONS }] },
    }).catch((e) => {
      useStore.getState().notify(String(e));
      return null;
    });
    const paths = picked == null ? [] : Array.isArray(picked) ? picked : [picked];
    return importPaths(paths);
  }
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.accept = IMPORT_EXTENSIONS.map((e) => `.${e}`).join(",");
  input.onchange = () => importFiles([...(input.files ?? [])]);
  input.click();
}

export async function clipUrl(url: string): Promise<Artifact | null> {
  const tg = target();
  const notify = useStore.getState().notify;
  if ("error" in tg) {
    notify(t(tg.error));
    return null;
  }
  const a = await rpc<Artifact>("clip_url", { workspace_id: tg.ws, url }, tg.ws);
  notify(t("knowledge.clip.done", { title: a.title }));
  useStore.getState().load("artifacts", true);
  return a;
}
