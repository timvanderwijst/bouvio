import { ArrowDown, ArrowUp, Check, Copy, Database, Eye, Link2, Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import * as Y from "yjs";
import { t, useT } from "../../i18n";
import type { PublicForm } from "../../protocol/PublicForm";
import { rpc, useStore, useWorkspace } from "../../store";
import { Empty } from "../Panel";
import { PopItem, Popover, docById, openDoc } from "./common";
import { putField } from "./db";
import { fieldList, type Field, type Schema } from "./dbview";
import type { EditorProps } from "./DocPage";
import { FIELD_ICON, useDb } from "./DatabaseEditor";
import { shortId, useSession, useYVersion, type Session } from "./sync";

interface Question {
  field: string;
  label: string;
  required: boolean;
  help: string;
}

export function FormEditor({ doc, session }: EditorProps) {
  const db = useSession(doc.parent_id ?? undefined);
  const t2 = useT();
  if (!doc.parent_id) return <Empty text={t2("office.form.noDb")} />;
  if (!db || !db.ready) return <div className="office-loading" />;
  return <FormBody session={session} db={db} formId={doc.id} dbId={doc.parent_id} title={doc.title} />;
}

function FormBody({ session, db, formId, dbId, title }: { session: Session; db: Session; formId: string; dbId: string; title: string }) {
  const tr = useT();
  const formMap = useMemo(() => session.ydoc.getMap<unknown>("form"), [session]);
  const qArr = useMemo(() => session.ydoc.getArray<Y.Map<unknown>>("questions"), [session]);
  const v1 = useYVersion(formMap);
  const v2 = useYVersion(qArr);
  const questions = useMemo(() => qArr.toArray().map((m) => m.toJSON() as Question), [qArr, v2]);
  const description = useMemo(() => String(formMap.get("description") ?? ""), [formMap, v1]);
  const { schema, rows } = useDb(db.ydoc);
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const used = new Set(questions.map((q) => q.field));
  const free = fieldList(schema).filter((f) => !used.has(f.id) && f.type !== "person");

  const setQ = (i: number, patch: Partial<Question>) => {
    const m = qArr.get(i);
    session.ydoc.transact(() => Object.entries(patch).forEach(([k, v]) => m.set(k, v)));
  };
  const addQ = (f: Field) => {
    const m = new Y.Map<unknown>();
    m.set("field", f.id);
    m.set("label", f.name);
    m.set("required", false);
    m.set("help", "");
    qArr.push([m]);
  };
  const moveQ = (i: number, to: number) => {
    if (to < 0 || to >= questions.length) return;
    const q = questions[i];
    session.ydoc.transact(() => {
      qArr.delete(i, 1);
      const m = new Y.Map<unknown>();
      Object.entries(q).forEach(([k, v]) => m.set(k, v));
      qArr.insert(to, [m]);
    });
  };

  return (
    <div className="office-scroll">
      <div className="form-layout">
        <div className="form-main">
          <div className="form-mode choice small">
            <button className={mode === "edit" ? "on" : ""} onClick={() => setMode("edit")}>
              <Pencil size={12} />
              {tr("office.form.edit")}
            </button>
            <button className={mode === "preview" ? "on" : ""} onClick={() => setMode("preview")}>
              <Eye size={12} />
              {tr("office.form.preview")}
            </button>
          </div>
          {mode === "preview" ? (
            <FormPreview formId={formId} />
          ) : (
            <>
              <h1 className="office-doc-title">{title}</h1>
              <DescriptionInput value={description} onChange={(v) => formMap.set("description", v)} />
              {questions.map((q, i) => {
                const f = schema[q.field];
                const I = f ? FIELD_ICON[f.type] : null;
                return (
                  <div key={`${q.field}-${i}`} className="form-q">
                    <div className="form-q-head">
                      <input className="form-q-label" value={q.label} placeholder={f?.name} onChange={(e) => setQ(i, { label: e.target.value })} />
                      <label className="toggle">
                        <input type="checkbox" checked={q.required} onChange={(e) => setQ(i, { required: e.target.checked })} />
                        {tr("office.form.required")}
                      </label>
                      <button className="icon-btn" onClick={() => moveQ(i, i - 1)} disabled={i === 0} title={tr("office.slides.moveUp")}>
                        <ArrowUp size={14} />
                      </button>
                      <button className="icon-btn" onClick={() => moveQ(i, i + 1)} disabled={i === questions.length - 1} title={tr("office.slides.moveDown")}>
                        <ArrowDown size={14} />
                      </button>
                      <button className="icon-btn" onClick={() => qArr.delete(i, 1)} title={tr("office.delete")}>
                        <Trash2 size={14} />
                      </button>
                    </div>
                    <input className="form-q-help" value={q.help} placeholder={tr("office.form.helpPh")} onChange={(e) => setQ(i, { help: e.target.value })} />
                    <div className="form-q-field">
                      {I && <I size={12} />}
                      {f ? tr("office.form.writesTo", { field: f.name, type: tr(`office.field.${f.type}`) }) : tr("office.form.missingField")}
                    </div>
                  </div>
                );
              })}
              <Popover
                trigger={(_, toggle) => (
                  <button className="btn ghost form-add" onClick={toggle}>
                    <Plus size={14} />
                    {tr("office.form.addQuestion")}
                  </button>
                )}
              >
                {(close) => (
                  <>
                    {free.map((f) => {
                      const I = FIELD_ICON[f.type];
                      return (
                        <PopItem
                          key={f.id}
                          icon={<I size={14} />}
                          label={f.name}
                          hint={tr(`office.field.${f.type}`)}
                          onClick={() => {
                            close();
                            addQ(f);
                          }}
                        />
                      );
                    })}
                    <PopItem
                      icon={<Plus size={14} />}
                      label={tr("office.form.newField")}
                      onClick={() => {
                        close();
                        const name = window.prompt(t("office.form.newFieldName"));
                        if (!name?.trim()) return;
                        const f: Field = { id: shortId(), name: name.trim(), type: "text", order: Math.max(-1, ...Object.values(schema as Schema).map((x) => x.order)) + 1 };
                        putField(db.ydoc, f);
                        addQ(f);
                      }}
                    />
                  </>
                )}
              </Popover>
            </>
          )}
        </div>
        <SharePanel formId={formId} dbId={dbId} responses={rows.length} />
      </div>
    </div>
  );
}

function DescriptionInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const tr = useT();
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return <textarea className="form-desc" rows={2} value={draft} placeholder={tr("office.form.descPh")} onChange={(e) => setDraft(e.target.value)} onBlur={() => draft !== value && onChange(draft)} />;
}

function SharePanel({ formId, dbId, responses }: { formId: string; dbId: string; responses: number }) {
  const tr = useT();
  const ws = useWorkspace();
  const hubUrl = useStore((s) => s.hub.url);
  const [copied, setCopied] = useState(false);
  const shared = ws?.kind === "shared" && !!hubUrl;
  const link = shared ? `${hubUrl!.replace(/\/$/, "")}/f/${ws!.id}/${formId}` : "";
  const dbDoc = docById(dbId);
  return (
    <aside className="form-side">
      <div className="form-card">
        <div className="form-card-head">
          <Link2 size={14} />
          {tr("office.form.publicLink")}
        </div>
        {shared ? (
          <>
            <div className="form-link mono truncate">{link}</div>
            <button
              className="btn small block"
              onClick={() => {
                navigator.clipboard.writeText(link).then(() => {
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1500);
                });
              }}
            >
              {copied ? <Check size={13} /> : <Copy size={13} />}
              {copied ? tr("office.form.copied") : tr("office.form.copy")}
            </button>
          </>
        ) : (
          <p className="form-note">{tr("office.form.notShared")}</p>
        )}
      </div>
      <div className="form-card">
        <div className="form-card-head">
          <Database size={14} />
          {tr("office.form.responses")}
          <span className="group-count">{responses}</span>
        </div>
        <p className="form-note">{tr("office.form.responsesHint", { db: dbDoc?.title ?? "" })}</p>
        <button className="btn small block" onClick={() => openDoc(dbId)}>
          {tr("office.form.openDb")}
        </button>
      </div>
    </aside>
  );
}

/** The form as a respondent sees it, submitting for real. */
function FormPreview({ formId }: { formId: string }) {
  const tr = useT();
  const ws = useStore((s) => s.workspaceId);
  const [form, setForm] = useState<PublicForm | null>(null);
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  useEffect(() => {
    rpc<PublicForm>("get_form_public", { workspace_id: ws, form_id: formId })
      .then(setForm)
      .catch((e) => setError(String(e)));
  }, [ws, formId]);
  if (!form) return error ? <Empty text={error} /> : <div className="office-loading" />;
  if (sent)
    return (
      <div className="form-sent">
        <Check size={18} />
        <p>{tr("office.form.thanks")}</p>
        <button
          className="btn small"
          onClick={() => {
            setAnswers({});
            setSent(false);
          }}
        >
          {tr("office.form.another")}
        </button>
      </div>
    );
  const set = (id: string, v: unknown) => setAnswers((a) => ({ ...a, [id]: v }));
  return (
    <form
      className="form-public"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        try {
          await rpc("form_submit", { workspace_id: ws, form_id: formId, answers });
          setSent(true);
        } catch (err) {
          setError(String(err).replace(/^Error: /, ""));
        }
      }}
    >
      <h1 className="office-doc-title">{form.title}</h1>
      {form.description && <p className="form-public-desc">{form.description}</p>}
      {form.questions.map((q) => (
        <label key={q.id} className="field form-public-q">
          <span>
            {q.label}
            {q.required && <span className="form-req"> *</span>}
          </span>
          {q.help && <span className="field-hint">{q.help}</span>}
          {q.kind === "select" ? (
            <select className="input" value={String(answers[q.id] ?? "")} required={q.required} onChange={(e) => set(q.id, e.target.value)}>
              <option value="" />
              {q.options.map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
          ) : q.kind === "multi_select" ? (
            <span className="form-checks">
              {q.options.map((o) => {
                const list = (answers[q.id] as string[]) ?? [];
                return (
                  <label key={o} className="toggle">
                    <input type="checkbox" checked={list.includes(o)} onChange={(e) => set(q.id, e.target.checked ? [...list, o] : list.filter((x) => x !== o))} />
                    {o}
                  </label>
                );
              })}
            </span>
          ) : q.kind === "checkbox" ? (
            <input type="checkbox" className="db-check" checked={!!answers[q.id]} onChange={(e) => set(q.id, e.target.checked)} />
          ) : (
            <input
              className="input"
              type={q.kind === "number" ? "number" : q.kind === "date" ? "date" : q.kind === "url" ? "url" : "text"}
              required={q.required}
              value={String(answers[q.id] ?? "")}
              onChange={(e) => set(q.id, e.target.value)}
            />
          )}
        </label>
      ))}
      {error && <p className="form-error">{error}</p>}
      <div className="form-actions">
        <button className="btn primary" type="submit">
          {tr("office.form.submit")}
        </button>
      </div>
    </form>
  );
}
