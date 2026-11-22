import { Download, ImagePlus, LayoutDashboard, Plus, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { backend } from "../backend";
import { useT } from "../i18n";
import type { Artifact } from "../protocol/Artifact";
import { rpc, useStore, useWsData } from "../store";
import { ago } from "../lib/format";
import { Markdown } from "./Markdown";
import { Empty } from "./Panel";
import { Menu } from "./Menu";
import { artifactIcon } from "./ThreadExtras";

interface Preview {
  mime: string;
  text?: string;
  data_url?: string;
  path?: string;
}

const previews = new Map<string, Promise<Preview>>();
function loadPreview(a: Artifact) {
  const key = `${a.id}:${a.size}`;
  if (!previews.has(key)) previews.set(key, rpc<Preview>("read_artifact", { id: a.id }, a.workspace_id));
  return previews.get(key)!;
}

function usePreview(a: Artifact) {
  const [p, setP] = useState<Preview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    loadPreview(a)
      .then((x) => live && setP(x))
      .catch((e) => live && setErr(String(e)));
    return () => {
      live = false;
    };
  }, [a]);
  return { p, err };
}

/** Full view of one artifact, in the panel or the studio. */
export function ArtifactPreview({ artifact }: { artifact: Artifact }) {
  const { p, err } = usePreview(artifact);
  if (err) return <Empty text={err} />;
  if (!p) return <div className="preview-loading shimmer" />;
  const src = p.data_url ?? (p.mime === "image/svg+xml" && p.text ? `data:image/svg+xml;utf8,${encodeURIComponent(p.text)}` : undefined);
  return (
    <div className="preview">
      <div className="preview-head">
        <span className="truncate preview-title">{artifact.title}</span>
        {artifact.prompt && <span className="preview-prompt truncate">{artifact.prompt}</span>}
        {src && (
          <a className="icon-btn" href={src} download={artifact.title} title="Download">
            <Download size={14} />
          </a>
        )}
      </div>
      <div className={`preview-body kind-${artifact.kind}`}>
        {(artifact.kind === "image" || artifact.kind === "svg") && src && <img src={src} alt={artifact.prompt ?? artifact.title} />}
        {artifact.kind === "video" && src && <video src={src} controls />}
        {artifact.kind === "audio" && src && <audio src={src} controls />}
        {artifact.kind === "pdf" && src && <iframe title={artifact.title} src={src} />}
        {/* Agent-made HTML runs sandboxed: scripts yes, same-origin and top navigation no. */}
        {artifact.kind === "html" && p.text !== undefined && <iframe title={artifact.title} sandbox="allow-scripts allow-forms" srcDoc={p.text} />}
        {artifact.kind === "markdown" && p.text !== undefined && (
          <div className="preview-doc">
            <Markdown text={p.text} />
          </div>
        )}
        {(artifact.kind === "data" || artifact.kind === "code") && p.text !== undefined && <pre className="preview-code">{p.text}</pre>}
      </div>
    </div>
  );
}

function Tile({ artifact }: { artifact: Artifact }) {
  const openArtifact = useStore((s) => s.openArtifact);
  const go = useStore((s) => s.go);
  const visual = artifact.kind === "image" || artifact.kind === "svg";
  const { p } = usePreview(artifact);
  const src = p?.data_url ?? (p?.mime === "image/svg+xml" && p.text ? `data:image/svg+xml;utf8,${encodeURIComponent(p.text)}` : undefined);
  const Icon = artifactIcon(artifact.kind);
  return (
    <button
      className={`tile ${visual ? "visual" : ""}`}
      onClick={() => {
        openArtifact(artifact);
        if (artifact.thread_id) useStore.getState().openThread(artifact.thread_id);
        else go({ kind: "draft", leadId: null });
      }}
    >
      <span className="tile-media">
        {visual && src ? (
          <img src={src} alt="" loading="lazy" />
        ) : artifact.kind === "html" && p?.text ? (
          <iframe title={artifact.title} sandbox="" srcDoc={p.text} tabIndex={-1} />
        ) : (
          <Icon size={22} strokeWidth={1.5} />
        )}
      </span>
      <span className="tile-text">
        <span className="truncate tile-title">{artifact.prompt ?? artifact.title}</span>
        <span className="tile-meta">{ago(artifact.created_at)}</span>
      </span>
    </button>
  );
}

const GEN_MODELS: Record<"image" | "video" | "speech", { id: string; label: string; provider: string }[]> = {
  image: [
    { id: "fal:fal-ai/flux/schnell", label: "FLUX schnell", provider: "fal" },
    { id: "fal:fal-ai/flux-pro/v1.1", label: "FLUX 1.1 pro", provider: "fal" },
    { id: "openai:gpt-image-1", label: "GPT Image", provider: "open_ai" },
    { id: "replicate:black-forest-labs/flux-schnell", label: "FLUX schnell (Replicate)", provider: "replicate" },
    { id: "comfyui:default", label: "ComfyUI on this computer", provider: "local" },
  ],
  video: [
    { id: "fal:fal-ai/kling-video/v2.1/standard/text-to-video", label: "Kling 2.1", provider: "fal" },
    { id: "replicate:minimax/video-01", label: "MiniMax Video", provider: "replicate" },
  ],
  speech: [
    { id: "openai:gpt-4o-mini-tts", label: "OpenAI TTS", provider: "open_ai" },
    { id: "elevenlabs:21m00Tcm4TlvDq8ikWAM", label: "ElevenLabs · Rachel", provider: "eleven_labs" },
    { id: "local:piper/en_US-lessac-medium", label: "Piper · English", provider: "local" },
    { id: "local:piper/nl_NL-mls-medium", label: "Piper · Nederlands", provider: "local" },
  ],
};

function Generate() {
  const t = useT();
  const providers = useStore((s) => s.providers);
  const notify = useStore((s) => s.notify);
  const patch = useStore((s) => s.patch);
  const data = useWsData();
  const [kind, setKind] = useState<"image" | "video" | "speech">("image");
  const keyed = new Set(providers.filter((p) => p.configured).map((p) => p.kind as string));
  const options = GEN_MODELS[kind];
  const [model, setModel] = useState(options[0].id);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => setModel((GEN_MODELS[kind].find((m) => keyed.has(m.provider)) ?? GEN_MODELS[kind][0]).id), [kind, providers]); // eslint-disable-line
  const ok = keyed.has(options.find((m) => m.id === model)?.provider ?? "");

  return (
    <form
      className="generate"
      onSubmit={async (e) => {
        e.preventDefault();
        const ws = useStore.getState().workspaceId;
        if (!prompt.trim() || !ws) return;
        setBusy(true);
        try {
          const a = await backend.generateMedia({ workspaceId: ws, kind, model, prompt });
          patch(ws, { artifacts: [a, ...(data.artifacts ?? []).filter((x) => x.id !== a.id)] });
          setPrompt("");
        } catch (err) {
          notify(String(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="choice small">
        {(["image", "video", "speech"] as const).map((k) => (
          <button type="button" key={k} className={kind === k ? "on" : ""} onClick={() => setKind(k)}>
            {t(`studio.${k}`)}
          </button>
        ))}
      </div>
      <textarea className="generate-input" value={prompt} placeholder={t(`studio.prompt.${kind}`)} rows={2} onChange={(e) => setPrompt(e.target.value)} />
      <div className="generate-bar">
        <Menu value={model} items={options.map((m) => ({ value: m.id, label: m.label, hint: keyed.has(m.provider) ? undefined : t("composer.needsKey"), disabled: !keyed.has(m.provider) }))} onChange={setModel} />
        <div className="composer-spacer" />
        <button className={`btn primary ${busy ? "is-busy" : ""}`} disabled={busy || !prompt.trim() || !ok}>
          <Sparkles size={14} />
          {busy ? t("studio.generating") : t("studio.generate")}
        </button>
      </div>
    </form>
  );
}

export function StudioPage({ sub }: { sub?: string }) {
  const t = useT();
  const load = useStore((s) => s.load);
  const go = useStore((s) => s.go);
  const notify = useStore((s) => s.notify);
  const data = useWsData();
  const tab = sub === "boards" ? "boards" : "library";
  const [kind, setKind] = useState<string>("all");
  useEffect(() => {
    load("artifacts");
    load("boards");
  }, [load]);
  const list = useMemo(() => (data.artifacts ?? []).filter((a) => kind === "all" || (kind === "media" ? ["image", "svg", "video", "audio"].includes(a.kind) : !["image", "svg", "video", "audio"].includes(a.kind))), [data.artifacts, kind]);

  return (
    <div className="page wide studio">
      <div className="page-head">
        <h1 className="page-title">{t("ws.studio")}</h1>
        <div className="choice small">
          <button className={tab === "library" ? "on" : ""} onClick={() => go({ kind: "page", page: "studio" })}>
            <ImagePlus size={13} />
            {t("studio.library")}
          </button>
          <button className={tab === "boards" ? "on" : ""} onClick={() => go({ kind: "page", page: "studio", sub: "boards" })}>
            <LayoutDashboard size={13} />
            {t("studio.boards")}
          </button>
        </div>
      </div>
      {tab === "library" ? (
        <>
          <Generate />
          <div className="studio-filter">
            {(["all", "media", "documents"] as const).map((k) => (
              <button key={k} className={`chip-btn ${kind === k ? "on" : ""}`} onClick={() => setKind(k)}>
                {t(`studio.filter.${k}`)}
              </button>
            ))}
          </div>
          {data.artifacts && list.length === 0 && <Empty text={t("studio.none")} />}
          <div className="tiles">
            {list.map((a) => (
              <Tile key={a.id} artifact={a} />
            ))}
          </div>
        </>
      ) : (
        <div className="boards">
          <button
            className="board-card new"
            onClick={async () => {
              try {
                const b = await rpc<{ id: string }>("create_board", { workspace_id: useStore.getState().workspaceId, name: t("studio.untitled") });
                load("boards", true);
                go({ kind: "board", id: b.id });
              } catch (e) {
                notify(String(e));
              }
            }}
          >
            <Plus size={18} />
            <span>{t("studio.newBoard")}</span>
          </button>
          {(data.boards ?? []).map((b) => (
            <button key={b.id} className="board-card" onClick={() => go({ kind: "board", id: b.id })}>
              <span className="board-thumb" />
              <span className="board-name">{b.name}</span>
              <span className="tile-meta">{ago(b.updated_at)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
