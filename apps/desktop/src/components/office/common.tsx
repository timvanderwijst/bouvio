import { CalendarDays, Database, FileSpreadsheet, FileText, ListChecks, Presentation, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { backend } from "../../backend";
import { t } from "../../i18n";
import type { Doc } from "../../protocol/Doc";
import type { DocKind } from "../../protocol/DocKind";
import { rpc, useStore } from "../../store";

export const KINDS: DocKind[] = ["doc", "sheet", "slides", "database", "form"];

export const KIND_ICON: Record<DocKind, LucideIcon> = {
  doc: FileText,
  sheet: FileSpreadsheet,
  slides: Presentation,
  database: Database,
  form: ListChecks,
};
export const CalendarIcon = CalendarDays;

export function KindIcon({ kind, size = 15 }: { kind: DocKind; size?: number }) {
  const I = KIND_ICON[kind];
  return (
    <span className={`office-kind k-${kind}`}>
      <I size={size} />
    </span>
  );
}

/** Office docs of the current workspace, kept fresh by notices. */
const listeners = new Set<() => void>();
const cache: Record<string, Doc[] | undefined> = {};
let wired = false;

function wire() {
  if (wired) return;
  wired = true;
  backend.on<{ workspace_id: string; kind: string; payload: any }>("workspace-notice", ({ workspace_id: w, kind, payload }) => {
    const list = cache[w];
    if (!list) return;
    if (kind === "office-doc") {
      const d = payload as Doc;
      cache[w] = [d, ...list.filter((x) => x.id !== d.id)].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    } else if (kind === "office-doc-deleted") cache[w] = list.filter((x) => x.id !== payload.id);
    else return;
    listeners.forEach((f) => f());
  });
}

export async function refreshDocs(ws: string) {
  wire();
  try {
    cache[ws] = await rpc<Doc[]>("list_docs", { workspace_id: ws }, ws);
  } catch (e) {
    cache[ws] = cache[ws] ?? [];
    useStore.getState().notify(String(e));
  }
  listeners.forEach((f) => f());
}

export function useDocs(): Doc[] | undefined {
  const ws = useStore((s) => s.workspaceId);
  const [, bump] = useState(0);
  useEffect(() => {
    const f = () => bump((n) => n + 1);
    listeners.add(f);
    if (ws) refreshDocs(ws);
    return () => void listeners.delete(f);
  }, [ws]);
  return ws ? cache[ws] : undefined;
}

export function docById(id: string): Doc | undefined {
  for (const list of Object.values(cache)) {
    const d = list?.find((x) => x.id === id);
    if (d) return d;
  }
  return undefined;
}

export function rememberDoc(d: Doc) {
  const list = cache[d.workspace_id];
  if (list && !list.some((x) => x.id === d.id)) cache[d.workspace_id] = [d, ...list];
  else if (list) cache[d.workspace_id] = list.map((x) => (x.id === d.id ? d : x));
  listeners.forEach((f) => f());
}

export const openDoc = (id: string) => useStore.getState().go({ kind: "ext", id: "office.doc", sub: id });

const DEFAULT_TITLE: Record<DocKind, string> = {
  doc: "office.untitled.doc",
  sheet: "office.untitled.sheet",
  slides: "office.untitled.slides",
  database: "office.untitled.database",
  form: "office.untitled.form",
};

/** Create a document and open it. */
export async function createDoc(kind: DocKind, opts: { title?: string; template?: string; parent_id?: string; open?: boolean } = {}): Promise<Doc | null> {
  const s = useStore.getState();
  const ws = s.workspaceId;
  if (!ws) {
    s.notify(t("office.noWorkspace"));
    return null;
  }
  try {
    const d = await rpc<Doc>("create_doc", { workspace_id: ws, kind, title: opts.title ?? t(DEFAULT_TITLE[kind]), template: opts.template ?? null, parent_id: opts.parent_id ?? null });
    rememberDoc(d);
    if (opts.open !== false) openDoc(d.id);
    return d;
  } catch (e) {
    s.notify(String(e));
    return null;
  }
}

/** A small floating panel anchored under its trigger. Closes on outside click and Escape. */
export function Popover({
  trigger,
  children,
  align = "left",
  className = "",
  open: controlled,
  onOpenChange,
}: {
  trigger: (open: boolean, toggle: () => void) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: "left" | "right";
  className?: string;
  open?: boolean;
  onOpenChange?: (o: boolean) => void;
}) {
  const [own, setOwn] = useState(false);
  const open = controlled ?? own;
  const set = (o: boolean) => (onOpenChange ? onOpenChange(o) : setOwn(o));
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && set(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && set(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  });
  return (
    <div className="menu" ref={ref}>
      {trigger(open, () => set(!open))}
      {open && <div className={`menu-list office-pop ${align === "right" ? "right" : ""} ${className}`}>{children(() => set(false))}</div>}
    </div>
  );
}

export function PopItem({ icon, label, hint, onClick, danger, on }: { icon?: ReactNode; label: string; hint?: string; onClick: () => void; danger?: boolean; on?: boolean }) {
  return (
    <button type="button" className={`menu-item ${danger ? "office-danger" : ""} ${on ? "office-on" : ""}`} onClick={onClick}>
      <span className="menu-icon">{icon}</span>
      <span className="menu-label">{label}</span>
      {hint && <span className="menu-hint">{hint}</span>}
    </button>
  );
}

/** Download text as a file. */
export function download(name: string, text: string, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Print only `.office-print` content (see office.css). */
export function printOnly() {
  document.body.classList.add("office-printing");
  const done = () => {
    document.body.classList.remove("office-printing");
    window.removeEventListener("afterprint", done);
  };
  window.addEventListener("afterprint", done);
  window.setTimeout(() => window.print(), 50);
}

export const fileSafe = (s: string) => s.replace(/[\\/:*?"<>|]+/g, "-").trim() || "untitled";
