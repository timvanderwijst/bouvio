import { create } from "zustand";
import { backend } from "../../backend";
import { t } from "../../i18n";
import type { LocalConfig } from "../../protocol/LocalConfig";
import type { LocalProgress } from "../../protocol/LocalProgress";
import type { LocalRecommended } from "../../protocol/LocalRecommended";
import type { LocalStatus } from "../../protocol/LocalStatus";
import { useStore } from "../../store";

export const progressKey = (kind: string, name: string) => `${kind}:${name}`;

interface LocalState {
  status: LocalStatus | null;
  config: LocalConfig | null;
  recommended: LocalRecommended[];
  checking: boolean;
  /** Pulls and downloads in flight, by `kind:name`. */
  progress: Record<string, LocalProgress>;
  load(): Promise<void>;
  refresh(): Promise<void>;
  saveConfig(patch: Partial<LocalConfig>): Promise<void>;
  pull(model: string): Promise<void>;
  download(kind: "whisper" | "piper", name: string): Promise<void>;
}

const notify = (msg: string) => useStore.getState().notify(msg);

let listening = false;
function listen() {
  if (listening) return;
  listening = true;
  backend.on<LocalProgress>("local-progress", (p) => {
    const key = progressKey(p.kind, p.name);
    if (!p.done) {
      useLocal.setState((s) => ({ progress: { ...s.progress, [key]: p } }));
      return;
    }
    useLocal.setState((s) => {
      const { [key]: _, ...rest } = s.progress;
      return { progress: rest };
    });
    notify(p.error ? t("local.failed", { name: p.name, error: p.error }) : t("local.done", { name: p.name }));
    void useLocal.getState().refresh();
    void useStore.getState().refreshProviders();
  });
}

export const useLocal = create<LocalState>((set, get) => ({
  status: null,
  config: null,
  recommended: [],
  checking: false,
  progress: {},

  async load() {
    listen();
    const [config, recommended] = await Promise.all([
      backend.app<LocalConfig>("local_config_get").catch(() => null),
      backend.app<LocalRecommended[]>("local_recommended").catch(() => []),
    ]);
    set({ config, recommended });
    await get().refresh();
  },

  async refresh() {
    set({ checking: true });
    try {
      set({ status: await backend.app<LocalStatus>("local_status") });
    } catch {
      set({ status: null });
    } finally {
      set({ checking: false });
    }
  },

  async saveConfig(patch) {
    const current = get().config;
    if (!current) return;
    const next = { ...current, ...patch };
    set({ config: next });
    try {
      set({ config: await backend.app<LocalConfig>("local_config_set", { config: next }) });
      void get().refresh();
      void useStore.getState().refreshProviders();
    } catch (e) {
      set({ config: current });
      notify(String(e));
    }
  },

  async pull(model) {
    listen();
    const key = progressKey("ollama", model);
    set((s) => ({ progress: { ...s.progress, [key]: starting("ollama", model) } }));
    try {
      await backend.app("local_pull", { model });
    } catch (e) {
      drop(key);
      notify(String(e));
    }
  },

  async download(kind, name) {
    listen();
    const key = progressKey(kind, name);
    set((s) => ({ progress: { ...s.progress, [key]: starting(kind, name) } }));
    try {
      await backend.app("local_download", { kind, name });
    } catch (e) {
      drop(key);
      notify(String(e));
    }
  },
}));

function starting(kind: string, name: string): LocalProgress {
  return { kind, name, status: "starting", completed: null, total: null, done: false, error: null };
}

function drop(key: string) {
  useLocal.setState((s) => {
    const { [key]: _, ...rest } = s.progress;
    return { progress: rest };
  });
}

export function bytes(n: number | null | undefined): string {
  if (n == null) return "";
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  return `${Math.max(1, Math.round(n / 1e3))} KB`;
}

export const megabytes = (mb: number) => bytes(mb * 1e6);
