import { useEffect, useRef } from "react";
import type { CanvasCamera, RemoteCursor } from "./types";

const reduced = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Teammates' pointers: a coloured arrow and a name pill. Positions ease toward the
 * latest sample every frame (written straight to the DOM, no React render per frame),
 * so a 30 Hz feed still glides.
 */
export function Cursors({ cursors, camera }: { cursors: RemoteCursor[]; camera: CanvasCamera }) {
  const els = useRef(new Map<string, HTMLDivElement>());
  const shown = useRef(new Map<string, { x: number; y: number }>());
  const target = useRef(cursors);
  const cam = useRef(camera);
  target.current = cursors;
  cam.current = camera;

  useEffect(() => {
    if (!cursors.length) return;
    let raf = 0;
    let last = performance.now();
    const snap = reduced();
    const tick = (now: number) => {
      const dt = Math.min(64, now - last);
      last = now;
      const k = snap ? 1 : 1 - Math.exp(-dt / 70);
      const c = cam.current;
      for (const cur of target.current) {
        const el = els.current.get(cur.id);
        if (!el) continue;
        let p = shown.current.get(cur.id);
        if (!p) {
          p = { x: cur.x, y: cur.y };
          shown.current.set(cur.id, p);
        }
        p.x += (cur.x - p.x) * k;
        p.y += (cur.y - p.y) * k;
        el.style.transform = `translate(${(p.x * c.zoom + c.x).toFixed(1)}px, ${(p.y * c.zoom + c.y).toFixed(1)}px)`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [cursors.length]);

  return (
    <div className="cv-cursors" aria-hidden>
      {cursors.map((c) => (
        <div
          key={c.id}
          className="cv-cursor"
          ref={(el) => {
            if (el) els.current.set(c.id, el);
            else {
              els.current.delete(c.id);
              shown.current.delete(c.id);
            }
          }}
          style={{ ["--cc" as string]: c.color }}
        >
          <svg width="18" height="20" viewBox="0 0 18 20">
            <path d="M2.2 1.6l13 7.3c.7.4.6 1.4-.2 1.6l-5.4 1.4-2.6 5.2c-.4.7-1.4.6-1.6-.2L1 2.6c-.2-.8.6-1.4 1.2-1z" />
          </svg>
          <span className="cv-cursor-name">{c.name}</span>
        </div>
      ))}
    </div>
  );
}
