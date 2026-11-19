import type { CanvasCamera, CanvasItem } from "./types";

export type Pt = [number, number];
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
export type Patch = Map<string, CanvasItem | null>;
export type Getter = (id: string) => CanvasItem | undefined;

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 4;

export const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
export const clampZoom = (z: number) => clamp(z, MIN_ZOOM, MAX_ZOOM);

export function uid(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
}

export const center = (b: Box): Pt => [b.x + b.w / 2, b.y + b.h / 2];

export function union(boxes: Box[]): Box | null {
  if (!boxes.length) return null;
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const b of boxes) {
    x1 = Math.min(x1, b.x);
    y1 = Math.min(y1, b.y);
    x2 = Math.max(x2, b.x + b.w);
    y2 = Math.max(y2, b.y + b.h);
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

export const intersects = (a: Box, b: Box) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
export const contains = (a: Box, b: Box) => b.x >= a.x && b.y >= a.y && b.x + b.w <= a.x + a.w && b.y + b.h <= a.y + a.h;

export function boxFrom(a: Pt, b: Pt): Box {
  return { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(a[0] - b[0]), h: Math.abs(a[1] - b[1]) };
}

/** Where a ray from the item's centre toward `toward` leaves its outline (plus a little gap). */
function clipTo(item: CanvasItem, toward: Pt, pad: number): Pt {
  const [cx, cy] = center(item);
  const dx = toward[0] - cx, dy = toward[1] - cy;
  if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return [cx, cy];
  const rx = item.w / 2 + pad, ry = item.h / 2 + pad;
  const t =
    item.kind === "ellipse"
      ? 1 / Math.sqrt((dx / rx) ** 2 + (dy / ry) ** 2)
      : Math.min(Math.abs(dx) > 1e-6 ? rx / Math.abs(dx) : Infinity, Math.abs(dy) > 1e-6 ? ry / Math.abs(dy) : Infinity);
  if (t >= 1) return [cx, cy];
  return [cx + dx * t, cy + dy * t];
}

/** Absolute endpoints of an arrow, following the items it is bound to. */
export function resolveArrow(item: CanvasItem, get: Getter): { a: Pt; b: Pt } {
  const pts = item.points && item.points.length >= 2 ? item.points : ([[0, 0], [item.w, item.h]] as Pt[]);
  let a: Pt = [item.x + pts[0][0], item.y + pts[0][1]];
  let b: Pt = [item.x + pts[pts.length - 1][0], item.y + pts[pts.length - 1][1]];
  const fa = item.from ? get(item.from) : undefined;
  const fb = item.to ? get(item.to) : undefined;
  const ca = fa ? center(fa) : a;
  const cb = fb ? center(fb) : b;
  if (fa) a = clipTo(fa, cb, 8);
  if (fb) b = clipTo(fb, ca, 8);
  return { a, b };
}

export function arrowAt(base: CanvasItem, a: Pt, b: Pt): CanvasItem {
  const x = Math.min(a[0], b[0]), y = Math.min(a[1], b[1]);
  return {
    ...base,
    x,
    y,
    w: Math.max(1, Math.abs(a[0] - b[0])),
    h: Math.max(1, Math.abs(a[1] - b[1])),
    points: [
      [a[0] - x, a[1] - y],
      [b[0] - x, b[1] - y],
    ],
  };
}

export function boundsOf(item: CanvasItem, get: Getter): Box {
  if (item.kind === "arrow") {
    const { a, b } = resolveArrow(item, get);
    return boxFrom(a, b);
  }
  return { x: item.x, y: item.y, w: item.w, h: item.h };
}

export function applyPatch(items: CanvasItem[], patch: Patch | null): CanvasItem[] {
  if (!patch || patch.size === 0) return items;
  const out: CanvasItem[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    seen.add(it.id);
    if (patch.has(it.id)) {
      const n = patch.get(it.id);
      if (n) out.push(n);
    } else out.push(it);
  }
  for (const [id, n] of patch) if (n && !seen.has(id)) out.push(n);
  return out;
}

/* ---------- pen ---------- */

/** Two passes of a [1 2 1] kernel: removes hand jitter, keeps endpoints. */
export function smooth(pts: Pt[]): Pt[] {
  let p = pts;
  for (let pass = 0; pass < 2; pass++) {
    if (p.length < 3) return p;
    const n: Pt[] = [p[0]];
    for (let i = 1; i < p.length - 1; i++) {
      n.push([(p[i - 1][0] + 2 * p[i][0] + p[i + 1][0]) / 4, (p[i - 1][1] + 2 * p[i][1] + p[i + 1][1]) / 4]);
    }
    n.push(p[p.length - 1]);
    p = n;
  }
  return p;
}

/** Quadratic curves through midpoints: a soft path without overshoot. */
export function pathOf(pts: Pt[]): string {
  if (!pts.length) return "";
  const f = (v: number) => Math.round(v * 10) / 10;
  if (pts.length < 3) {
    const [a, b = [a[0] + 0.01, a[1]]] = pts;
    return `M${f(a[0])} ${f(a[1])}L${f(b[0])} ${f(b[1])}`;
  }
  let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
    d += `Q${f(pts[i][0])} ${f(pts[i][1])} ${f(mx)} ${f(my)}`;
  }
  const l = pts[pts.length - 1];
  return d + `L${f(l[0])} ${f(l[1])}`;
}

export const PEN_PAD = 4;

export function penItem(base: CanvasItem, abs: Pt[]): CanvasItem {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const [x, y] of abs) {
    x1 = Math.min(x1, x);
    y1 = Math.min(y1, y);
    x2 = Math.max(x2, x);
    y2 = Math.max(y2, y);
  }
  x1 -= PEN_PAD;
  y1 -= PEN_PAD;
  x2 += PEN_PAD;
  y2 += PEN_PAD;
  return { ...base, x: x1, y: y1, w: x2 - x1, h: y2 - y1, points: abs.map(([x, y]) => [x - x1, y - y1]) };
}

/* ---------- snapping ---------- */

export interface SnapLine {
  v: number;
  box: Box;
}
export interface Guide {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export function snapLines(boxes: Box[]) {
  const xs: SnapLine[] = [], ys: SnapLine[] = [];
  for (const b of boxes) {
    xs.push({ v: b.x, box: b }, { v: b.x + b.w / 2, box: b }, { v: b.x + b.w, box: b });
    ys.push({ v: b.y, box: b }, { v: b.y + b.h / 2, box: b }, { v: b.y + b.h, box: b });
  }
  return { xs, ys };
}

function best(edges: number[], lines: SnapLine[], thr: number): number | null {
  let d: number | null = null;
  for (const e of edges) for (const l of lines) {
    const k = l.v - e;
    if (Math.abs(k) <= thr && (d === null || Math.abs(k) < Math.abs(d))) d = k;
  }
  return d;
}

/** Snap a moving box to the edges and centres of others; returns the correction and guides to draw. */
export function snap(b: Box, lines: { xs: SnapLine[]; ys: SnapLine[] }, thr: number) {
  const ex = [b.x, b.x + b.w / 2, b.x + b.w];
  const ey = [b.y, b.y + b.h / 2, b.y + b.h];
  const dx = best(ex, lines.xs, thr) ?? 0;
  const dy = best(ey, lines.ys, thr) ?? 0;
  const s: Box = { x: b.x + dx, y: b.y + dy, w: b.w, h: b.h };
  const guides: Guide[] = [];
  const sx = [s.x, s.x + s.w / 2, s.x + s.w], sy = [s.y, s.y + s.h / 2, s.y + s.h];
  for (const l of lines.xs) if (sx.some((e) => Math.abs(e - l.v) < 0.5)) {
    guides.push({ x1: l.v, x2: l.v, y1: Math.min(s.y, l.box.y), y2: Math.max(s.y + s.h, l.box.y + l.box.h) });
  }
  for (const l of lines.ys) if (sy.some((e) => Math.abs(e - l.v) < 0.5)) {
    guides.push({ y1: l.v, y2: l.v, x1: Math.min(s.x, l.box.x), x2: Math.max(s.x + s.w, l.box.x + l.box.w) });
  }
  return { dx, dy, guides };
}

/* ---------- camera ---------- */

export function fitCamera(b: Box, vw: number, vh: number, pad = 96, maxZoom = 1): CanvasCamera {
  const zoom = clampZoom(Math.min((vw - pad * 2) / Math.max(b.w, 1), (vh - pad * 2) / Math.max(b.h, 1), maxZoom));
  return { zoom, x: vw / 2 - (b.x + b.w / 2) * zoom, y: vh / 2 - (b.y + b.h / 2) * zoom };
}

export function zoomAround(cam: CanvasCamera, sx: number, sy: number, zoom: number): CanvasCamera {
  const z = clampZoom(zoom);
  return { zoom: z, x: sx - (sx - cam.x) * (z / cam.zoom), y: sy - (sy - cam.y) * (z / cam.zoom) };
}

const fontCache = new Map<string, number>();

/**
 * Font size for a sticky so its text fills the note without overflowing:
 * the largest size at which a word-wrap estimate still fits the note.
 */
export function stickyFont(text: string, w: number, h: number): number {
  const key = `${Math.round(w)}|${Math.round(h)}|${text}`;
  const hit = fontCache.get(key);
  if (hit) return hit;
  const aw = Math.max(w - 32, 10), ah = Math.max(h - 48, 10);
  const paras = (text || "Write an idea").split("\n").map((p) => p.split(/\s+/).filter(Boolean));
  let size = 12;
  for (let fs = 30; fs >= 12; fs--) {
    const max = Math.max(1, Math.floor(aw / (fs * 0.57)));
    let lines = 0;
    for (const words of paras) {
      let cur = 0;
      lines++;
      for (const word of words) {
        const len = word.length;
        if (cur === 0) cur = len;
        else if (cur + 1 + len <= max) cur += 1 + len;
        else {
          lines++;
          cur = len;
        }
        while (cur > max) {
          lines++;
          cur -= max;
        }
      }
    }
    if (lines * fs * 1.3 <= ah) {
      size = fs;
      break;
    }
  }
  if (fontCache.size > 2000) fontCache.clear();
  fontCache.set(key, size);
  return size;
}

/** Does segment a-b touch the box? (For marquee-selecting arrows.) */
export function segmentHitsBox(a: Pt, b: Pt, box: Box): boolean {
  const inside = (p: Pt) => p[0] >= box.x && p[0] <= box.x + box.w && p[1] >= box.y && p[1] <= box.y + box.h;
  if (inside(a) || inside(b)) return true;
  const x1 = box.x, y1 = box.y, x2 = box.x + box.w, y2 = box.y + box.h;
  const edges: [Pt, Pt][] = [
    [[x1, y1], [x2, y1]],
    [[x2, y1], [x2, y2]],
    [[x2, y2], [x1, y2]],
    [[x1, y2], [x1, y1]],
  ];
  const cross = (o: Pt, p: Pt, q: Pt) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  return edges.some(([c, d]) => cross(a, b, c) * cross(a, b, d) <= 0 && cross(c, d, a) * cross(c, d, b) <= 0);
}
