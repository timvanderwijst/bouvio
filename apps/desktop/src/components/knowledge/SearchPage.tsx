import {
  CircleDot,
  CornerDownLeft,
  FileCode2,
  FileInput,
  FileText,
  Globe,
  LoaderCircle,
  MessageSquare,
  Paperclip,
  RefreshCw,
  Search,
  Sheet,
  StickyNote,
  Upload,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { backend } from "../../backend";
import { useT } from "../../i18n";
import type { KnowledgeIndexStatus } from "../../protocol/KnowledgeIndexStatus";
import type { SearchHit } from "../../protocol/SearchHit";
import { rpc, useStore, useWorkspace } from "../../store";
import { Dialog } from "../Dialog";
import { Markdown } from "../Markdown";
import { clipUrl, pickAndImport } from "./imports";
import { groupHits, kindLabel, openHit, snippetParts, useSearch } from "./search";
import "./knowledge.css";

const KIND_ICON: Record<string, LucideIcon> = {
  thread: MessageSquare,
  issue: CircleDot,
  file: FileCode2,
  artifact: FileInput,
  doc: FileText,
  sheet: Sheet,
  note: StickyNote,
};
const FILTERS = ["thread", "issue", "doc", "artifact", "file"];

export function KindIcon({ kind, size = 15 }: { kind: string; size?: number }) {
  const I = KIND_ICON[kind] ?? Paperclip;
  return <I size={size} />;
}

export function Highlighted({ text, ranges }: { text: string; ranges: [number, number][] }) {
  return (
    <>
      {snippetParts(text, ranges).map((p, i) =>
        p.mark ? (
          <mark key={i} className="kn-mark">
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

interface Preview {
  hit: SearchHit;
  mime?: string;
  text?: string;
}

export function SearchPage({ sub }: { sub?: string }) {
  const t = useT();
  const ws = useWorkspace();
  const workspaces = useStore((s) => s.workspaces);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const [active, setActive] = useState(0);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [clip, setClip] = useState(sub === "clip");
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const remote = !!ws?.role;
  const scopeAll = all && !remote;

  const { results, loading, error, query } = useSearch(q, { kinds: kind ? [kind] : undefined, all: scopeAll, limit: 60 });
  const groups = useMemo(() => groupHits(results), [results]);
  const flat = useMemo(() => groups.flatMap((g) => g.hits), [groups]);
  const wsName = (id: string) => workspaces.find((w) => w.id === id)?.name ?? "";

  useEffect(() => {
    input.current?.focus();
  }, []);
  useEffect(() => {
    if (sub === "clip") setClip(true);
  }, [sub]);
  useEffect(() => setActive(0), [results]);
  useEffect(() => {
    list.current?.querySelector(".kn-hit.on")?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const open = async (hit: SearchHit) => {
    if (hit.location.type === "artifact") {
      setPreview({ hit });
      try {
        const p = await rpc<{ mime: string; text?: string }>("read_artifact", { id: hit.location.artifact_id }, hit.workspace_id);
        setPreview((cur) => (cur?.hit === hit ? { hit, mime: p.mime, text: p.text ?? "" } : cur));
      } catch {
        // Not readable here (moved, or another machine): show what the index kept.
        setPreview((cur) => (cur?.hit === hit ? { hit, mime: "text/plain", text: hit.snippet.text } : cur));
      }
      return;
    }
    openHit(hit).catch((e) => useStore.getState().notify(String(e)));
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, flat.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && flat[active]) {
      e.preventDefault();
      open(flat[active]);
    } else if (e.key === "Escape") {
      if (preview) setPreview(null);
      else if (q) setQ("");
      else input.current?.blur();
    }
  };

  const filters = useMemo(() => {
    const extra = results.map((r) => r.kind).filter((k) => !FILTERS.includes(k));
    return [...FILTERS, ...new Set(extra), ...(kind && !FILTERS.includes(kind) && !extra.includes(kind) ? [kind] : [])];
  }, [results, kind]);

  let index = 0;
  return (
    <div className={`kn-search ${preview ? "with-preview" : ""}`}>
      <div className="kn-col">
        <div className="kn-bar">
          <Search size={18} className="kn-bar-icon" />
          <input
            ref={input}
            className="kn-input"
            value={q}
            placeholder={t("knowledge.search.placeholder")}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            spellCheck={false}
            aria-label={t("knowledge.search.title")}
            aria-controls="kn-results"
            aria-activedescendant={flat[active] ? `kn-hit-${active}` : undefined}
          />
          {loading && <LoaderCircle size={15} className="kn-spin" />}
          {q && (
            <button className="icon-btn" onClick={() => (setQ(""), input.current?.focus())} aria-label={t("common.cancel")}>
              <X size={15} />
            </button>
          )}
        </div>

        <div className="kn-filters">
          <button className={`chip-btn ${kind === null ? "on" : ""}`} onClick={() => setKind(null)}>
            {t("knowledge.search.all")}
          </button>
          {filters.map((k) => (
            <button key={k} className={`chip-btn ${kind === k ? "on" : ""}`} onClick={() => setKind(kind === k ? null : k)}>
              {t(kindLabel(k))}
            </button>
          ))}
          {!remote && workspaces.filter((w) => !w.role).length > 1 && (
            <div className="choice small kn-scope">
              <button className={!all ? "on" : ""} onClick={() => setAll(false)}>
                {t("knowledge.search.thisWorkspace")}
              </button>
              <button className={all ? "on" : ""} onClick={() => setAll(true)}>
                {t("knowledge.search.allWorkspaces")}
              </button>
            </div>
          )}
        </div>

        <div className="kn-results" id="kn-results" role="listbox" ref={list}>
          {!q.trim() ? (
            <EmptyState onClip={() => setClip(true)} />
          ) : error ? (
            <div className="kn-empty">
              <p className="kn-empty-text">{error.replace(/^Error: /, "")}</p>
            </div>
          ) : results.length === 0 && !loading && query === q.trim() ? (
            <div className="kn-empty">
              <h2 className="kn-empty-title">{t("knowledge.search.noResults", { query: q.trim() })}</h2>
              <p className="kn-empty-text">{t("knowledge.search.noResultsHint")}</p>
            </div>
          ) : (
            groups.map((g) => (
              <section key={g.kind} className="kn-group">
                <div className="kn-group-head">
                  <span>{t(kindLabel(g.kind))}</span>
                  <span className="group-count">{g.hits.length}</span>
                </div>
                {g.hits.map((h) => {
                  const i = index++;
                  return (
                    <button
                      key={`${h.workspace_id}:${h.kind}:${h.id}`}
                      id={`kn-hit-${i}`}
                      role="option"
                      aria-selected={i === active}
                      className={`kn-hit ${i === active ? "on" : ""}`}
                      onMouseMove={() => i !== active && setActive(i)}
                      onClick={() => open(h)}
                    >
                      <span className="kn-hit-icon">
                        <KindIcon kind={h.kind} />
                      </span>
                      <span className="kn-hit-body">
                        <span className="kn-hit-title">
                          <span className="truncate">{h.title || h.id}</span>
                          {scopeAll && <span className="kn-hit-ws">{wsName(h.workspace_id)}</span>}
                        </span>
                        {h.snippet.text && (
                          <span className="kn-hit-snippet">
                            <Highlighted text={h.snippet.text} ranges={h.snippet.highlights} />
                          </span>
                        )}
                      </span>
                      {i === active && <CornerDownLeft size={13} className="kn-hit-enter" />}
                    </button>
                  );
                })}
              </section>
            ))
          )}
        </div>

        <Footer hasQuery={!!q.trim()} count={results.length} />
      </div>

      {preview && <PreviewPane preview={preview} onClose={() => setPreview(null)} />}
      {clip && <ClipDialog onClose={() => setClip(false)} />}
    </div>
  );
}

function EmptyState({ onClip }: { onClip: () => void }) {
  const t = useT();
  const ws = useWorkspace();
  return (
    <div className="kn-empty start">
      <h2 className="kn-empty-title">{t("knowledge.search.emptyTitle")}</h2>
      <p className="kn-empty-text">{t("knowledge.search.emptyText")}</p>
      <div className="kn-empty-actions">
        <button className="btn" onClick={() => pickAndImport()} disabled={!ws}>
          <Upload size={14} />
          {t("knowledge.import.files")}
        </button>
        <button className="btn" onClick={onClip} disabled={!ws}>
          <Globe size={14} />
          {t("knowledge.import.clip")}
        </button>
      </div>
      <p className="kn-empty-hint">{t("knowledge.import.hint")}</p>
    </div>
  );
}

function Footer({ hasQuery, count }: { hasQuery: boolean; count: number }) {
  const t = useT();
  const ws = useWorkspace();
  const [status, setStatus] = useState<KnowledgeIndexStatus | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!ws) return;
    setStatus(null);
    rpc<KnowledgeIndexStatus>("get_index_status", { workspace_id: ws.id }, ws.id)
      .then(setStatus)
      .catch(() => {});
    return backend.on<{ workspace_id: string; kind: string; payload: KnowledgeIndexStatus }>("workspace-notice", (n) => {
      if (n.workspace_id === ws.id && n.kind === "knowledge-index") setStatus(n.payload);
    });
  }, [ws]);

  const reindex = async () => {
    if (!ws) return;
    setBusy(true);
    try {
      setStatus(await rpc<KnowledgeIndexStatus>("reindex", { workspace_id: ws.id }, ws.id));
      useStore.getState().notify(t("knowledge.search.reindexed"));
    } catch (e) {
      useStore.getState().notify(String(e));
    } finally {
      setBusy(false);
    }
  };

  const kbd = (k: string) => `<${k}>`;
  return (
    <div className="kn-foot">
      {hasQuery ? (
        <span>{t("knowledge.search.results", { count })}</span>
      ) : (
        <span className="kn-keys">
          {t("knowledge.search.keys", { up: kbd("↑"), down: kbd("↓"), enter: kbd("Enter"), esc: kbd("Esc") })
            .split(/(<[^>]+>)/)
            .map((part, i) => (part.startsWith("<") ? <kbd key={i}>{part.slice(1, -1)}</kbd> : <span key={i}>{part}</span>))}
        </span>
      )}
      <span className="kn-foot-right">
        {status && (
          <>
            <span>{t("knowledge.search.indexed", { docs: status.docs })}</span>
            {status.semantic && (
              <>
                <span className="dot-sep" />
                <span>{status.pending > 0 ? t("knowledge.search.embedding", { count: status.pending }) : t("knowledge.search.semantic")}</span>
              </>
            )}
          </>
        )}
        <button className={`icon-btn ${busy ? "spin" : ""}`} onClick={reindex} disabled={busy || !ws} title={t("knowledge.search.reindex")} aria-label={t("knowledge.search.reindex")}>
          <RefreshCw size={13} />
        </button>
      </span>
    </div>
  );
}

function PreviewPane({ preview, onClose }: { preview: Preview; onClose: () => void }) {
  const t = useT();
  const { hit } = preview;
  // Front matter is for machines; show the article.
  const body = preview.text?.replace(/^---\n[\s\S]*?\n---\n+/, "");
  return (
    <aside className="kn-preview" aria-label={hit.title}>
      <div className="kn-preview-head">
        <KindIcon kind={hit.kind} />
        <span className="kn-preview-title truncate">{hit.title}</span>
        <button className="btn small" onClick={() => openHit(hit).catch((e) => useStore.getState().notify(String(e)))}>
          {t("knowledge.search.open")}
        </button>
        <button className="icon-btn" onClick={onClose} aria-label={t("knowledge.search.close")}>
          <X size={15} />
        </button>
      </div>
      <div className="kn-preview-body">
        {body === undefined ? (
          <div className="preview-loading shimmer" />
        ) : preview.mime === "text/markdown" ? (
          <div className="preview-doc">
            <Markdown text={body} />
          </div>
        ) : (
          <pre className="preview-code">{body}</pre>
        )}
      </div>
    </aside>
  );
}

export function ClipDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await clipUrl(url.trim());
      onClose();
    } catch (x) {
      setErr(String(x).replace(/^Error: /, ""));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={t("knowledge.clip.title")} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label className="field">
          <span>{t("knowledge.clip.url")}</span>
          <input className="input" autoFocus type="url" inputMode="url" placeholder="https://" value={url} onChange={(e) => setUrl(e.target.value)} />
          <span className="field-hint">{t("knowledge.clip.hint")}</span>
        </label>
        {err && <p className="form-error">{err}</p>}
        <div className="form-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className={`btn primary ${busy ? "is-busy" : ""}`} disabled={busy || !url.trim()}>
            {busy ? <LoaderCircle size={14} /> : <Globe size={14} />}
            {busy ? t("knowledge.clip.busy") : t("knowledge.clip.go")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
