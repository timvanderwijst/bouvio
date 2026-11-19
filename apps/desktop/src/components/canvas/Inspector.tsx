import { ArrowUpRight, Circle, Layers, Frame, Image, Pencil, Square, SquareCheck, StickyNote, Type } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useT } from "../../i18n";
import type { MessageKey } from "../../i18n/en";
import { Menu } from "../Menu";
import { TaskStatusIcon, frameIcon } from "./items";
import { CANVAS_COLORS, type CanvasFrame, type CanvasItem, type ItemKind } from "./types";

const KIND_ICON: Record<ItemKind, ReactNode> = {
  sticky: <StickyNote size={14} />,
  text: <Type size={14} />,
  rect: <Square size={14} />,
  ellipse: <Circle size={14} />,
  arrow: <ArrowUpRight size={14} />,
  pen: <Pencil size={14} />,
  frame: <Frame size={14} />,
  image: <Image size={14} />,
  task: <SquareCheck size={14} />,
};

const STATUSES = ["backlog", "todo", "in_progress", "done", "canceled"] as const;

/** One shared value across the selection, or undefined when mixed. */
function common<T>(items: CanvasItem[], f: (i: CanvasItem) => T): T | undefined {
  if (!items.length) return undefined;
  const v = f(items[0]);
  return items.every((i) => f(i) === v) ? v : undefined;
}

const fmt = (v: number | undefined) => (v === undefined ? "" : String(Math.round(v * 10) / 10));

/** A compact numeric field; drag its letter to scrub, arrows to step (shift = 10). */
function NumField({ label, value, onCommit, suffix }: { label: string; value: number | undefined; onCommit(v: number): void; suffix?: string }) {
  const t = useT();
  const [text, setText] = useState(fmt(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(fmt(value));
  }, [value]);

  const commit = (s: string) => {
    const n = Number(s.replace(",", "."));
    if (Number.isFinite(n) && s.trim() !== "") onCommit(n);
    else setText(fmt(value));
  };

  const scrub = (e: React.PointerEvent<HTMLSpanElement>) => {
    if (value === undefined) return;
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const x0 = e.clientX, v0 = value;
    const move = (ev: PointerEvent) => onCommit(Math.round(v0 + (ev.clientX - x0) * (ev.shiftKey ? 10 : 1)));
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  return (
    <label className="ci-field">
      <span className="ci-prefix" onPointerDown={scrub}>
        {label}
      </span>
      <input
        className="num"
        inputMode="decimal"
        value={text}
        placeholder={value === undefined ? t("canvas.inspector.mixed") : undefined}
        onFocus={(e) => {
          focused.current = true;
          e.currentTarget.select();
        }}
        onBlur={(e) => {
          focused.current = false;
          commit(e.currentTarget.value);
        }}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            setText(fmt(value));
            e.currentTarget.blur();
          }
          if ((e.key === "ArrowUp" || e.key === "ArrowDown") && value !== undefined) {
            e.preventDefault();
            const n = value + (e.key === "ArrowUp" ? 1 : -1) * (e.shiftKey ? 10 : 1);
            setText(fmt(n));
            onCommit(n);
          }
        }}
      />
      {suffix && <span className="ci-suffix">{suffix}</span>}
    </label>
  );
}

function TextField({ value, placeholder, onCommit, mono, multiline }: { value: string | undefined; placeholder?: string; onCommit(v: string): void; mono?: boolean; multiline?: boolean }) {
  const [text, setText] = useState(value ?? "");
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(value ?? "");
  }, [value]);
  const props = {
    className: `ci-input ${mono ? "mono" : ""}`,
    value: text,
    placeholder,
    spellCheck: false,
    onFocus: () => (focused.current = true),
    onBlur: () => {
      focused.current = false;
      if (text !== (value ?? "")) onCommit(text);
    },
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setText(e.target.value),
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      e.stopPropagation();
      if (e.key === "Escape") {
        setText(value ?? "");
        (e.currentTarget as HTMLElement).blur();
      }
      if (e.key === "Enter" && (!multiline || e.metaKey || e.ctrlKey)) (e.currentTarget as HTMLElement).blur();
    },
  };
  return multiline ? <textarea rows={3} {...props} /> : <input {...props} />;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="ci-section">
      <h4 className="ci-title">{title}</h4>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="ci-row">
      <span className="ci-label">{label}</span>
      <div className="ci-value">{children}</div>
    </div>
  );
}

/** Properties for the canvas selection. Pass the selected items; receive their updated versions. */
export function Inspector({ items, onChange }: { items: CanvasItem[]; onChange(items: CanvasItem[]): void }) {
  const t = useT();
  const set = (f: (i: CanvasItem) => CanvasItem) => onChange(items.map(f));

  if (!items.length) {
    return (
      <div className="ci-root">
        <div className="ci-head">
          <span className="ci-head-title">{t("canvas.inspector.title")}</span>
        </div>
        <div className="ci-empty">{t("canvas.inspector.empty")}</div>
      </div>
    );
  }

  const kind = common(items, (i) => i.kind);
  const one = items.length === 1 ? items[0] : null;
  const isColorable = (i: CanvasItem) => i.kind === "sticky" || i.kind === "rect" || i.kind === "ellipse" || i.kind === "pen";
  const colorable = items.some(isColorable);
  const boxed = items.filter((i) => i.kind !== "arrow");
  const textual = items.every((i) => i.kind === "sticky" || i.kind === "text" || i.kind === "rect" || i.kind === "ellipse" || i.kind === "task");
  const color = common(items.filter(isColorable), (i) => i.color ?? (i.kind === "sticky" ? "yellow" : i.kind === "pen" ? undefined : "grey"));
  const positional = boxed.length > 0;
  /** Apply to the items that have a box (arrows follow their anchors). */
  const setBoxed = (f: (i: CanvasItem) => CanvasItem) => set((i) => (i.kind === "arrow" ? i : f(i)));
  const setFrame = (patch: Partial<CanvasFrame>) =>
    set((i) => (i.frame ? { ...i, frame: { ...i.frame, ...patch } } : i));

  return (
    <div className="ci-root">
      <div className="ci-head">
        <span className="ci-head-icon">{kind ? (kind === "frame" && one ? frameIcon(one.frame?.kind, 14) : KIND_ICON[kind]) : <Layers size={14} />}</span>
        <span className="ci-head-title truncate">
          {one ? (one.kind === "frame" ? one.frame?.label || t("canvas.frame.untitled") : t(`canvas.kind.${one.kind}` as MessageKey)) : t("canvas.inspector.selection", { count: items.length })}
        </span>
        {one?.author && <span className="ci-head-meta truncate">{one.author}</span>}
      </div>

      {positional && (
        <Section title={t("canvas.inspector.layout")}>
          <Row label={t("canvas.inspector.position")}>
            <NumField label="X" value={common(boxed, (i) => i.x)} onCommit={(v) => setBoxed((i) => ({ ...i, x: v }))} />
            <NumField label="Y" value={common(boxed, (i) => i.y)} onCommit={(v) => setBoxed((i) => ({ ...i, y: v }))} />
          </Row>
          <Row label={t("canvas.inspector.size")}>
            <NumField label="W" value={common(boxed, (i) => i.w)} onCommit={(v) => setBoxed((i) => ({ ...i, w: Math.max(4, v) }))} />
            <NumField label="H" value={common(boxed, (i) => i.h)} onCommit={(v) => setBoxed((i) => ({ ...i, h: Math.max(4, v) }))} />
          </Row>
          <Row label={t("canvas.inspector.rotation")}>
            <NumField label="°" value={common(boxed, (i) => i.rotation ?? 0)} onCommit={(v) => setBoxed((i) => ({ ...i, rotation: ((v % 360) + 360) % 360 || undefined }))} />
            <span className="ci-spacer" />
          </Row>
        </Section>
      )}

      {colorable && (
        <Section title={t("canvas.inspector.color")}>
          <div className="ci-swatches">
            {CANVAS_COLORS.map((c) => (
              <button
                type="button"
                key={c}
                className={`cv-swatch cv-c-${c} ${color === c ? "on" : ""}`}
                aria-label={t(`canvas.color.${c}`)}
                title={t(`canvas.color.${c}`)}
                onClick={() => set((i) => (isColorable(i) ? { ...i, color: c } : i))}
              />
            ))}
          </div>
        </Section>
      )}

      {textual && (
        <Section title={t(kind === "task" ? "canvas.inspector.task" : "canvas.inspector.text")}>
          {kind === "task" && one && (
            <>
              <Row label={t("canvas.inspector.issueKey")}>
                <TextField value={one.issueKey} mono onCommit={(v) => set((i) => ({ ...i, issueKey: v }))} />
              </Row>
              <Row label={t("canvas.inspector.status")}>
                <Menu
                  value={(one.status ?? "todo") as (typeof STATUSES)[number]}
                  items={STATUSES.map((s) => ({ value: s, label: t(`canvas.status.${s}`), icon: <TaskStatusIcon status={s} /> }))}
                  onChange={(s) => set((i) => ({ ...i, status: s }))}
                />
              </Row>
            </>
          )}
          <TextField value={common(items, (i) => i.text ?? "")} multiline placeholder={common(items, (i) => i.text ?? "") === undefined ? t("canvas.inspector.mixed") : undefined} onCommit={(v) => set((i) => ({ ...i, text: v }))} />
        </Section>
      )}

      {kind === "frame" && one?.frame && (
        <Section title={t("canvas.inspector.source")}>
          <Row label={t("canvas.inspector.kind")}>
            <div className="ci-seg">
              {(["url", "artifact", "thread"] as const).map((k) => (
                <button type="button" key={k} className={one.frame!.kind === k ? "on" : ""} onClick={() => setFrame({ kind: k })}>
                  {t(`canvas.frame.kind.${k}`)}
                </button>
              ))}
            </div>
          </Row>
          <Row label={t("canvas.inspector.label")}>
            <TextField value={one.frame.label} placeholder={t("canvas.frame.untitled")} onCommit={(v) => setFrame({ label: v })} />
          </Row>
          <Row label={one.frame.kind === "url" ? t("canvas.inspector.url") : t("canvas.inspector.source")}>
            <TextField value={one.frame.src} mono placeholder="http://localhost:5173/" onCommit={(v) => setFrame({ src: v })} />
          </Row>
          {one.frame.kind === "url" && (
            <Row label={t("canvas.inspector.branch")}>
              <TextField value={one.frame.branch} mono placeholder="main" onCommit={(v) => setFrame({ branch: v || undefined })} />
            </Row>
          )}
          {one.frame.kind === "thread" && (
            <Row label={t("canvas.inspector.thread")}>
              <TextField value={one.frame.threadId} mono onCommit={(v) => setFrame({ threadId: v || undefined })} />
            </Row>
          )}
        </Section>
      )}

      {kind === "image" && one && (
        <Section title={t("canvas.inspector.source")}>
          <Row label={t("canvas.inspector.url")}>
            <TextField value={one.src} mono onCommit={(v) => set((i) => ({ ...i, src: v }))} />
          </Row>
        </Section>
      )}
    </div>
  );
}
