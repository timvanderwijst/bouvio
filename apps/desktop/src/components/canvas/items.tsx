import { ChevronDown, FileText, GitBranch, Globe, MessageSquare } from "lucide-react";
import { memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useT } from "../../i18n";
import { pathOf, stickyFont, type Pt } from "./geom";
import type { CanvasItem, FrameAction } from "./types";

/* ---------- small pieces ---------- */

/** Issue status as a shape, in the planning-board tradition: dashed, ring, half, check, cross. */
export function TaskStatusIcon({ status, size = 14 }: { status?: string; size?: number }) {
  const s = status ?? "todo";
  return (
    <svg className={`cv-status cv-status-${s}`} width={size} height={size} viewBox="0 0 14 14" aria-hidden>
      {s === "backlog" && <circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="1.6 1.9" />}
      {s === "todo" && <circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5" />}
      {s === "in_progress" && (
        <>
          <circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M7 3.5a3.5 3.5 0 0 1 0 7z" fill="currentColor" />
        </>
      )}
      {s === "done" && (
        <>
          <circle cx="7" cy="7" r="6.25" fill="currentColor" />
          <path d="M4.4 7.2l1.8 1.8 3.5-3.6" fill="none" stroke="var(--sheet)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </>
      )}
      {s === "canceled" && (
        <>
          <circle cx="7" cy="7" r="6.25" fill="currentColor" />
          <path d="M5 5l4 4M9 5l-4 4" stroke="var(--sheet)" strokeWidth="1.5" strokeLinecap="round" />
        </>
      )}
    </svg>
  );
}

export function frameIcon(kind: string | undefined, size = 13) {
  if (kind === "artifact") return <FileText size={size} />;
  if (kind === "thread") return <MessageSquare size={size} />;
  return <GitBranch size={size} />;
}

function framePath(src: string): string {
  if (!src) return "";
  try {
    const u = new URL(src);
    return u.pathname + u.search;
  } catch {
    return src;
  }
}

/* ---------- inline editor ---------- */

function Editor({
  item,
  onDone,
}: {
  item: CanvasItem;
  onDone(id: string, text: string, h?: number): void;
}) {
  const t = useT();
  const [value, setValue] = useState(item.text ?? "");
  const ref = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);

  const fit = () => {
    const el = ref.current;
    if (!el || item.kind !== "text") return;
    el.style.height = "0px";
    el.style.height = el.scrollHeight + "px";
  };

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.select();
    fit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const finish = () => {
    if (done.current) return;
    done.current = true;
    const h = item.kind === "text" && ref.current ? ref.current.scrollHeight : undefined;
    onDone(item.id, value, h);
  };

  const style =
    item.kind === "sticky" ? { fontSize: stickyFont(value, item.w, item.h) } : undefined;

  return (
    <textarea
      ref={ref}
      className={`cv-editor cv-editor-${item.kind}`}
      value={value}
      style={style}
      spellCheck={false}
      placeholder={item.kind === "sticky" ? t("canvas.sticky.placeholder") : t("canvas.text.placeholder")}
      onChange={(e) => {
        setValue(e.target.value);
        requestAnimationFrame(fit);
      }}
      onBlur={finish}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) {
          e.preventDefault();
          ref.current?.blur();
        }
      }}
    />
  );
}

/* ---------- frame ---------- */

function FrameHeader({ item, onAction }: { item: CanvasItem; onAction(item: CanvasItem, a: FrameAction): void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const f = item.frame;
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("pointerdown", close, true);
    return () => document.removeEventListener("pointerdown", close, true);
  }, [open]);
  const actions: FrameAction[] = ["open", "reload", "variant", "inspect"];
  return (
    <div className="cv-frame-head" ref={ref} title={f?.branch}>
      <span className="cv-frame-icon">{frameIcon(f?.kind)}</span>
      <span className="cv-frame-label">{f?.label || t("canvas.frame.untitled")}</span>
      {f?.src && <span className="cv-frame-path">{f.kind === "url" ? framePath(f.src) : ""}</span>}
      <button
        type="button"
        className="cv-frame-chev"
        aria-label={t("canvas.frame.actions")}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => setOpen((o) => !o)}
      >
        <ChevronDown size={12} />
      </button>
      {open && (
        <div className="cv-pop cv-frame-menu" onPointerDown={(e) => e.stopPropagation()}>
          {actions.map((a) => (
            <button
              type="button"
              key={a}
              className="cv-pop-item"
              onClick={() => {
                setOpen(false);
                onAction(item, a);
              }}
            >
              {t(`canvas.frame.${a}`)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function FramePlaceholder({ item }: { item: CanvasItem }) {
  const t = useT();
  const f = item.frame;
  return (
    <div className={`cv-frame-empty ${f?.theme === "dark" ? "dark" : ""}`}>
      <div className="cv-frame-empty-icon">{f?.kind === "url" || !f ? <Globe size={22} /> : frameIcon(f.kind, 22)}</div>
      <div className="cv-frame-empty-title">{f?.src ? f.label || t("canvas.frame.untitled") : t("canvas.frame.empty")}</div>
      <div className="cv-frame-empty-sub mono">{f?.src || t("canvas.frame.emptyHint")}</div>
    </div>
  );
}

/* ---------- item ---------- */

export interface ItemViewProps {
  item: CanvasItem;
  editing: boolean;
  entered: boolean;
  renderFrame?: (item: CanvasItem) => ReactNode;
  onEditDone(id: string, text: string, h?: number): void;
  onFrameAction(item: CanvasItem, a: FrameAction): void;
}

export const ItemView = memo(function ItemView({ item, editing, entered, renderFrame, onEditDone, onFrameAction }: ItemViewProps) {
  const t = useT();
  const style: React.CSSProperties = {
    transform: `translate(${item.x}px, ${item.y}px)${item.rotation ? ` rotate(${item.rotation}deg)` : ""}`,
    width: item.w,
    height: item.kind === "text" ? undefined : item.h,
    minHeight: item.kind === "text" ? item.h : undefined,
  };
  const color = item.color ?? (item.kind === "sticky" ? "yellow" : "grey");

  switch (item.kind) {
    case "sticky":
      return (
        <div className={`cv-item cv-sticky cv-c-${color}`} data-id={item.id} style={style}>
          {editing ? (
            <Editor item={item} onDone={onEditDone} />
          ) : (
            <div className="cv-sticky-text" style={{ fontSize: stickyFont(item.text ?? "", item.w, item.h) }}>
              {item.text}
            </div>
          )}
          {item.author && <div className="cv-sticky-author">{item.author}</div>}
        </div>
      );
    case "text":
      return (
        <div className="cv-item cv-text" data-id={item.id} style={style}>
          {editing ? <Editor item={item} onDone={onEditDone} /> : <div className="cv-text-body">{item.text || " "}</div>}
        </div>
      );
    case "rect":
    case "ellipse":
      return (
        <div className={`cv-item cv-shape cv-${item.kind} cv-c-${color}`} data-id={item.id} style={style}>
          {editing ? <Editor item={item} onDone={onEditDone} /> : item.text && <div className="cv-shape-text">{item.text}</div>}
        </div>
      );
    case "pen": {
      const pts = (item.points ?? []) as Pt[];
      const d = pathOf(pts);
      return (
        <div className="cv-item cv-pen" style={style}>
          <svg width={item.w} height={item.h} viewBox={`0 0 ${item.w} ${item.h}`} overflow="visible">
            <path className="cv-hit" data-id={item.id} d={d} />
            <path className="cv-pen-path" d={d} style={item.color ? { stroke: `var(--swatch-${item.color})` } : undefined} />
          </svg>
        </div>
      );
    }
    case "image":
      return (
        <div className="cv-item cv-image" data-id={item.id} style={style}>
          {item.src && <img src={item.src} alt="" draggable={false} />}
        </div>
      );
    case "task":
      return (
        <div className="cv-item cv-task" data-id={item.id} style={style}>
          <div className="cv-task-head">
            <TaskStatusIcon status={item.status} />
            <span className="cv-task-key mono">{item.issueKey}</span>
          </div>
          <div className="cv-task-title">{item.text}</div>
        </div>
      );
    case "frame":
      return (
        <div className={`cv-item cv-frame ${entered ? "entered" : ""}`} data-id={item.id} style={style}>
          <FrameHeader item={item} onAction={onFrameAction} />
          <div className="cv-frame-body" data-frame-body={item.id}>
            {renderFrame ? renderFrame(item) : <FramePlaceholder item={item} />}
          </div>
          {!entered && <div className="cv-frame-shield" title={t("canvas.frame.enterHint")} />}
        </div>
      );
    default:
      return null;
  }
});

/* ---------- arrow ---------- */

export const ArrowView = memo(function ArrowView({
  id,
  ax,
  ay,
  bx,
  by,
  draft,
}: {
  id: string;
  ax: number;
  ay: number;
  bx: number;
  by: number;
  draft?: boolean;
}) {
  const pad = 16;
  const x = Math.min(ax, bx) - pad, y = Math.min(ay, by) - pad;
  const w = Math.abs(ax - bx) + pad * 2, h = Math.abs(ay - by) + pad * 2;
  const ang = Math.atan2(by - ay, bx - ax);
  const len = Math.hypot(bx - ax, by - ay);
  const head = Math.min(11, len * 0.4);
  const p = (px: number, py: number) => `${(px - x).toFixed(1)} ${(py - y).toFixed(1)}`;
  const tip: Pt = [bx, by];
  const back: Pt = [bx - Math.cos(ang) * head * 0.7, by - Math.sin(ang) * head * 0.7];
  const l: Pt = [bx - Math.cos(ang - 0.42) * head, by - Math.sin(ang - 0.42) * head];
  const r: Pt = [bx - Math.cos(ang + 0.42) * head, by - Math.sin(ang + 0.42) * head];
  const line = `M${p(ax, ay)}L${p(back[0], back[1])}`;
  return (
    <div className={`cv-item cv-arrow ${draft ? "draft" : ""}`} style={{ transform: `translate(${x}px, ${y}px)`, width: w, height: h }}>
      <svg width={w} height={h}>
        <path className="cv-hit" data-id={id} d={`M${p(ax, ay)}L${p(bx, by)}`} />
        <path className="cv-arrow-line" d={line} />
        <path className="cv-arrow-head" d={`M${p(tip[0], tip[1])}L${p(l[0], l[1])}L${p(back[0], back[1])}L${p(r[0], r[1])}Z`} />
      </svg>
    </div>
  );
});
