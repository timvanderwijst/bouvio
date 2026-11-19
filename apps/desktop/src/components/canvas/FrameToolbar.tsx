import { ChevronDown, CopyPlus, ExternalLink, Monitor, Moon, RotateCw, Smartphone, SquareDashedMousePointer, Sun, Tablet } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import type { CanvasItem, FrameAction } from "./types";

export const DEVICES = {
  desktop: { w: 1280, h: 800 },
  tablet: { w: 834, h: 1112 },
  phone: { w: 390, h: 844 },
} as const;
export type Device = keyof typeof DEVICES;

export function deviceOf(item: CanvasItem): Device | null {
  for (const [k, v] of Object.entries(DEVICES)) if (Math.round(item.w) === v.w && Math.round(item.h) === v.h) return k as Device;
  return null;
}

const DEVICE_ICON = { desktop: Monitor, tablet: Tablet, phone: Smartphone };

/** Floating toolbar above a selected frame. */
export function FrameToolbar({
  item,
  left,
  top,
  entered,
  onAction,
  onDevice,
  onTheme,
}: {
  item: CanvasItem;
  left: number;
  top: number;
  entered: boolean;
  onAction(a: FrameAction): void;
  onDevice(d: Device): void;
  onTheme(): void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const dev = deviceOf(item);
  const DevIcon = DEVICE_ICON[dev ?? "desktop"];
  const dark = item.frame?.theme === "dark";

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("pointerdown", close, true);
    return () => document.removeEventListener("pointerdown", close, true);
  }, [open]);

  const icon = (label: string, node: React.ReactNode, onClick: () => void, kbd?: string) => (
    <button type="button" className="cv-ft-btn" aria-label={label} onClick={onClick}>
      {node}
      {!open && (
        <span className="cv-tip down" role="tooltip">
          {label}
          {kbd && <kbd>{kbd}</kbd>}
        </span>
      )}
    </button>
  );

  return (
    <div className="cv-ui cv-frame-toolbar" ref={ref} style={{ left, top }} onPointerDown={(e) => e.stopPropagation()}>
      {entered ? (
        <span className="cv-ft-hint">{t("canvas.frame.exitHint")}</span>
      ) : (
        icon(t("canvas.frame.inspect"), <SquareDashedMousePointer size={15} />, () => onAction("inspect"))
      )}
      <div className="cv-ft-dev">
        <button type="button" className={`cv-ft-btn wide ${open ? "open" : ""}`} aria-label={t("canvas.frame.device")} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <DevIcon size={15} />
          <ChevronDown size={11} className="cv-ft-chev" />
          {!open && (
            <span className="cv-tip down" role="tooltip">
              {t("canvas.frame.device")}
            </span>
          )}
        </button>
        {open && (
          <div className="cv-pop cv-pop-down">
            {(Object.keys(DEVICES) as Device[]).map((d) => {
              const I = DEVICE_ICON[d];
              return (
                <button
                  type="button"
                  key={d}
                  className={`cv-pop-item ${dev === d ? "on" : ""}`}
                  onClick={() => {
                    onDevice(d);
                    setOpen(false);
                  }}
                >
                  <I size={15} />
                  <span>{t(`canvas.frame.${d}`)}</span>
                  <kbd className="num">
                    {DEVICES[d].w}×{DEVICES[d].h}
                  </kbd>
                </button>
              );
            })}
          </div>
        )}
      </div>
      {icon(t("canvas.frame.theme"), dark ? <Moon size={15} /> : <Sun size={15} />, onTheme)}
      <span className="cv-tool-sep" />
      {icon(t("canvas.frame.reload"), <RotateCw size={15} />, () => onAction("reload"))}
      {icon(t("canvas.frame.open"), <ExternalLink size={15} />, () => onAction("open"))}
      <button type="button" className="cv-ft-variant" onClick={() => onAction("variant")}>
        <CopyPlus size={14} />
        <span>{t("canvas.frame.variant")}</span>
      </button>
    </div>
  );
}
