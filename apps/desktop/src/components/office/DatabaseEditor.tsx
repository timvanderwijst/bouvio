import {
  ArrowDownUp,
  Calendar,
  CheckSquare,
  ChevronDown,
  CircleDot,
  ExternalLink,
  FileDown,
  Filter as FilterIcon,
  Hash,
  LayoutGrid,
  Link2,
  List,
  Plus,
  SquareKanban,
  Table2,
  Tags,
  Trash2,
  Type,
  User,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type * as Y from "yjs";
import { backend } from "../../backend";
import { getLang, t, useT } from "../../i18n";
import { useStore, useWorkspaceLeads } from "../../store";
import { Dialog } from "../Dialog";
import { Menu } from "../Menu";
import { Empty } from "../Panel";
import { PopItem, Popover, download, fileSafe } from "./common";
import { addRow, addView, dbParts, deleteField, deleteRow, deleteView, patchView, putField, readDb, setCell } from "./db";
import { FIELD_TYPES, OPTION_COLORS, applyView, cellText, fieldList, titleField, type Field, type FieldType, type Filter, type FilterOp, type Option, type Row, type Schema, type View, type ViewType } from "./dbview";
import type { EditorProps } from "./DocPage";
import { toDelimited } from "./formula";
import { CalNav, DayGrid, monthDays } from "./MonthGrid";
import { shortId, useYVersion } from "./sync";

export const FIELD_ICON: Record<FieldType, LucideIcon> = {
  text: Type,
  number: Hash,
  select: CircleDot,
  multi_select: Tags,
  date: Calendar,
  person: User,
  checkbox: CheckSquare,
  url: Link2,
};
const VIEW_ICON: Record<ViewType, LucideIcon> = { table: Table2, kanban: SquareKanban, calendar: Calendar, gallery: LayoutGrid };

/** Live database state for a doc. */
export function useDb(ydoc: Y.Doc) {
  const p = useMemo(() => dbParts(ydoc), [ydoc]);
  const a = useYVersion(p.schema);
  const b = useYVersion(p.rows);
  const c = useYVersion(p.views);
  return useMemo(() => readDb(ydoc), [ydoc, a, b, c]);
}

/** Names someone can pick for a person field. */
export function usePeople(): string[] {
  const me = useStore((s) => s.hub.user?.name ?? s.userName);
  const leads = useWorkspaceLeads();
  const presence = useStore((s) => (s.workspaceId ? s.data[s.workspaceId]?.presence : undefined));
  const members = useStore((s) => (s.workspaceId ? s.data[s.workspaceId]?.members : undefined));
  return useMemo(() => {
    const names = new Set<string>([me]);
    Object.values(presence ?? {}).forEach((p) => names.add(p.user.name));
    (members ?? []).forEach((m) => names.add(m.user.name));
    leads.forEach((c) => names.add(c.name));
    return [...names];
  }, [me, leads, presence, members]);
}

export function OptionChip({ o }: { o?: Option }) {
  if (!o) return null;
  return <span className={`opt opt-${o.color}`}>{o.name}</span>;
}

/** Edit one cell, whatever its type. */
export function CellEditor({ field, value, onChange, onField, compact }: { field: Field; value: unknown; onChange: (v: unknown) => void; onField?: (f: Field) => void; compact?: boolean }) {
  const tr = useT();
  const people = usePeople();
  const [draft, setDraft] = useState(value == null ? "" : String(value));
  useEffect(() => setDraft(value == null ? "" : String(value)), [value]);
  const commitText = () => {
    const next = field.type === "number" ? (draft.trim() === "" ? null : Number(draft.replace(",", "."))) : draft;
    if (field.type === "number" && next !== null && Number.isNaN(next)) return setDraft(value == null ? "" : String(value));
    if (next !== (value ?? (field.type === "number" ? null : ""))) onChange(next);
  };

  switch (field.type) {
    case "checkbox":
      return <input type="checkbox" className="db-check" checked={!!value} onChange={(e) => onChange(e.target.checked)} />;
    case "date":
      return <input type="date" className="db-input" value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)} />;
    case "select":
    case "multi_select": {
      const multi = field.type === "multi_select";
      const ids: string[] = multi ? ((value as string[]) ?? []) : value ? [value as string] : [];
      return (
        <OptionPicker
          field={field}
          ids={ids}
          multi={multi}
          onPick={(next) => onChange(multi ? next : (next[0] ?? null))}
          onField={onField}
          trigger={
            <span className="db-opts">
              {ids.length ? ids.map((id) => <OptionChip key={id} o={field.options?.find((o) => o.id === id)} />) : !compact && <span className="db-empty">{tr("office.db.empty")}</span>}
            </span>
          }
        />
      );
    }
    case "url":
      return (
        <span className="db-url">
          <input className="db-input" value={draft} placeholder={compact ? "" : "https://"} onChange={(e) => setDraft(e.target.value)} onBlur={commitText} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
          {typeof value === "string" && /^https?:\/\//.test(value) && (
            <button className="icon-btn db-url-go" onClick={() => backend.openUrl(value)} title={value}>
              <ExternalLink size={12} />
            </button>
          )}
        </span>
      );
    default:
      return (
        <>
          <input
            className={`db-input ${field.type === "number" ? "num" : ""}`}
            value={draft}
            inputMode={field.type === "number" ? "decimal" : undefined}
            list={field.type === "person" ? `people-${field.id}` : undefined}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitText}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          />
          {field.type === "person" && (
            <datalist id={`people-${field.id}`}>
              {people.map((p) => (
                <option key={p} value={p} />
              ))}
            </datalist>
          )}
        </>
      );
  }
}

function OptionPicker({ field, ids, multi, onPick, onField, trigger }: { field: Field; ids: string[]; multi: boolean; onPick: (ids: string[]) => void; onField?: (f: Field) => void; trigger: React.ReactNode }) {
  const tr = useT();
  const [q, setQ] = useState("");
  const options = field.options ?? [];
  const found = options.filter((o) => o.name.toLowerCase().includes(q.trim().toLowerCase()));
  const exact = options.some((o) => o.name.toLowerCase() === q.trim().toLowerCase());
  const toggle = (id: string) => onPick(multi ? (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]) : ids[0] === id ? [] : [id]);
  return (
    <Popover
      trigger={(_, toggleOpen) => (
        <button className="db-opt-trigger" onClick={toggleOpen}>
          {trigger}
        </button>
      )}
    >
      {(close) => (
        <div className="db-picker">
          <input
            className="input db-picker-input"
            autoFocus
            placeholder={onField ? tr("office.db.optionSearch") : tr("office.search")}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              if (found[0]) toggle(found[0].id);
              else if (q.trim() && onField) {
                const o = { id: shortId(), name: q.trim(), color: OPTION_COLORS[options.length % OPTION_COLORS.length] };
                onField({ ...field, options: [...options, o] });
                onPick(multi ? [...ids, o.id] : [o.id]);
              }
              setQ("");
              if (!multi) close();
            }}
          />
          {found.map((o) => (
            <button
              key={o.id}
              className={`menu-item ${ids.includes(o.id) ? "office-on" : ""}`}
              onClick={() => {
                toggle(o.id);
                if (!multi) close();
              }}
            >
              <OptionChip o={o} />
            </button>
          ))}
          {q.trim() && !exact && onField && (
            <button
              className="menu-item"
              onClick={() => {
                const o = { id: shortId(), name: q.trim(), color: OPTION_COLORS[options.length % OPTION_COLORS.length] };
                onField({ ...field, options: [...options, o] });
                onPick(multi ? [...ids, o.id] : [o.id]);
                setQ("");
                if (!multi) close();
              }}
            >
              <span className="menu-icon">
                <Plus size={13} />
              </span>
              <span className="menu-label">{tr("office.db.createOption", { name: q.trim() })}</span>
            </button>
          )}
        </div>
      )}
    </Popover>
  );
}

function FieldMenu({ field, ydoc, children }: { field: Field; ydoc: Y.Doc; children: React.ReactNode }) {
  const tr = useT();
  const [name, setName] = useState(field.name);
  useEffect(() => setName(field.name), [field.name]);
  const save = (patch: Partial<Field>) => putField(ydoc, { ...field, ...patch });
  return (
    <Popover
      trigger={(_, toggle) => (
        <button className="db-head-btn" onClick={toggle}>
          {children}
        </button>
      )}
    >
      {(close) => (
        <div className="db-field-menu">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== field.name && save({ name: name.trim() })} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
          <div className="db-field-types">
            {FIELD_TYPES.map((ty) => {
              const I = FIELD_ICON[ty];
              return (
                <button key={ty} className={`menu-item ${field.type === ty ? "office-on" : ""}`} onClick={() => save({ type: ty, options: ty === "select" || ty === "multi_select" ? (field.options ?? []) : field.options })}>
                  <span className="menu-icon">
                    <I size={14} />
                  </span>
                  <span className="menu-label">{tr(`office.field.${ty}`)}</span>
                </button>
              );
            })}
          </div>
          {(field.type === "select" || field.type === "multi_select") && (
            <div className="db-options">
              {(field.options ?? []).map((o, i) => (
                <div key={o.id} className="db-option-row">
                  <button
                    className={`db-color opt-${o.color}`}
                    title={tr("office.db.color")}
                    onClick={() => save({ options: field.options!.map((x, j) => (j === i ? { ...x, color: OPTION_COLORS[(OPTION_COLORS.indexOf(x.color) + 1) % OPTION_COLORS.length] } : x)) })}
                  />
                  <input
                    className="db-input"
                    defaultValue={o.name}
                    onBlur={(e) => e.target.value.trim() && e.target.value !== o.name && save({ options: field.options!.map((x, j) => (j === i ? { ...x, name: e.target.value.trim() } : x)) })}
                  />
                  <button className="icon-btn" onClick={() => save({ options: field.options!.filter((_, j) => j !== i) })}>
                    <X size={12} />
                  </button>
                </div>
              ))}
              <button
                className="btn small ghost"
                onClick={() => {
                  const n = field.options?.length ?? 0;
                  save({ options: [...(field.options ?? []), { id: shortId(), name: t("office.db.optionN", { n: n + 1 }), color: OPTION_COLORS[n % OPTION_COLORS.length] }] });
                }}
              >
                <Plus size={13} />
                {tr("office.db.addOption")}
              </button>
            </div>
          )}
          <PopItem
            icon={<Trash2 size={14} />}
            label={tr("office.db.deleteField")}
            danger
            onClick={() => {
              close();
              if (window.confirm(t("office.db.deleteFieldConfirm", { name: field.name }))) deleteField(ydoc, field.id);
            }}
          />
        </div>
      )}
    </Popover>
  );
}

function AddField({ ydoc, schema }: { ydoc: Y.Doc; schema: Schema }) {
  const tr = useT();
  return (
    <Popover
      align="right"
      trigger={(_, toggle) => (
        <button className="db-head-btn db-add-field" onClick={toggle} title={tr("office.db.addField")}>
          <Plus size={14} />
        </button>
      )}
    >
      {(close) =>
        FIELD_TYPES.map((ty) => {
          const I = FIELD_ICON[ty];
          return (
            <PopItem
              key={ty}
              icon={<I size={14} />}
              label={tr(`office.field.${ty}`)}
              onClick={() => {
                close();
                const order = Math.max(-1, ...Object.values(schema).map((f) => f.order)) + 1;
                putField(ydoc, { id: shortId(), name: t(`office.field.${ty}`), type: ty, order, ...(ty === "select" || ty === "multi_select" ? { options: [] } : {}) });
              }}
            />
          );
        })
      }
    </Popover>
  );
}

const OPS: FilterOp[] = ["is", "is_not", "contains", "empty", "not_empty", "gt", "lt"];

function FilterSort({ view, schema, ydoc }: { view: View; schema: Schema; ydoc: Y.Doc }) {
  const tr = useT();
  const fields = fieldList(schema);
  const setFilters = (filters: Filter[]) => patchView(ydoc, view.id, { filters });
  return (
    <>
      <Popover
        align="right"
        trigger={(_, toggle) => (
          <button className={`btn small ghost ${view.filters.length ? "office-active" : ""}`} onClick={toggle}>
            <FilterIcon size={13} />
            {view.filters.length ? tr("office.db.filters", { n: view.filters.length }) : tr("office.db.filter")}
          </button>
        )}
      >
        {() => (
          <div className="db-rules">
            {view.filters.length === 0 && <div className="db-rules-empty">{tr("office.db.noFilters")}</div>}
            {view.filters.map((f, i) => {
              const field = schema[f.field];
              const set = (p: Partial<Filter>) => setFilters(view.filters.map((x, j) => (j === i ? { ...x, ...p } : x)));
              return (
                <div key={i} className="db-rule">
                  <Menu value={f.field} items={fields.map((x) => ({ value: x.id, label: x.name }))} onChange={(v) => set({ field: v, value: undefined })} />
                  <Menu value={f.op} items={OPS.map((o) => ({ value: o, label: tr(`office.op.${o}`) }))} onChange={(v) => set({ op: v })} />
                  {f.op !== "empty" && f.op !== "not_empty" && field && (
                    field.type === "select" || field.type === "multi_select" ? (
                      <Menu value={(f.value as string) ?? null} items={[{ value: null, label: "—" }, ...(field.options ?? []).map((o) => ({ value: o.id as string | null, label: o.name }))]} onChange={(v) => set({ value: v })} />
                    ) : field.type === "checkbox" ? (
                      <input type="checkbox" className="db-check" checked={!!f.value} onChange={(e) => set({ value: e.target.checked })} />
                    ) : (
                      <input className="input db-rule-value" type={field.type === "date" ? "date" : "text"} value={String(f.value ?? "")} onChange={(e) => set({ value: e.target.value })} />
                    )
                  )}
                  <button className="icon-btn" onClick={() => setFilters(view.filters.filter((_, j) => j !== i))}>
                    <X size={13} />
                  </button>
                </div>
              );
            })}
            {fields.length > 0 && (
              <button className="btn small ghost" onClick={() => setFilters([...view.filters, { field: fields[0].id, op: "contains", value: "" }])}>
                <Plus size={13} />
                {tr("office.db.addFilter")}
              </button>
            )}
          </div>
        )}
      </Popover>
      <Popover
        align="right"
        trigger={(_, toggle) => (
          <button className={`btn small ghost ${view.sorts.length ? "office-active" : ""}`} onClick={toggle}>
            <ArrowDownUp size={13} />
            {tr("office.db.sort")}
          </button>
        )}
      >
        {() => (
          <div className="db-rules">
            {view.sorts.length === 0 && <div className="db-rules-empty">{tr("office.db.noSorts")}</div>}
            {view.sorts.map((s, i) => (
              <div key={i} className="db-rule">
                <Menu value={s.field} items={fields.map((x) => ({ value: x.id, label: x.name }))} onChange={(v) => patchView(ydoc, view.id, { sorts: view.sorts.map((x, j) => (j === i ? { ...x, field: v } : x)) })} />
                <Menu
                  value={s.desc ? "desc" : "asc"}
                  items={[
                    { value: "asc", label: tr("office.db.asc") },
                    { value: "desc", label: tr("office.db.desc") },
                  ]}
                  onChange={(v) => patchView(ydoc, view.id, { sorts: view.sorts.map((x, j) => (j === i ? { ...x, desc: v === "desc" } : x)) })}
                />
                <button className="icon-btn" onClick={() => patchView(ydoc, view.id, { sorts: view.sorts.filter((_, j) => j !== i) })}>
                  <X size={13} />
                </button>
              </div>
            ))}
            {fields.length > 0 && (
              <button className="btn small ghost" onClick={() => patchView(ydoc, view.id, { sorts: [...view.sorts, { field: fields[0].id, desc: false }] })}>
                <Plus size={13} />
                {tr("office.db.addSort")}
              </button>
            )}
          </div>
        )}
      </Popover>
    </>
  );
}

/** Every field of one row, in a dialog. */
export function RowDialog({ ydoc, schema, row, onClose }: { ydoc: Y.Doc; schema: Schema; row: Row; onClose: () => void }) {
  const tr = useT();
  const title = titleField(schema);
  return (
    <Dialog title={(title && cellText(title, row[title.id])) || tr("office.untitled")} onClose={onClose}>
      <div className="db-row-props">
        {fieldList(schema).map((f) => {
          const I = FIELD_ICON[f.type];
          return (
            <label key={f.id} className="db-prop">
              <span className="db-prop-name">
                <I size={13} />
                {f.name}
              </span>
              <span className="db-prop-value">
                <CellEditor field={f} value={row[f.id]} onChange={(v) => setCell(ydoc, row.id, f.id, v)} onField={(nf) => putField(ydoc, nf)} />
              </span>
            </label>
          );
        })}
      </div>
      <div className="form-actions spread">
        <button
          className="btn ghost office-danger"
          onClick={() => {
            deleteRow(ydoc, row.id);
            onClose();
          }}
        >
          <Trash2 size={14} />
          {tr("office.db.deleteRow")}
        </button>
        <button className="btn primary" onClick={onClose}>
          {tr("office.done")}
        </button>
      </div>
    </Dialog>
  );
}

export function DatabaseEditor({ doc, session, setActions }: EditorProps) {
  const tr = useT();
  const ydoc = session.ydoc;
  const { schema, rows, views } = useDb(ydoc);
  const [viewId, setViewId] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const view: View = views.find((v) => v.id === viewId) ?? views[0] ?? { id: "", name: "", type: "table", filters: [], sorts: [] };
  const shown = useMemo(() => applyView(rows, schema, view), [rows, schema, view]);
  const fields = fieldList(schema);
  const openRow = rows.find((r) => r.id === open);

  useEffect(() => {
    if (!views.length) addView(ydoc, { name: t("office.view.table"), type: "table", filters: [], sorts: [] });
  }, [views.length, ydoc]);

  useEffect(() => {
    setActions([
      {
        id: "csv",
        label: t("office.exportCsv"),
        icon: <FileDown size={14} />,
        run: () => {
          const { schema: s, rows: r } = readDb(ydoc);
          const fs = fieldList(s);
          download(`${fileSafe(doc.title)}.csv`, toDelimited([fs.map((f) => f.name), ...r.map((row) => fs.map((f) => cellText(f, row[f.id])))], ","), "text/csv");
        },
      },
    ]);
  }, [ydoc, doc.title, setActions]);

  return (
    <div className="db">
      <div className="db-bar">
        <div className="db-tabs">
          {views.map((v) => {
            const I = VIEW_ICON[v.type] ?? List;
            const on = v.id === view.id;
            return on ? (
              <Popover
                key={v.id}
                trigger={(_, toggle) => (
                  <button className="db-tab on" onClick={toggle}>
                    <I size={13} />
                    {v.name}
                    <ChevronDown size={12} className="menu-chev" />
                  </button>
                )}
              >
                {(close) => (
                  <ViewMenu
                    view={v}
                    schema={schema}
                    ydoc={ydoc}
                    canDelete={views.length > 1}
                    onDelete={() => {
                      close();
                      deleteView(ydoc, v.id);
                      setViewId(null);
                    }}
                  />
                )}
              </Popover>
            ) : (
              <button key={v.id} className="db-tab" onClick={() => setViewId(v.id)}>
                <I size={13} />
                {v.name}
              </button>
            );
          })}
          <Popover
            trigger={(_, toggle) => (
              <button className="icon-btn" onClick={toggle} title={tr("office.db.addView")}>
                <Plus size={14} />
              </button>
            )}
          >
            {(close) =>
              (["table", "kanban", "calendar", "gallery"] as ViewType[]).map((ty) => {
                const I = VIEW_ICON[ty];
                return (
                  <PopItem
                    key={ty}
                    icon={<I size={14} />}
                    label={tr(`office.view.${ty}`)}
                    onClick={() => {
                      close();
                      const group = fields.find((f) => f.type === "select")?.id;
                      const date = fields.find((f) => f.type === "date")?.id;
                      setViewId(addView(ydoc, { name: tr(`office.view.${ty}`), type: ty, filters: [], sorts: [], ...(ty === "kanban" && group ? { group_by: group } : {}), ...(ty === "calendar" && date ? { date_field: date } : {}) }));
                    }}
                  />
                );
              })
            }
          </Popover>
        </div>
        <div className="page-actions">
          {view.id && <FilterSort view={view} schema={schema} ydoc={ydoc} />}
          <button className="btn small primary" onClick={() => setOpen(addRow(ydoc, defaultsFor(view, schema)))}>
            <Plus size={13} />
            {tr("office.db.new")}
          </button>
        </div>
      </div>
      <div className="db-body">
        {view.type === "kanban" ? (
          <Kanban ydoc={ydoc} schema={schema} rows={shown} view={view} onOpen={setOpen} />
        ) : view.type === "calendar" ? (
          <DbCalendar ydoc={ydoc} schema={schema} rows={shown} view={view} onOpen={setOpen} />
        ) : view.type === "gallery" ? (
          <Gallery schema={schema} rows={shown} onOpen={setOpen} />
        ) : (
          <Table ydoc={ydoc} schema={schema} rows={shown} onOpen={setOpen} view={view} />
        )}
      </div>
      {openRow && <RowDialog ydoc={ydoc} schema={schema} row={openRow} onClose={() => setOpen(null)} />}
    </div>
  );
}

/** New rows land where the view looks: in its filtered select value, today for calendars. */
function defaultsFor(view: View, schema: Schema): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of view.filters) if (f.op === "is" && schema[f.field] && f.value !== undefined && f.value !== "") out[f.field] = schema[f.field].type === "multi_select" ? [f.value] : f.value;
  return out;
}

function ViewMenu({ view, schema, ydoc, canDelete, onDelete }: { view: View; schema: Schema; ydoc: Y.Doc; canDelete: boolean; onDelete: () => void }) {
  const tr = useT();
  const [name, setName] = useState(view.name);
  const fields = fieldList(schema);
  return (
    <div className="db-field-menu">
      <input className="input" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && patchView(ydoc, view.id, { name: name.trim() })} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
      {view.type === "kanban" && (
        <label className="db-view-opt">
          <span>{tr("office.db.groupBy")}</span>
          <Menu value={view.group_by ?? null} items={[{ value: null, label: "—" }, ...fields.filter((f) => f.type === "select").map((f) => ({ value: f.id as string | null, label: f.name }))]} onChange={(v) => patchView(ydoc, view.id, { group_by: v ?? undefined })} />
        </label>
      )}
      {view.type === "calendar" && (
        <label className="db-view-opt">
          <span>{tr("office.db.dateField")}</span>
          <Menu value={view.date_field ?? null} items={[{ value: null, label: "—" }, ...fields.filter((f) => f.type === "date").map((f) => ({ value: f.id as string | null, label: f.name }))]} onChange={(v) => patchView(ydoc, view.id, { date_field: v ?? undefined })} />
        </label>
      )}
      {canDelete && <PopItem icon={<Trash2 size={14} />} label={tr("office.db.deleteView")} danger onClick={onDelete} />}
    </div>
  );
}

function Table({ ydoc, schema, rows, onOpen, view }: { ydoc: Y.Doc; schema: Schema; rows: Row[]; onOpen: (id: string) => void; view: View }) {
  const tr = useT();
  const fields = fieldList(schema);
  const cols = fields.map((f) => (f.type === "text" && f === fields[0] ? "minmax(220px, 2fr)" : f.type === "checkbox" ? "90px" : "minmax(150px, 1fr)")).join(" ");
  const grid = { gridTemplateColumns: `36px ${cols} 44px` };
  return (
    <div className="db-table-wrap">
      <div className="db-table" role="table">
        <div className="db-tr db-thead" style={grid}>
          <span />
          {fields.map((f) => {
            const I = FIELD_ICON[f.type];
            return (
              <span key={f.id} className="db-th">
                <FieldMenu field={f} ydoc={ydoc}>
                  <I size={13} />
                  <span className="truncate">{f.name}</span>
                </FieldMenu>
              </span>
            );
          })}
          <span className="db-th">
            <AddField ydoc={ydoc} schema={schema} />
          </span>
        </div>
        {rows.map((r, i) => (
          <div key={r.id} className="db-tr" style={grid}>
            <span className="db-rownum">
              <span className="db-rownum-n">{i + 1}</span>
              <button className="icon-btn db-open" onClick={() => onOpen(r.id)} title={tr("office.db.openRow")}>
                <ExternalLink size={12} />
              </button>
            </span>
            {fields.map((f) => (
              <span key={f.id} className={`db-td t-${f.type}`}>
                <CellEditor field={f} value={r[f.id]} compact onChange={(v) => setCell(ydoc, r.id, f.id, v)} onField={(nf) => putField(ydoc, nf)} />
              </span>
            ))}
            <span className="db-td db-row-end">
              <button className="icon-btn db-del" onClick={() => deleteRow(ydoc, r.id)} title={tr("office.db.deleteRow")}>
                <Trash2 size={13} />
              </button>
            </span>
          </div>
        ))}
        <button className="db-new-row" onClick={() => addRow(ydoc, defaultsFor(view, schema))}>
          <Plus size={13} />
          {tr("office.db.new")}
        </button>
      </div>
    </div>
  );
}

function RowCard({ schema, row, onOpen, draggable }: { schema: Schema; row: Row; onOpen: () => void; draggable?: boolean }) {
  const tr = useT();
  const title = titleField(schema);
  const props = fieldList(schema).filter((f) => f !== title && row[f.id] !== undefined && row[f.id] !== "" && row[f.id] !== false);
  return (
    <button className="db-card" draggable={draggable} onDragStart={(e) => e.dataTransfer.setData("text/plain", row.id)} onClick={onOpen}>
      <span className="db-card-title">{(title && cellText(title, row[title.id])) || <span className="db-empty">{tr("office.untitled")}</span>}</span>
      {props.slice(0, 4).map((f) =>
        f.type === "select" ? (
          <OptionChip key={f.id} o={f.options?.find((o) => o.id === row[f.id])} />
        ) : f.type === "multi_select" ? (
          <span key={f.id} className="db-opts">
            {(row[f.id] as string[]).map((id) => (
              <OptionChip key={id} o={f.options?.find((o) => o.id === id)} />
            ))}
          </span>
        ) : (
          <span key={f.id} className="db-card-prop truncate">
            {f.type === "date" ? fmtDate(row[f.id] as string) : cellText(f, row[f.id])}
          </span>
        ),
      )}
    </button>
  );
}

const fmtDate = (s: string) => {
  const d = new Date(`${s}T00:00:00`);
  return Number.isNaN(d.getTime()) ? s : new Intl.DateTimeFormat(getLang(), { day: "numeric", month: "short" }).format(d);
};

function Kanban({ ydoc, schema, rows, view, onOpen }: { ydoc: Y.Doc; schema: Schema; rows: Row[]; view: View; onOpen: (id: string) => void }) {
  const tr = useT();
  const group = (view.group_by && schema[view.group_by]) || fieldList(schema).find((f) => f.type === "select");
  const [over, setOver] = useState<string | null>(null);
  if (!group) return <Empty text={tr("office.db.needSelect")} />;
  const cols: (Option | null)[] = [null, ...(group.options ?? [])];
  return (
    <div className="db-kanban">
      {cols.map((o) => {
        const key = o?.id ?? "";
        const items = rows.filter((r) => (r[group.id] ?? "") === key);
        if (!o && !items.length) return null;
        return (
          <div
            key={key || "none"}
            className={`db-col ${over === key ? "drop" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(key);
            }}
            onDragLeave={() => setOver(null)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(null);
              const id = e.dataTransfer.getData("text/plain");
              if (id) setCell(ydoc, id, group.id, o?.id ?? null);
            }}
          >
            <div className="db-col-head">
              {o ? <OptionChip o={o} /> : <span className="db-empty">{tr("office.db.noValue", { name: group.name })}</span>}
              <span className="group-count">{items.length}</span>
            </div>
            {items.map((r) => (
              <RowCard key={r.id} schema={schema} row={r} draggable onOpen={() => onOpen(r.id)} />
            ))}
            <button className="db-new-row" onClick={() => onOpen(addRow(ydoc, o ? { [group.id]: o.id } : {}))}>
              <Plus size={13} />
              {tr("office.db.new")}
            </button>
          </div>
        );
      })}
    </div>
  );
}

function DbCalendar({ ydoc, schema, rows, view, onOpen }: { ydoc: Y.Doc; schema: Schema; rows: Row[]; view: View; onOpen: (id: string) => void }) {
  const tr = useT();
  const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const dateField = (view.date_field && schema[view.date_field]) || fieldList(schema).find((f) => f.type === "date");
  const title = titleField(schema);
  const byDay = useMemo(() => {
    const m: Record<string, Row[]> = {};
    if (dateField) for (const r of rows) if (typeof r[dateField.id] === "string") (m[r[dateField.id] as string] ??= []).push(r);
    return m;
  }, [rows, dateField]);
  if (!dateField) return <Empty text={tr("office.db.needDate")} />;
  const label = new Intl.DateTimeFormat(getLang(), { month: "long", year: "numeric" }).format(month);
  return (
    <div className="db-calendar">
      <CalNav
        label={label}
        onPrev={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}
        onNext={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
        onToday={() => setMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}
      />
      <DayGrid
        days={monthDays(month)}
        month={month.getMonth()}
        onAdd={(day) => onOpen(addRow(ydoc, { [dateField.id]: day }))}
        onDrop={(day, id) => id && setCell(ydoc, id, dateField.id, day)}
        render={(_, key) =>
          (byDay[key] ?? []).map((r) => (
            <button key={r.id} className="cal-item" draggable onDragStart={(e) => e.dataTransfer.setData("text/plain", r.id)} onClick={() => onOpen(r.id)}>
              <span className="truncate">{(title && cellText(title, r[title.id])) || tr("office.untitled")}</span>
            </button>
          ))
        }
      />
    </div>
  );
}

function Gallery({ schema, rows, onOpen }: { schema: Schema; rows: Row[]; onOpen: (id: string) => void }) {
  const tr = useT();
  if (!rows.length) return <Empty text={tr("office.db.noRows")} />;
  return (
    <div className="db-gallery">
      {rows.map((r) => (
        <RowCard key={r.id} schema={schema} row={r} onOpen={() => onOpen(r.id)} />
      ))}
    </div>
  );
}
