// Browser-preview stand-ins for this area's runner methods (`handlers`) and
// desktop-only app methods (`app`). See ../mock-bus.ts to fire live events.
import type { LocalConfig } from "../../protocol/LocalConfig";
import type { LocalModel } from "../../protocol/LocalModel";
import type { LocalRecommended } from "../../protocol/LocalRecommended";
import type { LocalStatus } from "../../protocol/LocalStatus";
import { mockFire } from "../mock-bus";

let config: LocalConfig = {
  chat_server: "auto",
  ollama_url: "http://127.0.0.1:11434",
  lmstudio_url: "http://127.0.0.1:1234",
  custom_url: "",
  comfyui_url: "http://127.0.0.1:8188",
  whisper_bin: "",
  piper_bin: "",
  default_model: "",
  whisper_size: "base",
  piper_voice: "en_US-lessac-medium",
  embed_model: "nomic-embed-text",
};

const ollamaModels: LocalModel[] = [
  { name: "qwen3:8b", id: "local:qwen3:8b", size: 5_225_388_164, detail: "8.2B Q4_K_M", embedding: false },
  { name: "llama3.2:latest", id: "local:llama3.2:latest", size: 2_019_393_189, detail: "3.2B Q4_K_M", embedding: false },
  { name: "nomic-embed-text:latest", id: "local:nomic-embed-text:latest", size: 274_302_450, detail: "137M F16", embedding: true },
];
const whisperModels: LocalModel[] = [{ name: "base", id: "local:whisper-base", size: 147_951_465, detail: null, embedding: false }];
const piperVoices: LocalModel[] = [];

const recommended: LocalRecommended[] = [
  { name: "qwen3:8b", label: "Qwen3 8B", use: "chat", size_mb: 5200, ram_gb: 10, tools: true },
  { name: "qwen3:4b", label: "Qwen3 4B", use: "chat", size_mb: 2600, ram_gb: 6, tools: true },
  { name: "llama3.2:3b", label: "Llama 3.2 3B", use: "chat", size_mb: 2000, ram_gb: 4, tools: true },
  { name: "qwen2.5-coder:7b", label: "Qwen2.5 Coder 7B", use: "code", size_mb: 4700, ram_gb: 8, tools: true },
  { name: "gpt-oss:20b", label: "gpt-oss 20B", use: "chat", size_mb: 14000, ram_gb: 16, tools: true },
  { name: "gemma3:4b", label: "Gemma 3 4B", use: "chat", size_mb: 3300, ram_gb: 6, tools: false },
  { name: "nomic-embed-text", label: "Nomic Embed", use: "embed", size_mb: 274, ram_gb: 1, tools: false },
  { name: "base", label: "Whisper base", use: "whisper", size_mb: 142, ram_gb: 1, tools: false },
  { name: "small", label: "Whisper small", use: "whisper", size_mb: 466, ram_gb: 2, tools: false },
  { name: "en_US-lessac-medium", label: "Lessac (English)", use: "piper", size_mb: 63, ram_gb: null, tools: false },
  { name: "nl_NL-mls-medium", label: "MLS (Nederlands)", use: "piper", size_mb: 63, ram_gb: null, tools: false },
];

function status(): LocalStatus {
  return {
    models_dir: "~/.bouvio/local",
    engines: [
      { kind: "ollama", ready: true, version: "0.12.6", location: config.ollama_url, models: ollamaModels, error: null },
      { kind: "lm_studio", ready: false, version: null, location: config.lmstudio_url, models: [], error: null },
      { kind: "whisper", ready: true, version: "1.8.2", location: "/opt/homebrew/bin/whisper-cli", models: whisperModels, error: null },
      { kind: "piper", ready: false, version: null, location: null, models: piperVoices, error: null },
      { kind: "comfyui", ready: false, version: null, location: config.comfyui_url, models: [], error: null },
    ],
  };
}

/** Fake a download: a few progress events, then done, then the model shows up. */
function simulate(kind: string, name: string, totalMb: number, done: () => void) {
  const total = Math.round(totalMb * 1e6);
  let completed = 0;
  const step = () => {
    completed = Math.min(total, completed + total / 12);
    const finished = completed >= total;
    if (finished) done();
    mockFire("local-progress", {
      kind,
      name,
      status: finished ? "success" : kind === "ollama" ? "pulling 970aa74c0a90" : "downloading",
      completed: finished ? null : Math.round(completed),
      total: finished ? null : total,
      done: finished,
      error: null,
    });
    if (!finished) setTimeout(step, 280);
  };
  setTimeout(step, 300);
}

const sizeOf = (name: string, fallback: number) => recommended.find((r) => r.name === name)?.size_mb ?? fallback;

export const handlers: Record<string, (p: Record<string, any>) => unknown> = {};

export const app: Record<string, (p: Record<string, any>) => unknown> = {
  local_status: async () => {
    await new Promise((r) => setTimeout(r, 250));
    return status();
  },
  local_config_get: () => config,
  local_config_set: ({ config: next }) => {
    config = { ...config, ...next };
    return config;
  },
  local_recommended: () => recommended,
  local_pull: ({ model }) => {
    const name = String(model).replace(/^local:/, "");
    const mb = sizeOf(name, 1800);
    simulate("ollama", name, mb, () =>
      ollamaModels.push({ name, id: `local:${name}`, size: mb * 1e6, detail: null, embedding: name.includes("embed") }),
    );
    return { started: true };
  },
  local_download: ({ kind, name }) => {
    const mb = sizeOf(name, 63);
    simulate(kind, name, mb, () => {
      if (kind === "whisper") whisperModels.push({ name, id: `local:whisper-${name}`, size: mb * 1e6, detail: null, embedding: false });
      else piperVoices.push({ name, id: `local:piper/${name}`, size: mb * 1e6, detail: null, embedding: false });
    });
    return { started: true };
  },
};
