import { Plus, Search, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import type { PersonalNote } from "../../protocol/PersonalNote";
import type { PersonalNoteMeta } from "../../protocol/PersonalNoteMeta";
import { useStore } from "../../store";
import { ago } from "../../lib/format";
import { Markdown } from "../Markdown";
import { local } from "./taskStore";

/** Two panes: the notes on the left, one note to write or read on the right. */
export function NotesView() {
  const t = useT();
  const notify = useStore((s) => s.notify);
  const [list, setList] = useState<PersonalNoteMeta[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [loaded, setLoaded] = useState<string | null>(null);
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const [q, setQ] = useState("");
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");
  const pending = useRef<{ id: string; text: string } | null>(null);
  const timer = useRef<number>(undefined);

  const flush = useCallback(async () => {
    window.clearTimeout(timer.current);
    const p = pending.current;
    if (!p) return;
    pending.current = null;
    setState("saving");
    try {
      const n = await local<PersonalNote>("save_note", { id: p.id, text: p.text });
      setList((l) => [{ id: n.id, title: n.title, excerpt: excerpt(n.text), updated_at: n.updated_at }, ...(l ?? []).filter((x) => x.id !== n.id)]);
      setState("saved");
    } catch (e) {
      notify(String(e));
      setState("idle");
    }
  }, [notify]);

  useEffect(() => {
    local<PersonalNoteMeta[]>("list_notes")
      .then((l) => {
        setList(l);
        if (l[0]) setSel(l[0].id);
      })
      .catch(() => setList([]));
    return () => void flush();
  }, [flush]);

  useEffect(() => {
    if (!sel) return;
    let live = true;
    local<PersonalNote>("get_note", { id: sel })
      .then((n) => live && (setText(n.text), setLoaded(n.id), setState("idle")))
      .catch((e) => notify(String(e)));
    return () => {
      live = false;
    };
  }, [sel, notify]);

  const pick = async (id: string) => {
    await flush();
    setLoaded(null);
    setSel(id);
  };

  const edit = (v: string) => {
    setText(v);
    if (!sel) return;
    pending.current = { id: sel, text: v };
    setState("idle");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, 600);
  };

  const create = async () => {
    await flush();
    try {
      const n = await local<PersonalNote>("save_note", { id: null, text: "" });
      setList((l) => [{ id: n.id, title: n.title, excerpt: "", updated_at: n.updated_at }, ...(l ?? [])]);
      setSel(n.id);
      setText("");
      setLoaded(n.id);
      setMode("edit");
    } catch (e) {
      notify(String(e));
    }
  };

  const remove = async () => {
    if (!sel) return;
    pending.current = null;
    window.clearTimeout(timer.current);
    await local("delete_note", { id: sel }).catch((e) => notify(String(e)));
    const rest = (list ?? []).filter((x) => x.id !== sel);
    setList(rest);
    setSel(rest[0]?.id ?? null);
    if (!rest.length) setText("");
  };

  const shown = (list ?? []).filter((n) => !q || `${n.title} ${n.excerpt}`.toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="p-notes">
      <aside className="p-notes-list">
        <div className="p-notes-tools">
          <label className="p-search">
            <Search size={13} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("personal.notes.search")} aria-label={t("personal.notes.search")} />
          </label>
          <button type="button" className="icon-btn" onClick={create} title={t("personal.notes.new")} aria-label={t("personal.notes.new")}>
            <Plus size={15} />
          </button>
        </div>
        {list === null && [0, 1, 2].map((i) => <div key={i} className="shimmer p-skel-row" />)}
        {shown.map((n) => (
          <button type="button" key={n.id} className={`p-note-row ${sel === n.id ? "on" : ""}`} onClick={() => pick(n.id)}>
            <span className="p-note-title truncate">{n.title}</span>
            <span className="p-note-meta truncate">
              <span className="when">{ago(n.updated_at)}</span>
              {n.excerpt}
            </span>
          </button>
        ))}
        {list && !shown.length && <div className="empty small">{q ? t("personal.notes.noMatch") : t("personal.notes.none")}</div>}
      </aside>
      <div className="p-note">
        {sel && loaded === sel ? (
          <>
            <div className="p-note-head">
              <div className="choice small">
                {(["edit", "preview"] as const).map((m) => (
                  <button key={m} type="button" className={mode === m ? "on" : ""} onClick={() => setMode(m)}>
                    {t(`personal.notes.${m}`)}
                  </button>
                ))}
              </div>
              <span className="p-save-state">{state === "saving" ? t("personal.notes.saving") : state === "saved" ? t("common.saved") : ""}</span>
              <div className="composer-spacer" />
              <button type="button" className="icon-btn" onClick={remove} title={t("common.delete")} aria-label={t("common.delete")}>
                <Trash2 size={14} />
              </button>
            </div>
            {mode === "edit" ? (
              <textarea className="p-note-text" value={text} onChange={(e) => edit(e.target.value)} onBlur={flush} placeholder={t("personal.notes.hint")} autoFocus={!text} spellCheck />
            ) : (
              <div className="p-note-preview">{text.trim() ? <Markdown text={text} /> : <p className="p-quiet">{t("personal.notes.emptyNote")}</p>}</div>
            )}
          </>
        ) : sel ? (
          <div className="shimmer p-note-skel" />
        ) : (
          <div className="empty">
            <button type="button" className="btn" onClick={create}>
              <Plus size={14} />
              {t("personal.notes.new")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function excerpt(text: string) {
  const line = text.split("\n").map((l) => l.trim()).filter(Boolean)[1] ?? "";
  return line.replace(/^[#\-*> ]+/, "").slice(0, 120);
}
