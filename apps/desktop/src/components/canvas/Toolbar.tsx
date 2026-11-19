import { ArrowUpRight, ChevronDown, Circle, Frame, Minus, MousePointer2, Pencil, Plus, Scan, Square, StickyNote, Type } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useT } from "../../i18n";
import { CANVAS_COLORS, type CanvasColor, type Tool } from "./types";

type Slot = "select" | "frame" | "text" | "pen" | "sticky" | "shape" | "arrow";
const slotOf = (t: Tool): Slot => (t === "rect" || t === "ellipse" ? "shape" : t);

function Tip({ label, kbd }: { label: string; kbd?: string }) {
  return (
    <span className="cv-tip" role="tooltip">
      {label}
      {kbd && <kbd>{kbd}</kbd>}
    </span>
  );
}

export function Toolbar({
  tool,
  stickyColor,
  shape,
  onTool,
  onStickyColor,
  onShape,
}: {
  tool: Tool;
  stickyColor: CanvasColor;
  shape: "rect" | "ellipse";
  onTool(t: Tool): void;
  onStickyColor(c: CanvasColor): void;
  onShape(s: "rect" | "ellipse"): void;
}) {
  const t = useT();
  const bar = useRef<HTMLDivElement>(null);
  const refs = useRef<Partial<Record<Slot, HTMLButtonElement | null>>>({});
  const [ind, setInd] = useState<{ x: number; w: number } | null>(null);
  const [animate, setAnimate] = useState(false);
  const [menu, setMenu] = useState<"sticky" | "shape" | null>(null);
  const active = slotOf(tool);

  useLayoutEffect(() => {
    const el = refs.current[active];
    if (el) setInd({ x: el.offsetLeft, w: el.offsetWidth });
  }, [active]);
  useEffect(() => {
    const id = requestAnimationFrame(() => setAnimate(true));
    return () => cancelAnimationFrame(id);
  }, []);
  useEffect(() => {
    if (!menu) return;
    const close = (e: PointerEvent) => !bar.current?.contains(e.target as Node) && setMenu(null);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setMenu(null);
    document.addEventListener("pointerdown", close, true);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", close, true);
      document.removeEventListener("keydown", esc);
    };
  }, [menu]);

  const btn = (slot: Slot, icon: ReactNode, label: string, kbd: string, onClick: () => void) => (
    <button
      type="button"
      ref={(el) => {
        refs.current[slot] = el;
      }}
      className={`cv-tool ${active === slot ? "on" : ""}`}
      aria-pressed={active === slot}
      aria-label={label}
      onClick={onClick}
    >
      {icon}
      {!menu && <Tip label={label} kbd={kbd} />}
    </button>
  );

  const caret = (which: "sticky" | "shape", label: string) => (
    <button
      type="button"
      className={`cv-caret ${menu === which ? "open" : ""}`}
      aria-label={label}
      aria-expanded={menu === which}
      onClick={() => setMenu((m) => (m === which ? null : which))}
    >
      <ChevronDown size={11} />
    </button>
  );

  return (
    <div className="cv-ui cv-toolbar" ref={bar} onPointerDown={(e) => e.stopPropagation()}>
      {ind && <div className={`cv-tool-ind ${animate ? "anim" : ""}`} style={{ transform: `translateX(${ind.x}px)`, width: ind.w }} />}
      {btn("select", <MousePointer2 size={17} />, t("canvas.tool.select"), "V", () => onTool("select"))}
      <span className="cv-tool-sep" />
      {btn("frame", <Frame size={17} />, t("canvas.tool.frame"), "F", () => onTool("frame"))}
      {btn("text", <Type size={17} />, t("canvas.tool.text"), "T", () => onTool("text"))}
      {btn("pen", <Pencil size={17} />, t("canvas.tool.pen"), "P", () => onTool("pen"))}
      <span className="cv-tool-sep" />
      <div className="cv-tool-group">
        {btn(
          "sticky",
          <span className="cv-sticky-ico">
            <StickyNote size={17} />
            <i className={`cv-dot cv-sw-${stickyColor}`} />
          </span>,
          t("canvas.tool.sticky"),
          "S",
          () => onTool("sticky"),
        )}
        {caret("sticky", t("canvas.tool.stickyColor"))}
        {menu === "sticky" && (
          <div className="cv-pop cv-pop-up cv-swatches">
            {CANVAS_COLORS.map((c) => (
              <button
                type="button"
                key={c}
                className={`cv-swatch cv-c-${c} ${c === stickyColor ? "on" : ""}`}
                aria-label={t(`canvas.color.${c}`)}
                title={t(`canvas.color.${c}`)}
                onClick={() => {
                  onStickyColor(c);
                  onTool("sticky");
                  setMenu(null);
                }}
              />
            ))}
          </div>
        )}
      </div>
      <div className="cv-tool-group">
        {btn(
          "shape",
          shape === "ellipse" ? <Circle size={17} /> : <Square size={17} />,
          t(shape === "ellipse" ? "canvas.tool.ellipse" : "canvas.tool.rect"),
          shape === "ellipse" ? "O" : "R",
          () => onTool(shape),
        )}
        {caret("shape", t("canvas.tool.shape"))}
        {menu === "shape" && (
          <div className="cv-pop cv-pop-up cv-shape-menu">
            {(["rect", "ellipse"] as const).map((s) => (
              <button
                type="button"
                key={s}
                className={`cv-pop-item ${shape === s ? "on" : ""}`}
                onClick={() => {
                  onShape(s);
                  onTool(s);
                  setMenu(null);
                }}
              >
                {s === "rect" ? <Square size={15} /> : <Circle size={15} />}
                <span>{t(s === "rect" ? "canvas.tool.rect" : "canvas.tool.ellipse")}</span>
                <kbd>{s === "rect" ? "R" : "O"}</kbd>
              </button>
            ))}
          </div>
        )}
      </div>
      {btn("arrow", <ArrowUpRight size={17} />, t("canvas.tool.arrow"), "A", () => onTool("arrow"))}
    </div>
  );
}

export function ZoomControl({ zoom, onZoom, onFit, onReset }: { zoom: number; onZoom(dir: 1 | -1): void; onFit(): void; onReset(): void }) {
  const t = useT();
  return (
    <div className="cv-ui cv-zoom" onPointerDown={(e) => e.stopPropagation()}>
      <button type="button" className="cv-zoom-btn" aria-label={t("canvas.zoom.out")} onClick={() => onZoom(-1)}>
        <Minus size={14} />
        <Tip label={t("canvas.zoom.out")} kbd="⌘−" />
      </button>
      <button type="button" className="cv-zoom-val num" onClick={onReset}>
        {Math.round(zoom * 100)}%
        <Tip label={t("canvas.zoom.reset")} kbd="⇧0" />
      </button>
      <button type="button" className="cv-zoom-btn" aria-label={t("canvas.zoom.in")} onClick={() => onZoom(1)}>
        <Plus size={14} />
        <Tip label={t("canvas.zoom.in")} kbd="⌘+" />
      </button>
      <span className="cv-tool-sep" />
      <button type="button" className="cv-zoom-btn" aria-label={t("canvas.zoom.fit")} onClick={onFit}>
        <Scan size={14} />
        <Tip label={t("canvas.zoom.fit")} kbd="⇧1" />
      </button>
    </div>
  );
}
