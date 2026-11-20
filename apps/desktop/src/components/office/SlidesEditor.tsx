import { ArrowDown, ArrowUp, Circle, Copy, Image as ImageIcon, Play, Plus, Printer, Square, Trash2, Type, Heading } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as Y from "yjs";
import { t, useT } from "../../i18n";
import { Empty } from "../Panel";
import { PopItem, Popover, printOnly } from "./common";
import type { EditorProps } from "./DocPage";
import { shortId, useYVersion } from "./sync";

export type BlockType = "title" | "text" | "image" | "shape";
export interface Block {
  id: string;
  type: BlockType;
  x: number;
  y: number;
  w: number;
  h: number;
  text?: string;
  url?: string;
  shape?: "rect" | "ellipse";
  fill?: string;
  /** Font size in percent of the stage height. */
  size?: number;
}
export interface Slide {
  id: string;
  layout: string;
  blocks: Block[];
}

const FILLS = ["accent", "ink", "mute", "ok", "warn", "fail"];

const LAYOUTS: Record<string, Omit<Block, "id">[]> = {
  title: [
    { type: "title", x: 8, y: 34, w: 84, h: 18, text: "", size: 9 },
    { type: "text", x: 8, y: 54, w: 84, h: 12, text: "", size: 4.5 },
  ],
  content: [
    { type: "title", x: 7, y: 8, w: 86, h: 14, text: "", size: 7 },
    { type: "text", x: 7, y: 26, w: 86, h: 64, text: "", size: 4.2 },
  ],
  blank: [],
};

function readSlides(arr: Y.Array<Y.Map<unknown>>): Slide[] {
  return arr.toArray().map((m) => {
    const blocks = m.get("blocks");
    return {
      id: String(m.get("id") ?? ""),
      layout: String(m.get("layout") ?? "blank"),
      blocks: blocks instanceof Y.Array ? (blocks.toArray() as Y.Map<unknown>[]).map((b) => b.toJSON() as Block) : [],
    };
  });
}

function buildSlide(s: { id?: string; layout: string; blocks: Omit<Block, "id">[] }, fresh = false): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  m.set("id", fresh || !s.id ? shortId() : s.id);
  m.set("layout", s.layout);
  const blocks = new Y.Array<Y.Map<unknown>>();
  blocks.push(
    s.blocks.map((b) => {
      const bm = new Y.Map<unknown>();
      for (const [k, v] of Object.entries({ ...b, id: fresh || !(b as Block).id ? shortId() : (b as Block).id })) if (v !== undefined) bm.set(k, v);
      return bm;
    }),
  );
  m.set("blocks", blocks);
  return m;
}

/** One slide, drawn at the height given as a CSS length. */
export function SlideView({
  slide,
  h,
  selected,
  editing,
  onBlockDown,
  onBlockDouble,
  onText,
  placeholders = false,
}: {
  slide: Slide;
  h: string;
  selected?: string | null;
  editing?: string | null;
  onBlockDown?: (b: Block, e: React.PointerEvent) => void;
  onBlockDouble?: (b: Block) => void;
  onText?: (b: Block, text: string) => void;
  placeholders?: boolean;
}) {
  return (
    <div className="slide" style={{ ["--h" as string]: h }}>
      {slide.blocks.map((b) => (
        <div
          key={b.id}
          className={`slide-block t-${b.type} ${selected === b.id ? "sel" : ""} ${editing === b.id ? "editing" : ""}`}
          style={{ left: `${b.x}%`, top: `${b.y}%`, width: `${b.w}%`, height: `${b.h}%`, fontSize: `calc(var(--h) * ${(b.size ?? 4) / 100})` }}
          onPointerDown={onBlockDown ? (e) => onBlockDown(b, e) : undefined}
          onDoubleClick={onBlockDouble ? () => onBlockDouble(b) : undefined}
        >
          {b.type === "image" ? (
            b.url ? <img src={b.url} alt="" draggable={false} /> : <span className="slide-ph">{t("office.slides.imagePh")}</span>
          ) : b.type === "shape" ? (
            <span className={`slide-shape ${b.shape ?? "rect"} fill-${b.fill ?? "accent"}`} />
          ) : editing === b.id ? (
            <EditableText text={b.text ?? ""} onDone={(s) => onText?.(b, s)} />
          ) : b.text ? (
            <span className="slide-text">{b.text}</span>
          ) : placeholders ? (
            <span className="slide-ph">{b.type === "title" ? t("office.slides.titlePh") : t("office.slides.textPh")}</span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function EditableText({ text, onDone }: { text: string; onDone: (s: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current!;
    el.innerText = text;
    el.focus();
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(false);
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(r);
    // Only on mount: remote edits wait until this one is done.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div
      ref={ref}
      className="slide-text slide-edit"
      contentEditable
      suppressContentEditableWarning
      onPointerDown={(e) => e.stopPropagation()}
      onBlur={(e) => onDone(e.currentTarget.innerText.replace(/\n$/, ""))}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") (e.target as HTMLElement).blur();
      }}
    />
  );
}

export function SlidesEditor({ session, setActions, setTools }: EditorProps) {
  const tr = useT();
  const arr = useMemo(() => session.ydoc.getArray<Y.Map<unknown>>("slides"), [session]);
  const version = useYVersion(arr);
  const slides = useMemo(() => readSlides(arr), [arr, version]);
  const [cur, setCur] = useState(0);
  const [sel, setSel] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [present, setPresent] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState({ w: 800, h: 450 });
  const index = Math.min(cur, Math.max(0, slides.length - 1));
  const slide = slides[index];

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const w = Math.min(el.clientWidth - 64, ((el.clientHeight - 64) * 16) / 9);
      setStage({ w: Math.max(200, w), h: (Math.max(200, w) * 9) / 16 });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const slideMap = (i = index) => arr.get(i);
  const blockMap = (id: string) => {
    const blocks = slideMap()?.get("blocks");
    if (!(blocks instanceof Y.Array)) return null;
    return (blocks.toArray() as Y.Map<unknown>[]).find((b) => b.get("id") === id) ?? null;
  };

  const addSlide = (layout: string) => {
    const at = slides.length ? index + 1 : 0;
    arr.insert(at, [buildSlide({ layout, blocks: LAYOUTS[layout] ?? [] }, true)]);
    setCur(at);
    setSel(null);
  };
  const duplicate = (i: number) => {
    arr.insert(i + 1, [buildSlide(slides[i], true)]);
    setCur(i + 1);
  };
  const remove = (i: number) => {
    arr.delete(i, 1);
    setCur(Math.max(0, i - 1));
    setSel(null);
  };
  const move = (from: number, to: number) => {
    if (to < 0 || to >= slides.length || from === to) return;
    const s = slides[from];
    session.ydoc.transact(() => {
      arr.delete(from, 1);
      arr.insert(to, [buildSlide(s)]);
    });
    setCur(to);
  };
  const addBlock = (b: Omit<Block, "id">) => {
    const blocks = slideMap()?.get("blocks");
    if (!(blocks instanceof Y.Array)) return;
    const id = shortId();
    const m = new Y.Map<unknown>();
    for (const [k, v] of Object.entries({ ...b, id })) if (v !== undefined) m.set(k, v);
    blocks.push([m]);
    setSel(id);
    if (b.type === "text" || b.type === "title") setEditing(id);
  };
  const deleteBlock = (id: string) => {
    const blocks = slideMap()?.get("blocks");
    if (!(blocks instanceof Y.Array)) return;
    const i = (blocks.toArray() as Y.Map<unknown>[]).findIndex((b) => b.get("id") === id);
    if (i >= 0) blocks.delete(i, 1);
    setSel(null);
  };

  // Drag a block to move it; drag its corner to resize.
  const onBlockDown = (b: Block, e: React.PointerEvent, resize = false) => {
    if (editing === b.id) return;
    e.stopPropagation();
    e.preventDefault();
    setSel(b.id);
    setEditing(null);
    const m = blockMap(b.id);
    if (!m) return;
    const x0 = e.clientX;
    const y0 = e.clientY;
    const start = { x: b.x, y: b.y, w: b.w, h: b.h };
    const el = (e.currentTarget as HTMLElement).closest(".slide-block") as HTMLElement | null;
    let last = start;
    const onMove = (ev: PointerEvent) => {
      const dx = ((ev.clientX - x0) / stage.w) * 100;
      const dy = ((ev.clientY - y0) / stage.h) * 100;
      last = resize
        ? { ...start, w: Math.max(4, Math.min(100 - start.x, start.w + dx)), h: Math.max(4, Math.min(100 - start.y, start.h + dy)) }
        : { ...start, x: Math.max(-start.w + 4, Math.min(96, start.x + dx)), y: Math.max(-start.h + 4, Math.min(96, start.y + dy)) };
      if (el) Object.assign(el.style, { left: `${last.x}%`, top: `${last.y}%`, width: `${last.w}%`, height: `${last.h}%` });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (last !== start) {
        const r = (n: number) => Math.round(n * 10) / 10;
        session.ydoc.transact(() => {
          m.set("x", r(last.x));
          m.set("y", r(last.y));
          m.set("w", r(last.w));
          m.set("h", r(last.h));
        });
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const onText = (b: Block, text: string) => {
    setEditing(null);
    if (text !== (b.text ?? "")) blockMap(b.id)?.set("text", text);
  };

  const startPresent = useCallback(() => setPresent(index), [index]);

  useEffect(() => {
    setActions([{ id: "pdf", label: t("office.printPdf"), icon: <Printer size={14} />, run: printOnly }]);
    setTools(
      <button className="btn small office-present-btn" onClick={startPresent}>
        <Play size={13} />
        {t("office.slides.present")}
      </button>,
    );
  }, [setActions, setTools, startPresent]);

  // Keyboard: delete a block, step through slides.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (present !== null || editing) return;
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement).isContentEditable) return;
      if ((e.key === "Delete" || e.key === "Backspace") && sel) {
        e.preventDefault();
        deleteBlock(sel);
      } else if (e.key === "Enter" && sel) {
        const b = slide?.blocks.find((x) => x.id === sel);
        if (b && (b.type === "text" || b.type === "title")) {
          e.preventDefault();
          setEditing(sel);
        }
      } else if (!sel && (e.key === "ArrowDown" || e.key === "ArrowRight")) setCur((c) => Math.min(slides.length - 1, c + 1));
      else if (!sel && (e.key === "ArrowUp" || e.key === "ArrowLeft")) setCur((c) => Math.max(0, c - 1));
      else if (e.key === "Escape") setSel(null);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  const selected = slide?.blocks.find((b) => b.id === sel);
  const selMap = sel ? blockMap(sel) : null;

  return (
    <div className="slides">
      <aside className="slides-rail">
        {slides.map((s, i) => (
          <div
            key={s.id + i}
            className={`slides-thumb ${i === index ? "on" : ""} ${dragOver === i ? "drop" : ""}`}
            draggable
            onDragStart={(e) => e.dataTransfer.setData("text/x-slide", String(i))}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(i);
            }}
            onDragLeave={() => setDragOver(null)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(null);
              const from = Number(e.dataTransfer.getData("text/x-slide"));
              if (!Number.isNaN(from)) move(from, i);
            }}
            onClick={() => {
              setCur(i);
              setSel(null);
              setEditing(null);
            }}
          >
            <span className="slides-num">{i + 1}</span>
            <div className="slides-mini">
              <SlideView slide={s} h="74px" />
            </div>
          </div>
        ))}
        <Popover
          trigger={(_, toggle) => (
            <button className="slides-add" onClick={toggle}>
              <Plus size={14} />
              {tr("office.slides.new")}
            </button>
          )}
        >
          {(close) =>
            Object.keys(LAYOUTS).map((l) => (
              <PopItem
                key={l}
                label={tr(`office.slides.layout.${l}`)}
                onClick={() => {
                  close();
                  addSlide(l);
                }}
              />
            ))
          }
        </Popover>
      </aside>
      <div className="slides-main">
        <div className="sheet-tools slides-tools">
          <button className="icon-btn" title={tr("office.slides.addTitle")} onClick={() => addBlock({ type: "title", x: 10, y: 10, w: 80, h: 14, text: "", size: 7 })} disabled={!slide}>
            <Heading size={15} />
          </button>
          <button className="icon-btn" title={tr("office.slides.addText")} onClick={() => addBlock({ type: "text", x: 10, y: 30, w: 60, h: 20, text: "", size: 4.2 })} disabled={!slide}>
            <Type size={15} />
          </button>
          <button
            className="icon-btn"
            title={tr("office.slides.addImage")}
            disabled={!slide}
            onClick={() => {
              const url = window.prompt(t("office.slides.imageUrl"), "https://");
              if (url && url.trim() !== "https://") addBlock({ type: "image", x: 30, y: 25, w: 40, h: 50, url: url.trim() });
            }}
          >
            <ImageIcon size={15} />
          </button>
          <button className="icon-btn" title={tr("office.slides.addRect")} onClick={() => addBlock({ type: "shape", shape: "rect", x: 40, y: 35, w: 20, h: 30, fill: "accent" })} disabled={!slide}>
            <Square size={15} />
          </button>
          <button className="icon-btn" title={tr("office.slides.addEllipse")} onClick={() => addBlock({ type: "shape", shape: "ellipse", x: 42, y: 32, w: 16, h: 28, fill: "accent" })} disabled={!slide}>
            <Circle size={15} />
          </button>
          {selected && selMap && (
            <>
              <span className="office-tools-sep" />
              {(selected.type === "title" || selected.type === "text") && (
                <>
                  <button className="icon-btn" title={tr("office.slides.smaller")} onClick={() => selMap.set("size", Math.max(1.5, (selected.size ?? 4) - 0.5))}>
                    A-
                  </button>
                  <button className="icon-btn" title={tr("office.slides.bigger")} onClick={() => selMap.set("size", Math.min(20, (selected.size ?? 4) + 0.5))}>
                    A+
                  </button>
                </>
              )}
              {selected.type === "shape" &&
                FILLS.map((f) => (
                  <button key={f} className={`slides-swatch fill-${f} ${selected.fill === f ? "on" : ""}`} onClick={() => selMap.set("fill", f)} title={f} />
                ))}
              {selected.type === "image" && (
                <button
                  className="btn small ghost"
                  onClick={() => {
                    const url = window.prompt(t("office.slides.imageUrl"), selected.url ?? "");
                    if (url !== null) selMap.set("url", url.trim());
                  }}
                >
                  {tr("office.slides.changeImage")}
                </button>
              )}
              <button className="icon-btn" title={tr("office.delete")} onClick={() => deleteBlock(selected.id)}>
                <Trash2 size={15} />
              </button>
            </>
          )}
          <div className="composer-spacer" />
          {slide && (
            <>
              <button className="icon-btn" title={tr("office.slides.moveUp")} onClick={() => move(index, index - 1)} disabled={index === 0}>
                <ArrowUp size={15} />
              </button>
              <button className="icon-btn" title={tr("office.slides.moveDown")} onClick={() => move(index, index + 1)} disabled={index >= slides.length - 1}>
                <ArrowDown size={15} />
              </button>
              <button className="icon-btn" title={tr("office.slides.duplicate")} onClick={() => duplicate(index)}>
                <Copy size={15} />
              </button>
              <button className="icon-btn" title={tr("office.slides.deleteSlide")} onClick={() => remove(index)}>
                <Trash2 size={15} />
              </button>
            </>
          )}
        </div>
        <div
          className="slides-stage"
          ref={stageRef}
          onPointerDown={() => {
            setSel(null);
            setEditing(null);
          }}
        >
          {slide ? (
            <div className="slides-canvas" style={{ width: stage.w, height: stage.h }}>
              <SlideView
                slide={slide}
                h={`${stage.h}px`}
                selected={sel}
                editing={editing}
                placeholders
                onBlockDown={(b, e) => onBlockDown(b, e)}
                onBlockDouble={(b) => (b.type === "text" || b.type === "title") && setEditing(b.id)}
                onText={onText}
              />
              {selected && editing !== selected.id && (
                <span
                  className="slides-handle"
                  style={{ left: `${selected.x + selected.w}%`, top: `${selected.y + selected.h}%` }}
                  onPointerDown={(e) => onBlockDown(selected, e, true)}
                />
              )}
            </div>
          ) : (
            <Empty text={tr("office.slides.empty")} />
          )}
        </div>
      </div>
      <div className="office-print office-print-only slides-print">
        {slides.map((s) => (
          <div key={s.id} className="slides-print-page">
            <SlideView slide={s} h="167mm" />
          </div>
        ))}
      </div>
      {present !== null && slides.length > 0 && <Presenter slides={slides} start={present} onClose={() => setPresent(null)} />}
    </div>
  );
}

function Presenter({ slides, start, onClose }: { slides: Slide[]; start: number; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [i, setI] = useState(start);
  const [h, setH] = useState(window.innerHeight);
  useEffect(() => {
    const el = ref.current!;
    el.requestFullscreen?.().catch(() => {});
    const fit = () => setH(Math.min(window.innerHeight, (window.innerWidth * 9) / 16));
    fit();
    const key = (e: KeyboardEvent) => {
      if (["ArrowRight", "ArrowDown", "PageDown", " ", "Enter"].includes(e.key)) setI((x) => Math.min(slides.length - 1, x + 1));
      else if (["ArrowLeft", "ArrowUp", "PageUp", "Backspace"].includes(e.key)) setI((x) => Math.max(0, x - 1));
      else if (e.key === "Home") setI(0);
      else if (e.key === "End") setI(slides.length - 1);
      else if (e.key === "Escape") onClose();
      else return;
      e.preventDefault();
    };
    const fs = () => !document.fullscreenElement && onClose();
    window.addEventListener("keydown", key);
    window.addEventListener("resize", fit);
    document.addEventListener("fullscreenchange", fs);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("resize", fit);
      document.removeEventListener("fullscreenchange", fs);
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    };
  }, [slides.length, onClose]);
  const s = slides[Math.min(i, slides.length - 1)];
  return (
    <div className="slides-present" ref={ref} onClick={() => setI((x) => Math.min(slides.length - 1, x + 1))}>
      <div style={{ width: (h * 16) / 9, height: h }}>
        <SlideView slide={s} h={`${h}px`} />
      </div>
      <span className="slides-present-count">
        {i + 1} / {slides.length}
      </span>
    </div>
  );
}
