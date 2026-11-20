import { ChevronRight, Download, ExternalLink, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { backend } from "../../backend";
import { useT } from "../../i18n";
import type { LocalChatServer } from "../../protocol/LocalChatServer";
import type { LocalConfig } from "../../protocol/LocalConfig";
import type { LocalEngine } from "../../protocol/LocalEngine";
import type { LocalEngineKind } from "../../protocol/LocalEngineKind";
import type { LocalModelUse } from "../../protocol/LocalModelUse";
import type { LocalProgress } from "../../protocol/LocalProgress";
import type { LocalRecommended } from "../../protocol/LocalRecommended";
import { useStore } from "../../store";
import { Menu, type MenuItem } from "../Menu";
import { bytes, megabytes, progressKey, useLocal } from "./state";
import "./local.css";

import { SECTION_ID } from "./open";

const LINKS: Record<LocalEngineKind, string | null> = {
  ollama: "https://ollama.com/download",
  lm_studio: "https://lmstudio.ai",
  custom: null,
  whisper: "https://github.com/ggml-org/whisper.cpp",
  piper: "https://github.com/OHF-Voice/piper1-gpl",
  comfyui: "https://www.comfy.org/download",
};

const isMac = /Mac/i.test(navigator.userAgent);
const isLinux = /Linux/i.test(navigator.userAgent) && !/Android/i.test(navigator.userAgent);

/** One shell line that installs it, where there is a common one. */
function installLine(kind: LocalEngineKind): string | null {
  if (kind === "ollama" && isLinux) return "curl -fsSL https://ollama.com/install.sh | sh";
  if (kind === "ollama" && isMac) return "brew install ollama";
  if (kind === "whisper" && isMac) return "brew install whisper-cpp";
  if (kind === "piper") return "pipx install piper-tts";
  return null;
}

const WHISPER_SIZES = ["tiny", "base", "small", "medium"];
const SERVERS: LocalChatServer[] = ["auto", "ollama", "lm_studio", "custom"];

export function LocalSettings() {
  const t = useT();
  const { status, config, recommended, checking, load, refresh } = useLocal();
  useEffect(() => {
    void load();
  }, [load]);

  const engines = status?.engines ?? [];
  const find = (k: LocalEngineKind) => engines.find((e) => e.kind === k);
  const order: LocalEngineKind[] = ["ollama", "lm_studio", "custom", "whisper", "piper", "comfyui"];

  return (
    <section className="set-group local" id={SECTION_ID}>
      <div className="local-title">
        <h2>{t("local.title")}</h2>
        <button className={`icon-btn ${checking ? "spin" : ""}`} onClick={() => void refresh()} title={t("local.refresh")} aria-label={t("local.refresh")}>
          <RefreshCw size={13} />
        </button>
      </div>
      <p className="local-note">{t("local.note")}</p>

      {!status
        ? order
            .filter((k) => k !== "custom")
            .map((k) => (
              <div className="local-engine" key={k}>
                <EngineHead kind={k} engine={undefined} checking />
              </div>
            ))
        : order.map((k) => {
            const e = find(k);
            if (!e) return null;
            return <EngineBlock key={k} engine={e} recommended={recommended} />;
          })}

      {config && <Defaults config={config} />}
      {status && <p className="local-note small">{t("local.modelsDir", { dir: status.models_dir })}</p>}
    </section>
  );
}

function stateLabel(e: LocalEngine | undefined, t: ReturnType<typeof useT>, checking: boolean) {
  if (!e) return { text: checking ? t("local.state.checking") : t("local.state.notFound"), ok: false };
  const server = e.kind === "ollama" || e.kind === "lm_studio" || e.kind === "custom" || e.kind === "comfyui";
  if (e.ready) {
    const word = server ? t("local.state.running") : t("local.state.installed");
    return { text: e.version ? `${word} · ${e.version}` : word, ok: true };
  }
  if (e.kind === "ollama" && e.error) return { text: t("local.state.notRunning"), ok: false };
  return { text: server ? t("local.state.notRunning") : t("local.state.notFound"), ok: false };
}

function EngineHead({ kind, engine, checking = false }: { kind: LocalEngineKind; engine: LocalEngine | undefined; checking?: boolean }) {
  const t = useT();
  const st = stateLabel(engine, t, checking);
  const link = LINKS[kind];
  return (
    <div className="local-engine-head">
      <span className={`local-dot ${st.ok ? "ok" : ""}`} />
      <span className="local-engine-name">{t(`local.engine.${kind}`)}</span>
      <span className="local-engine-role">{t(`local.role.${kind}`)}</span>
      <span className={`set-state ${st.ok ? "ok" : "off"}`}>{st.text}</span>
      {engine && !engine.ready && link && (
        <button className="btn small ghost" onClick={() => void backend.openUrl(link)}>
          {t("local.get")}
          <ExternalLink size={12} />
        </button>
      )}
    </div>
  );
}

function EngineBlock({ engine, recommended }: { engine: LocalEngine; recommended: LocalRecommended[] }) {
  const t = useT();
  const { kind } = engine;
  const line = installLine(kind);
  const hint =
    kind === "ollama" && engine.error && !engine.ready ? t("local.hint.ollamaStopped") : kind === "custom" ? null : t(`local.hint.${kind}`);
  const installed = new Set(engine.models.map((m) => m.name.replace(/:latest$/, "")));
  const suggestUse: Partial<Record<LocalEngineKind, LocalModelUse[]>> = {
    ollama: ["chat", "code", "embed"],
    whisper: ["whisper"],
    piper: ["piper"],
  };
  const uses = suggestUse[kind];
  const suggestions = uses ? recommended.filter((r) => uses.includes(r.use) && !installed.has(r.name)) : [];
  // Ollama pulls need the server; whisper models and voices download without the binary.
  const canGet = kind !== "ollama" || engine.ready;

  return (
    <div className={`local-engine ${engine.ready ? "ready" : ""}`}>
      <EngineHead kind={kind} engine={engine} />
      {!engine.ready && hint && (
        <div className="local-hint">
          <span>{hint}</span>
          {line && <code className="local-cmd">{line}</code>}
        </div>
      )}
      {engine.ready && engine.location && kind !== "ollama" && kind !== "lm_studio" && kind !== "comfyui" && (
        <div className="local-path mono truncate" title={engine.location}>
          {engine.location}
        </div>
      )}

      {engine.models.length > 0 && (
        <div className="local-models">
          <div className="local-sub">{t("local.installed")}</div>
          {engine.models.map((m) => (
            <div className="local-model" key={m.id}>
              <span className="local-model-name truncate">{m.name}</span>
              {m.embedding && <span className="local-tag">{t("local.embedding")}</span>}
              <span className="local-model-meta truncate">{m.detail ?? ""}</span>
              <span className="local-model-size">{bytes(m.size)}</span>
            </div>
          ))}
        </div>
      )}

      {canGet && suggestions.length > 0 && (
        <div className="local-models">
          <div className="local-sub">{t("local.suggested")}</div>
          {suggestions.map((r) => (
            <Suggestion key={r.name} rec={r} kind={kind} />
          ))}
        </div>
      )}

      {kind === "ollama" && engine.ready && (
        <GetByName kind="ollama" placeholder={t("local.pullName")} browse="https://ollama.com/library" browseLabel={t("local.browseModels")} />
      )}
      {kind === "piper" && (
        <GetByName kind="piper" placeholder={t("local.voiceName")} browse="https://rhasspy.github.io/piper-samples/" browseLabel={t("local.browseVoices")} />
      )}
    </div>
  );
}

function Suggestion({ rec, kind }: { rec: LocalRecommended; kind: LocalEngineKind }) {
  const t = useT();
  const { pull, download, progress } = useLocal();
  const pkind = kind === "ollama" ? "ollama" : kind;
  const p = progress[progressKey(pkind, rec.name)];
  const get = () => (kind === "ollama" ? pull(rec.name) : download(kind as "whisper" | "piper", rec.name));
  const meta = [t(`local.use.${rec.use}`), rec.ram_gb ? t("local.ram", { gb: rec.ram_gb }) : null].filter(Boolean).join(" · ");
  return (
    <div className="local-model">
      <span className="local-model-name truncate">{rec.label}</span>
      {rec.tools && <span className="local-tag accent">{t("local.tools")}</span>}
      <span className="local-model-meta truncate">{meta}</span>
      <span className="local-model-size">{megabytes(rec.size_mb)}</span>
      {p ? (
        <Progress p={p} />
      ) : (
        <button className="btn small" onClick={() => void get()}>
          <Download size={12} />
          {kind === "ollama" ? t("local.pull") : t("local.download")}
        </button>
      )}
    </div>
  );
}

function Progress({ p }: { p: LocalProgress }) {
  const t = useT();
  const pct = p.total && p.completed != null ? Math.min(100, Math.round((p.completed / p.total) * 100)) : null;
  return (
    <span className="local-progress" title={p.status}>
      <span className={`local-bar ${pct == null ? "busy" : ""}`}>
        <span style={{ width: pct == null ? undefined : `${pct}%` }} />
      </span>
      <span className="local-pct">{pct == null ? (p.status === "starting" ? t("local.starting") : "") : `${pct}%`}</span>
    </span>
  );
}

function GetByName({ kind, placeholder, browse, browseLabel }: { kind: "ollama" | "piper"; placeholder: string; browse: string; browseLabel: string }) {
  const t = useT();
  const { pull, download, progress, recommended } = useLocal();
  const [name, setName] = useState("");
  const running = Object.values(progress).filter((p) => p.kind === kind && !recommended.some((r) => r.name === p.name));
  return (
    <>
      {running.map((p) => (
        <div className="local-model" key={p.name}>
          <span className="local-model-name truncate">{p.name}</span>
          <span className="local-model-meta truncate">{p.status === "starting" ? "" : p.status}</span>
          <Progress p={p} />
        </div>
      ))}
      <form
        className="local-get"
        onSubmit={(e) => {
          e.preventDefault();
          const n = name.trim();
          if (!n) return;
          void (kind === "ollama" ? pull(n) : download("piper", n));
          setName("");
        }}
      >
        <input className="input mono" value={name} placeholder={placeholder} onChange={(e) => setName(e.target.value)} spellCheck={false} />
        <button className="btn small" disabled={!name.trim()}>
          {kind === "ollama" ? t("local.pull") : t("local.download")}
        </button>
        <button type="button" className="btn small ghost" onClick={() => void backend.openUrl(browse)}>
          {browseLabel}
          <ExternalLink size={12} />
        </button>
      </form>
    </>
  );
}

// ---- defaults ----------------------------------------------------------------------------------------

function Defaults({ config }: { config: LocalConfig }) {
  const t = useT();
  const save = useLocal((s) => s.saveConfig);
  const status = useLocal((s) => s.status);
  const recommended = useLocal((s) => s.recommended);
  const models = useStore((s) => s.models);
  const [open, setOpen] = useState(false);

  const modelItems = useMemo<MenuItem<string>[]>(() => {
    const items: MenuItem<string>[] = [{ value: "", label: t("local.defaultModel.auto"), hint: t("local.defaultModel.autoHint") }];
    for (const m of models) items.push({ value: m.id, label: m.name, hint: m.provider === "local" ? t("local.title") : m.id.split(":")[0] });
    if (config.default_model && !models.some((m) => m.id === config.default_model)) items.push({ value: config.default_model, label: config.default_model });
    return items;
  }, [models, config.default_model, t]);

  const voiceItems = useMemo<MenuItem<string>[]>(() => {
    const names = new Set<string>([config.piper_voice]);
    status?.engines.find((e) => e.kind === "piper")?.models.forEach((m) => names.add(m.name));
    recommended.filter((r) => r.use === "piper").forEach((r) => names.add(r.name));
    return [...names].map((n) => ({ value: n, label: n }));
  }, [status, recommended, config.piper_voice]);

  const whisper = status?.engines.find((e) => e.kind === "whisper");
  const piper = status?.engines.find((e) => e.kind === "piper");

  return (
    <div className="local-defaults">
      <div className="local-sub">{t("local.defaults")}</div>
      <div className="set-row">
        <span>{t("local.chatServer")}</span>
        <div className="choice small">
          {SERVERS.map((s) => (
            <button key={s} className={config.chat_server === s ? "on" : ""} onClick={() => void save({ chat_server: s })}>
              {t(`local.server.${s}`)}
            </button>
          ))}
        </div>
      </div>
      {config.chat_server === "custom" && (
        <Field label={t("local.customUrl")} value={config.custom_url} placeholder="http://127.0.0.1:8080/v1" onSave={(v) => save({ custom_url: v })} />
      )}
      <div className="set-row">
        <span>{t("local.defaultModel")}</span>
        <Menu value={config.default_model} items={modelItems} onChange={(v) => void save({ default_model: v })} />
      </div>
      <div className="set-row">
        <span>{t("local.whisperSize")}</span>
        <div className="choice small">
          {WHISPER_SIZES.map((s) => (
            <button key={s} className={config.whisper_size === s ? "on" : ""} onClick={() => void save({ whisper_size: s })}>
              {s}
            </button>
          ))}
        </div>
      </div>
      <div className="set-row">
        <span>{t("local.piperVoice")}</span>
        <Menu value={config.piper_voice} items={voiceItems} onChange={(v) => void save({ piper_voice: v })} />
      </div>

      <button className={`local-more ${open ? "open" : ""}`} onClick={() => setOpen(!open)} aria-expanded={open}>
        <ChevronRight size={13} />
        {t("local.advanced")}
      </button>
      {open && (
        <div className="local-advanced">
          <Field label={t("local.ollamaUrl")} value={config.ollama_url} placeholder="http://127.0.0.1:11434" onSave={(v) => save({ ollama_url: v })} />
          <Field label={t("local.lmstudioUrl")} value={config.lmstudio_url} placeholder="http://127.0.0.1:1234" onSave={(v) => save({ lmstudio_url: v })} />
          <Field label={t("local.comfyuiUrl")} value={config.comfyui_url} placeholder="http://127.0.0.1:8188" onSave={(v) => save({ comfyui_url: v })} />
          <Field
            label={t("local.whisperBin")}
            value={config.whisper_bin}
            placeholder={whisper?.ready && whisper.location ? whisper.location : "whisper-cli"}
            onSave={(v) => save({ whisper_bin: v })}
          />
          <Field
            label={t("local.piperBin")}
            value={config.piper_bin}
            placeholder={piper?.ready && piper.location ? piper.location : "piper"}
            onSave={(v) => save({ piper_bin: v })}
          />
        </div>
      )}
    </div>
  );
}

/** A text setting saved when it loses focus or on Enter. */
function Field({ label, value, placeholder, onSave }: { label: ReactNode; value: string; placeholder?: string; onSave: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => draft.trim() !== value && onSave(draft.trim());
  return (
    <label className="set-row">
      <span>{label}</span>
      <input
        className="input mono local-field"
        value={draft}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
      />
    </label>
  );
}
