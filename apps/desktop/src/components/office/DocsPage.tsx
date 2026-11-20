import { CalendarRange, ClipboardList, FileText, MoreHorizontal, Pencil, Plus, Trash2, Wallet } from "lucide-react";
import { useMemo, useState } from "react";
import { useT } from "../../i18n";
import { ago } from "../../lib/format";
import type { Doc } from "../../protocol/Doc";
import type { DocKind } from "../../protocol/DocKind";
import { rpc, useStore } from "../../store";
import { Empty } from "../Panel";
import { KIND_ICON, KINDS, KindIcon, PopItem, Popover, createDoc, openDoc, useDocs } from "./common";
import "./office.css";

const TEMPLATES: { id: string; kind: DocKind; label: string; hint: string; icon: typeof FileText }[] = [
  { id: "meeting-notes", kind: "doc", label: "office.tpl.meeting", hint: "office.tpl.meetingHint", icon: ClipboardList },
  { id: "project-brief", kind: "doc", label: "office.tpl.brief", hint: "office.tpl.briefHint", icon: FileText },
  { id: "budget", kind: "sheet", label: "office.tpl.budget", hint: "office.tpl.budgetHint", icon: Wallet },
  { id: "content-calendar", kind: "database", label: "office.tpl.content", hint: "office.tpl.contentHint", icon: CalendarRange },
];

export function NewMenu({ align = "right" }: { align?: "left" | "right" }) {
  const t = useT();
  return (
    <Popover
      align={align}
      trigger={(_, toggle) => (
        <button className="btn primary" onClick={toggle}>
          <Plus size={14} />
          {t("office.new")}
        </button>
      )}
    >
      {(close) =>
        KINDS.map((k) => {
          const I = KIND_ICON[k];
          return (
            <PopItem
              key={k}
              icon={<I size={15} />}
              label={t(`office.kind.${k}`)}
              onClick={() => {
                close();
                createDoc(k);
              }}
            />
          );
        })
      }
    </Popover>
  );
}

export function DocsPage() {
  const t = useT();
  const docs = useDocs();
  const [filter, setFilter] = useState<DocKind | "all">("all");
  const [q, setQ] = useState("");
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (docs ?? []).filter((d) => (filter === "all" || d.kind === filter) && (!needle || d.title.toLowerCase().includes(needle)));
  }, [docs, filter, q]);

  return (
    <div className="page wide office-docs">
      <div className="page-head">
        <h1 className="page-title">{t("office.docs")}</h1>
        <div className="page-actions">
          <input className="input office-search" placeholder={t("office.search")} value={q} onChange={(e) => setQ(e.target.value)} />
          <NewMenu />
        </div>
      </div>

      <div className="office-templates">
        {TEMPLATES.map((tp) => (
          <button key={tp.id} className="office-template" onClick={() => createDoc(tp.kind, { title: t(tp.label), template: tp.id })}>
            <span className="office-template-icon">
              <tp.icon size={16} />
            </span>
            <span className="office-template-text">
              <span className="office-template-title">{t(tp.label)}</span>
              <span className="office-template-hint">{t(tp.hint)}</span>
            </span>
          </button>
        ))}
      </div>

      <div className="studio-filter">
        <button className={`chip-btn ${filter === "all" ? "on" : ""}`} onClick={() => setFilter("all")}>
          {t("office.all")}
        </button>
        {KINDS.map((k) => (
          <button key={k} className={`chip-btn ${filter === k ? "on" : ""}`} onClick={() => setFilter(k)}>
            {t(`office.kinds.${k}`)}
          </button>
        ))}
      </div>

      {docs === undefined ? null : shown.length === 0 ? (
        <Empty text={docs.length ? t("office.noMatch") : t("office.empty")} />
      ) : (
        <div className="office-list">
          {shown.map((d) => (
            <DocRow key={d.id} doc={d} />
          ))}
        </div>
      )}
    </div>
  );
}

function DocRow({ doc }: { doc: Doc }) {
  const t = useT();
  const notify = useStore((s) => s.notify);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(doc.title);
  const commit = () => {
    setRenaming(false);
    if (title.trim() && title !== doc.title) rpc("rename_doc", { id: doc.id, title: title.trim() }).catch((e) => notify(String(e)));
    else setTitle(doc.title);
  };
  return (
    <div className="list-row office-row" role="button" tabIndex={0} onClick={() => !renaming && openDoc(doc.id)} onKeyDown={(e) => e.key === "Enter" && !renaming && openDoc(doc.id)}>
      <KindIcon kind={doc.kind} />
      {renaming ? (
        <input
          className="office-inline-input list-title"
          autoFocus
          value={title}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") {
              setTitle(doc.title);
              setRenaming(false);
            }
          }}
        />
      ) : (
        <span className="truncate list-title">{doc.title || t("office.untitled")}</span>
      )}
      <span className="list-meta office-kind-label">{t(`office.kind.${doc.kind}`)}</span>
      <span className="list-meta truncate office-author">{doc.created_by}</span>
      <span className="list-meta when">{ago(doc.updated_at)}</span>
      <span onClick={(e) => e.stopPropagation()}>
        <Popover
          align="right"
          trigger={(_, toggle) => (
            <button className="icon-btn office-row-more" onClick={toggle} title={t("office.more")}>
              <MoreHorizontal size={15} />
            </button>
          )}
        >
          {(close) => (
            <>
              <PopItem
                icon={<Pencil size={14} />}
                label={t("office.rename")}
                onClick={() => {
                  close();
                  setRenaming(true);
                }}
              />
              <PopItem
                icon={<Trash2 size={14} />}
                label={t("common.delete")}
                danger
                onClick={() => {
                  close();
                  if (window.confirm(t("office.deleteConfirm", { title: doc.title }))) rpc("delete_doc", { id: doc.id }).catch((e) => notify(String(e)));
                }}
              />
            </>
          )}
        </Popover>
      </span>
    </div>
  );
}
