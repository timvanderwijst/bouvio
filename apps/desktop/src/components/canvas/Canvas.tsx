import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Cursors } from "./Cursors";
import { DEVICES, FrameToolbar, type Device } from "./FrameToolbar";
import {
  applyPatch,
  arrowAt,
  boundsOf,
  boxFrom,
  clamp,
  contains,
  fitCamera,
  intersects,
  penItem,
  resolveArrow,
  smooth,
  snap,
  snapLines,
  uid,
  union,
  zoomAround,
  type Box,
  type Getter,
  type Guide,
  type Patch,
  type Pt,
} from "./geom";
import { ArrowView, ItemView } from "./items";
import { Toolbar, ZoomControl } from "./Toolbar";
import type { CanvasCamera, CanvasColor, CanvasDoc, CanvasItem, CanvasProps, FrameAction, Tool } from "./types";
import "./canvas.css";

type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

type Gesture =
  | { kind: "pan"; sx: number; sy: number; cam: CanvasCamera }
  | {
      kind: "move";
      start: Pt;
      sx: number;
      sy: number;
      ids: string[];
      orig: Map<string, CanvasItem>;
      lines: ReturnType<typeof snapLines>;
      box: Box;
      moved: boolean;
      dup: boolean;
      selectOnly: string | null;
    }
  | { kind: "resize"; handle: Handle; start: Pt; orig: CanvasItem[]; box: Box }
  | { kind: "marquee"; start: Pt; base: Set<string> }
  | { kind: "create"; tool: Tool; start: Pt; sx: number; sy: number; id: string; dragged: boolean }
  | { kind: "pen"; pts: Pt[]; id: string }
  | { kind: "arrow"; start: Pt; from?: string; id: string };

interface History {
  past: { before: Patch; after: Patch }[];
  future: { before: Patch; after: Patch }[];
}

const DEFAULT_SIZE: Record<string, [number, number]> = {
  sticky: [180, 180],
  text: [240, 28],
  rect: [160, 110],
  ellipse: [140, 140],
  frame: [1280, 800],
};

const isEditable = (t: EventTarget | null) => t instanceof HTMLElement && !!t.closest("textarea, input, select, [contenteditable='true']");
const reducedMotion = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

let clipboard: CanvasItem[] = [];

interface GestureEvent extends UIEvent {
  scale: number;
  clientX: number;
  clientY: number;
}

/* ---------- items layer: only re-renders when items change, not on pan/zoom ---------- */

const ItemsLayer = memo(function ItemsLayer({
  items,
  get,
  editing,
  entered,
  renderFrame,
  onEditDone,
  onFrameAction,
  draftArrow,
}: {
  items: CanvasItem[];
  get: Getter;
  editing: string | null;
  entered: string | null;
  renderFrame?: (item: CanvasItem) => ReactNode;
  onEditDone(id: string, text: string, h?: number): void;
  onFrameAction(item: CanvasItem, a: FrameAction): void;
  draftArrow: string | null;
}) {
  return (
    <>
      {items.map((it) => {
        if (it.kind === "arrow") {
          const { a, b } = resolveArrow(it, get);
          return <ArrowView key={it.id} id={it.id} ax={a[0]} ay={a[1]} bx={b[0]} by={b[1]} draft={draftArrow === it.id} />;
        }
        return (
          <ItemView
            key={it.id}
            item={it}
            editing={editing === it.id}
            entered={entered === it.id}
            renderFrame={it.kind === "frame" ? renderFrame : undefined}
            onEditDone={onEditDone}
            onFrameAction={onFrameAction}
          />
        );
      })}
    </>
  );
});

/* ---------- canvas ---------- */

export function Canvas({ doc, onChange, cursors, onCursor, me, onSelectionChange, renderFrame, onFrameAction }: CanvasProps) {
  // The document we render: the caller's doc, plus our own commits until the caller echoes them back.
  const [local, setLocal] = useState<CanvasDoc>(doc);
  const [seen, setSeen] = useState<CanvasDoc>(doc);
  if (doc !== seen) {
    setSeen(doc);
    setLocal(doc);
  }
  const [draft, setDraft] = useState<Patch | null>(null);
  const [cam, setCamState] = useState<CanvasCamera>(doc.camera ?? { x: 0, y: 0, zoom: 1 });
  const [selection, setSelection] = useState<Set<string>>(() => new Set());
  const [tool, setTool] = useState<Tool>("select");
  const [stickyColor, setStickyColor] = useState<CanvasColor>("yellow");
  const [shape, setShape] = useState<"rect" | "ellipse">("rect");
  const [editing, setEditing] = useState<string | null>(null);
  const [entered, setEntered] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [marquee, setMarquee] = useState<Box | null>(null);
  const [guides, setGuides] = useState<Guide[] | null>(null);
  const [gestureKind, setGestureKind] = useState<Gesture["kind"] | null>(null);
  const [space, setSpace] = useState(false);
  const [moving, setMoving] = useState(false);
  const [size, setSize] = useState({ w: 0, h: 0 });

  const root = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const history = useRef<History>({ past: [], future: [] });
  const camRef = useRef(cam);
  const localRef = useRef(local);
  const selRef = useRef(selection);
  const spaceRef = useRef(false);
  const lastCursor = useRef(0);
  const pointer = useRef<Pt | null>(null);
  const anim = useRef(0);
  const movingTimer = useRef(0);
  const frameActionRef = useRef(onFrameAction);
  localRef.current = local;
  selRef.current = selection;
  frameActionRef.current = onFrameAction;

  /* ----- derived ----- */

  const items = useMemo(() => {
    const all = applyPatch(local.items, draft);
    return all.slice().sort((a, b) => a.z - b.z);
  }, [local, draft]);
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const get = useCallback<Getter>((id) => byId.get(id), [byId]);
  const draftArrow = gestureKind === "arrow" && gesture.current?.kind === "arrow" ? gesture.current.id : null;

  /* ----- camera ----- */

  const setCam = useCallback((next: CanvasCamera | ((c: CanvasCamera) => CanvasCamera)) => {
    const n = typeof next === "function" ? next(camRef.current) : next;
    camRef.current = n;
    setCamState(n);
    // While the camera moves, promote the layer; drop it afterwards so text re-rasterises crisply.
    setMoving(true);
    window.clearTimeout(movingTimer.current);
    movingTimer.current = window.setTimeout(() => setMoving(false), 140);
  }, []);

  const animateTo = useCallback(
    (target: CanvasCamera) => {
      cancelAnimationFrame(anim.current);
      if (reducedMotion()) return setCam(target);
      const from = camRef.current;
      const t0 = performance.now();
      const dur = 380;
      const step = (now: number) => {
        const p = Math.min(1, (now - t0) / dur);
        const e = 1 - Math.pow(1 - p, 4);
        // Interpolate zoom geometrically so it feels even at every scale.
        const zoom = from.zoom * Math.pow(target.zoom / from.zoom, e);
        setCam({ zoom, x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e });
        if (p < 1) anim.current = requestAnimationFrame(step);
      };
      anim.current = requestAnimationFrame(step);
    },
    [setCam],
  );

  const viewSize = () => {
    const r = viewport.current?.getBoundingClientRect();
    return { w: r?.width ?? 0, h: r?.height ?? 0 };
  };

  const zoomToFit = useCallback(
    (only?: CanvasItem[]) => {
      const list = only ?? localRef.current.items;
      const g: Getter = (id) => localRef.current.items.find((i) => i.id === id);
      const b = union(list.map((i) => boundsOf(i, g)));
      const { w, h } = viewSize();
      if (!b || !w) return animateTo({ x: w / 2, y: h / 2, zoom: 1 });
      // Leave room for frame labels above and the toolbar below.
      animateTo(fitCamera({ ...b, y: b.y - 30, h: b.h + 30 }, w, h - 40, 80, only ? 2 : 1));
    },
    [animateTo],
  );

  const zoomBy = useCallback(
    (dir: 1 | -1) => {
      const { w, h } = viewSize();
      const steps = [0.1, 0.15, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4];
      const z = camRef.current.zoom;
      const next = dir > 0 ? steps.find((s) => s > z + 0.001) ?? 4 : [...steps].reverse().find((s) => s < z - 0.001) ?? 0.1;
      animateTo(zoomAround(camRef.current, w / 2, h / 2, next));
    },
    [animateTo],
  );

  const resetZoom = useCallback(() => {
    const { w, h } = viewSize();
    animateTo(zoomAround(camRef.current, w / 2, h / 2, 1));
  }, [animateTo]);

  // First paint: fit the content when the doc has no saved camera.
  useLayoutEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setSize({ w: r.width, h: r.height });
    if (!doc.camera) {
      const b = union(doc.items.map((i) => boundsOf(i, (id) => doc.items.find((x) => x.id === id))));
      const c = b ? fitCamera({ ...b, y: b.y - 30, h: b.h + 30 }, r.width, r.height - 40, 80) : { x: r.width / 2, y: r.height / 2, zoom: 1 };
      camRef.current = c;
      setCamState(c);
    }
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toBoard = (clientX: number, clientY: number): Pt => {
    const r = viewport.current!.getBoundingClientRect();
    const c = camRef.current;
    return [(clientX - r.left - c.x) / c.zoom, (clientY - r.top - c.y) / c.zoom];
  };

  /* ----- commits and history ----- */

  const emit = useCallback(
    (items: CanvasItem[]) => {
      const nd: CanvasDoc = { ...localRef.current, items, camera: camRef.current };
      localRef.current = nd;
      setLocal(nd);
      onChange(nd);
    },
    [onChange],
  );

  const commit = useCallback(
    (patch: Patch) => {
      const cur = localRef.current.items;
      const map = new Map(cur.map((i) => [i.id, i]));
      const before: Patch = new Map();
      const after: Patch = new Map();
      for (const [id, it] of patch) {
        const b = map.get(id) ?? null;
        if (b === it) continue;
        before.set(id, b);
        after.set(id, it);
      }
      if (!after.size) return;
      const h = history.current;
      h.past.push({ before, after });
      if (h.past.length > 200) h.past.shift();
      h.future = [];
      emit(applyPatch(cur, after));
    },
    [emit],
  );

  const replay = (dir: "undo" | "redo") => {
    const h = history.current;
    const entry = dir === "undo" ? h.past.pop() : h.future.pop();
    if (!entry) return;
    (dir === "undo" ? h.future : h.past).push(entry);
    const patch = dir === "undo" ? entry.before : entry.after;
    emit(applyPatch(localRef.current.items, patch));
    setSelection(new Set([...patch].filter(([, v]) => v).map(([k]) => k)));
    setEditing(null);
  };

  /* ----- selection out ----- */

  const selectedItems = useMemo(() => local.items.filter((i) => selection.has(i.id)), [local, selection]);
  useEffect(() => {
    onSelectionChange?.(selectedItems);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedItems]);
  // Drop ids that disappeared (remote delete, undo).
  useEffect(() => {
    if ([...selection].some((id) => !byId.has(id))) setSelection(new Set([...selection].filter((id) => byId.has(id))));
  }, [byId, selection]);

  /* ----- item helpers ----- */

  const maxZ = () => localRef.current.items.reduce((m, i) => Math.max(m, i.z), 0);

  const newItem = (kind: Tool, at: Pt, z: number, w?: number, h?: number): CanvasItem => {
    const [dw, dh] = DEFAULT_SIZE[kind] ?? [160, 110];
    const ww = w ?? dw, hh = h ?? dh;
    const base: CanvasItem = { id: uid(), kind: kind as CanvasItem["kind"], x: at[0], y: at[1], w: ww, h: hh, z };
    if (kind === "sticky") return { ...base, color: stickyColor, author: me, text: "" };
    if (kind === "text") return { ...base, text: "" };
    if (kind === "rect" || kind === "ellipse") return { ...base, color: "blue" };
    if (kind === "frame") return { ...base, frame: { kind: "url", src: "", label: "" } };
    return base;
  };

  /** Copies of `list` with fresh ids; arrows keep bindings only to items copied along. */
  const cloneItems = (list: CanvasItem[], dx: number, dy: number, zBase: number) => {
    const ids = new Map(list.map((i) => [i.id, uid()]));
    const g: Getter = (id) => localRef.current.items.find((i) => i.id === id);
    return list
      .slice()
      .sort((a, b) => a.z - b.z)
      .map((i, n) => {
        let c: CanvasItem = { ...i, id: ids.get(i.id)!, z: zBase + n + 1, x: i.x + dx, y: i.y + dy };
        if (i.kind === "arrow") {
          const keepFrom = i.from && ids.has(i.from), keepTo = i.to && ids.has(i.to);
          if ((i.from && !keepFrom) || (i.to && !keepTo)) {
            const { a, b } = resolveArrow(i, g);
            c = arrowAt(c, [a[0] + dx, a[1] + dy], [b[0] + dx, b[1] + dy]);
          }
          c.from = keepFrom ? ids.get(i.from!) : undefined;
          c.to = keepTo ? ids.get(i.to!) : undefined;
        }
        return c;
      });
  };

  /** Translate items; an arrow moved without its anchors lets go of them. */
  const translated = (orig: Map<string, CanvasItem>, ids: string[], dx: number, dy: number, g: Getter): Patch => {
    const set = new Set(ids);
    const p: Patch = new Map();
    for (const id of ids) {
      const it = orig.get(id);
      if (!it) continue;
      if (it.kind === "arrow" && ((it.from && !set.has(it.from)) || (it.to && !set.has(it.to)))) {
        const { a, b } = resolveArrow(it, g);
        const n = arrowAt(it, [a[0] + dx, a[1] + dy], [b[0] + dx, b[1] + dy]);
        if (it.from && !set.has(it.from)) n.from = undefined;
        if (it.to && !set.has(it.to)) n.to = undefined;
        p.set(id, n);
      } else p.set(id, { ...it, x: it.x + dx, y: it.y + dy });
    }
    return p;
  };

  const deleteSelection = () => {
    const sel = selRef.current;
    if (!sel.size) return;
    const p: Patch = new Map();
    const g: Getter = (id) => byId.get(id);
    for (const id of sel) p.set(id, null);
    // Arrows pointing at deleted items keep their shape, unbound.
    for (const it of localRef.current.items) {
      if (it.kind !== "arrow" || sel.has(it.id)) continue;
      const lf = it.from && sel.has(it.from), lt = it.to && sel.has(it.to);
      if (lf || lt) {
        const { a, b } = resolveArrow(it, g);
        const n = arrowAt(it, a, b);
        if (lf) n.from = undefined;
        if (lt) n.to = undefined;
        p.set(it.id, n);
      }
    }
    commit(p);
    setSelection(new Set());
  };

  const duplicate = (list: CanvasItem[], dx = 24, dy = 24) => {
    if (!list.length) return;
    const copies = cloneItems(list, dx, dy, maxZ());
    commit(new Map(copies.map((c) => [c.id, c])));
    setSelection(new Set(copies.map((c) => c.id)));
  };

  const reorder = (dir: "forward" | "back" | "front" | "bottom") => {
    const sel = selRef.current;
    if (!sel.size) return;
    const order = localRef.current.items.slice().sort((a, b) => a.z - b.z);
    let next: CanvasItem[];
    if (dir === "front") next = [...order.filter((i) => !sel.has(i.id)), ...order.filter((i) => sel.has(i.id))];
    else if (dir === "bottom") next = [...order.filter((i) => sel.has(i.id)), ...order.filter((i) => !sel.has(i.id))];
    else {
      next = order.slice();
      if (dir === "forward") {
        for (let i = next.length - 2; i >= 0; i--) if (sel.has(next[i].id) && !sel.has(next[i + 1].id)) [next[i], next[i + 1]] = [next[i + 1], next[i]];
      } else {
        for (let i = 1; i < next.length; i++) if (sel.has(next[i].id) && !sel.has(next[i - 1].id)) [next[i], next[i - 1]] = [next[i - 1], next[i]];
      }
    }
    const p: Patch = new Map();
    next.forEach((it, i) => it.z !== i && p.set(it.id, { ...it, z: i }));
    commit(p);
  };

  /* ----- frames ----- */

  const handleFrameAction = useCallback((item: CanvasItem, a: FrameAction) => {
    frameActionRef.current?.(item, a);
  }, []);

  const setDevice = (item: CanvasItem, d: Device) => {
    const s = DEVICES[d];
    commit(new Map([[item.id, { ...item, w: s.w, h: s.h }]]));
  };
  const toggleTheme = (item: CanvasItem) => {
    if (!item.frame) return;
    const cur = item.frame.theme ?? (document.documentElement.dataset.theme === "dark" ? "dark" : "light");
    commit(new Map([[item.id, { ...item, frame: { ...item.frame, theme: cur === "dark" ? "light" : "dark" } }]]));
  };

  /* ----- editing ----- */

  const onEditDone = useCallback(
    (id: string, text: string, h?: number) => {
      setEditing(null);
      const it = localRef.current.items.find((i) => i.id === id);
      if (!it) return;
      if (it.kind === "text" && !text.trim()) {
        commit(new Map([[id, null]]));
        setSelection(new Set());
      } else if (text !== (it.text ?? "") || (h && Math.abs(h - it.h) > 0.5)) {
        commit(new Map([[id, { ...it, text, ...(h ? { h } : {}) }]]));
      }
      root.current?.focus({ preventScroll: true });
    },
    [commit],
  );

  /* ----- wheel & gestures (native listeners: they must not be passive) ----- */

  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (entered && (e.target as HTMLElement).closest(`[data-frame-body="${entered}"]`)) return;
      e.preventDefault();
      cancelAnimationFrame(anim.current);
      const r = el.getBoundingClientRect();
      let dx = e.deltaX, dy = e.deltaY;
      if (e.deltaMode === 1) {
        dx *= 16;
        dy *= 16;
      }
      if (e.ctrlKey || e.metaKey) {
        const f = Math.exp(-clamp(dy, -40, 40) * 0.01);
        setCam((c) => zoomAround(c, e.clientX - r.left, e.clientY - r.top, c.zoom * f));
      } else {
        if (e.shiftKey && !dx) [dx, dy] = [dy, 0];
        setCam((c) => ({ ...c, x: c.x - dx, y: c.y - dy }));
      }
    };
    let gz = 1;
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      gz = camRef.current.zoom;
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const g = e as GestureEvent;
      const r = el.getBoundingClientRect();
      setCam((c) => zoomAround(c, g.clientX - r.left, g.clientY - r.top, gz * g.scale));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("gesturestart", onGestureStart);
    el.addEventListener("gesturechange", onGestureChange);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("gesturestart", onGestureStart);
      el.removeEventListener("gesturechange", onGestureChange);
    };
  }, [entered, setCam]);

  /* ----- pointer ----- */

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (isEditable(target)) return;
    if (entered) {
      if (target.closest(`[data-frame-body="${entered}"]`)) return;
      setEntered(null);
    }
    if (e.button === 2) return;
    root.current?.focus({ preventScroll: true });
    cancelAnimationFrame(anim.current);
    const vp = viewport.current!;
    vp.setPointerCapture(e.pointerId);
    const p = toBoard(e.clientX, e.clientY);

    if (e.button === 1 || spaceRef.current) {
      gesture.current = { kind: "pan", sx: e.clientX, sy: e.clientY, cam: camRef.current };
      setGestureKind("pan");
      e.preventDefault();
      return;
    }

    const handle = target.closest<HTMLElement>("[data-handle]")?.dataset.handle as Handle | undefined;
    const hitId = target.closest<HTMLElement>("[data-id]")?.dataset.id;
    const hit = hitId ? byId.get(hitId) : undefined;

    if (tool === "select") {
      if (handle) {
        const orig = items.filter((i) => selection.has(i.id));
        const box = union(orig.map((i) => boundsOf(i, get)));
        if (!box) return;
        gesture.current = { kind: "resize", handle, start: p, orig, box };
        setGestureKind("resize");
        return;
      }
      if (hit) {
        let sel = selection;
        let selectOnly: string | null = null;
        if (e.shiftKey) {
          sel = new Set(selection);
          if (sel.has(hit.id)) sel.delete(hit.id);
          else sel.add(hit.id);
        } else if (!selection.has(hit.id)) sel = new Set([hit.id]);
        else if (selection.size > 1) selectOnly = hit.id;
        setSelection(sel);
        if (!sel.has(hit.id)) return;
        const ids = [...sel];
        const orig = new Map(ids.map((id) => [id, byId.get(id)!]).filter(([, v]) => v) as [string, CanvasItem][]);
        const moving = new Set(ids);
        const others = items.filter((i) => !moving.has(i.id) && i.kind !== "arrow" && i.kind !== "pen").map((i) => boundsOf(i, get));
        const box = union([...orig.values()].map((i) => boundsOf(i, get)))!;
        gesture.current = { kind: "move", start: p, sx: e.clientX, sy: e.clientY, ids, orig, lines: snapLines(others), box, moved: false, dup: e.altKey, selectOnly };
        setGestureKind("move");
        return;
      }
      const base = e.shiftKey ? new Set(selection) : new Set<string>();
      if (!e.shiftKey) setSelection(base);
      gesture.current = { kind: "marquee", start: p, base };
      setGestureKind("marquee");
      return;
    }

    if (tool === "pen") {
      const id = uid();
      gesture.current = { kind: "pen", pts: [p], id };
      setGestureKind("pen");
      setDraft(new Map([[id, penItem({ id, kind: "pen", x: 0, y: 0, w: 0, h: 0, z: maxZ() + 1 }, [p])]]));
      return;
    }

    if (tool === "arrow") {
      const id = uid();
      const from = hit && hit.kind !== "arrow" && hit.kind !== "pen" ? hit.id : undefined;
      gesture.current = { kind: "arrow", start: p, from, id };
      setGestureKind("arrow");
      setDraft(new Map([[id, arrowAt({ id, kind: "arrow", x: 0, y: 0, w: 0, h: 0, z: maxZ() + 1, from }, p, p)]]));
      return;
    }

    // Creation tools: sticky, text, rect, ellipse, frame.
    const id = uid();
    gesture.current = { kind: "create", tool, start: p, sx: e.clientX, sy: e.clientY, id, dragged: false };
    setGestureKind("create");
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const p = toBoard(e.clientX, e.clientY);
    pointer.current = p;
    if (onCursor) {
      const now = performance.now();
      if (now - lastCursor.current > 33) {
        lastCursor.current = now;
        onCursor(Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10);
      }
    }
    const g = gesture.current;
    if (!g) {
      const id = (e.target as HTMLElement).closest<HTMLElement>("[data-id]")?.dataset.id ?? null;
      if (id !== hover) setHover(id);
      return;
    }
    const z = camRef.current.zoom;
    switch (g.kind) {
      case "pan":
        setCam({ ...g.cam, x: g.cam.x + e.clientX - g.sx, y: g.cam.y + e.clientY - g.sy });
        return;
      case "move": {
        if (!g.moved) {
          if (Math.hypot(e.clientX - g.sx, e.clientY - g.sy) < 3) return;
          g.moved = true;
          if (g.dup) {
            // Alt-drag: leave the originals, carry copies.
            const copies = cloneItems([...g.orig.values()], 0, 0, maxZ());
            g.orig = new Map(copies.map((c) => [c.id, c]));
            g.ids = copies.map((c) => c.id);
            setSelection(new Set(g.ids));
          }
        }
        let dx = p[0] - g.start[0], dy = p[1] - g.start[1];
        let gl: Guide[] = [];
        if (!(e.metaKey || e.ctrlKey)) {
          const s = snap({ ...g.box, x: g.box.x + dx, y: g.box.y + dy }, g.lines, 6 / z);
          dx += s.dx;
          dy += s.dy;
          gl = s.guides;
        }
        const g2: Getter = (id) => g.orig.get(id) ?? localRef.current.items.find((i) => i.id === id);
        setDraft(translated(g.orig, g.ids, dx, dy, g2));
        setGuides(gl.length ? gl : null);
        return;
      }
      case "resize": {
        const b = g.box;
        const dx = p[0] - g.start[0], dy = p[1] - g.start[1];
        let x1 = b.x, y1 = b.y, x2 = b.x + b.w, y2 = b.y + b.h;
        if (g.handle.includes("w")) x1 += dx;
        if (g.handle.includes("e")) x2 += dx;
        if (g.handle.includes("n")) y1 += dy;
        if (g.handle.includes("s")) y2 += dy;
        const min = 8;
        if (x2 - x1 < min) g.handle.includes("w") ? (x1 = x2 - min) : (x2 = x1 + min);
        if (y2 - y1 < min) g.handle.includes("n") ? (y1 = y2 - min) : (y2 = y1 + min);
        if (e.shiftKey && b.w > 0 && b.h > 0) {
          const corner = g.handle.length === 2;
          const s = corner
            ? Math.max((x2 - x1) / b.w, (y2 - y1) / b.h)
            : g.handle === "e" || g.handle === "w"
              ? (x2 - x1) / b.w
              : (y2 - y1) / b.h;
          const nw = b.w * s, nh = b.h * s;
          if (g.handle.includes("w")) x1 = x2 - nw;
          else if (g.handle.includes("e") || !corner) {
            if (g.handle === "n" || g.handle === "s") x1 = b.x + (b.w - nw) / 2;
            x2 = x1 + nw;
          }
          if (g.handle.includes("n")) y1 = y2 - nh;
          else if (g.handle.includes("s") || !corner) {
            if (g.handle === "e" || g.handle === "w") y1 = b.y + (b.h - nh) / 2;
            y2 = y1 + nh;
          }
        }
        const sx = (x2 - x1) / (b.w || 1), sy = (y2 - y1) / (b.h || 1);
        const patch: Patch = new Map();
        for (const it of g.orig) {
          if (it.kind === "arrow") {
            const { a, b: bb } = resolveArrow(it, get);
            const m = (q: Pt): Pt => [x1 + (q[0] - b.x) * sx, y1 + (q[1] - b.y) * sy];
            const n = arrowAt(it, m(a), m(bb));
            n.from = it.from;
            n.to = it.to;
            patch.set(it.id, n);
            continue;
          }
          const n: CanvasItem = { ...it, x: x1 + (it.x - b.x) * sx, y: y1 + (it.y - b.y) * sy, w: Math.max(4, it.w * sx), h: Math.max(4, it.h * sy) };
          if (it.kind === "pen" && it.points) n.points = it.points.map(([px, py]) => [px * sx, py * sy]);
          patch.set(it.id, n);
        }
        setDraft(patch);
        return;
      }
      case "marquee": {
        const box = boxFrom(g.start, p);
        setMarquee(box);
        const sel = new Set(g.base);
        for (const it of items) {
          const b = boundsOf(it, get);
          if (it.kind === "frame" ? contains(box, b) : intersects(box, b)) sel.add(it.id);
        }
        const cur = selRef.current;
        if (sel.size !== cur.size || [...sel].some((id) => !cur.has(id))) setSelection(sel);
        return;
      }
      case "create": {
        if (!g.dragged && Math.hypot(e.clientX - g.sx, e.clientY - g.sy) < 4) return;
        g.dragged = true;
        let b = boxFrom(g.start, p);
        if (e.shiftKey) {
          const s = Math.max(b.w, b.h);
          b = { x: p[0] < g.start[0] ? g.start[0] - s : g.start[0], y: p[1] < g.start[1] ? g.start[1] - s : g.start[1], w: s, h: s };
        }
        const it = { ...newItem(g.tool, [b.x, b.y], maxZ() + 1, Math.max(b.w, 8), Math.max(b.h, 8)), id: g.id };
        setDraft(new Map([[g.id, it]]));
        return;
      }
      case "pen": {
        const last = g.pts[g.pts.length - 1];
        if (Math.hypot(p[0] - last[0], p[1] - last[1]) < 1.5 / z) return;
        g.pts.push(p);
        setDraft(new Map([[g.id, penItem({ id: g.id, kind: "pen", x: 0, y: 0, w: 0, h: 0, z: maxZ() + 1 }, g.pts)]]));
        return;
      }
      case "arrow": {
        const base: CanvasItem = { id: g.id, kind: "arrow", x: 0, y: 0, w: 0, h: 0, z: maxZ() + 1, from: g.from };
        setDraft(new Map([[g.id, arrowAt(base, g.start, p)]]));
        return;
      }
    }
  };

  const endGesture = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    gesture.current = null;
    setGestureKind(null);
    if (viewport.current?.hasPointerCapture(e.pointerId)) viewport.current.releasePointerCapture(e.pointerId);
    if (!g) return;
    const p = toBoard(e.clientX, e.clientY);
    const d = draft;
    setDraft(null);
    setGuides(null);
    setMarquee(null);
    switch (g.kind) {
      case "move":
        if (!g.moved) {
          if (g.selectOnly) setSelection(new Set([g.selectOnly]));
        } else if (d) commit(d);
        return;
      case "resize":
        if (d) commit(d);
        return;
      case "create": {
        let it = d?.get(g.id) ?? null;
        if (!it) {
          const [w, h] = DEFAULT_SIZE[g.tool] ?? [160, 110];
          const at: Pt = g.tool === "text" ? [g.start[0], g.start[1] - h / 2] : [g.start[0] - w / 2, g.start[1] - h / 2];
          it = { ...newItem(g.tool, at, maxZ() + 1), id: g.id };
        }
        commit(new Map([[g.id, it]]));
        setSelection(new Set([g.id]));
        setTool("select");
        if (g.tool === "sticky" || g.tool === "text") setEditing(g.id);
        return;
      }
      case "pen": {
        if (g.pts.length < 2) return;
        commit(new Map([[g.id, penItem({ id: g.id, kind: "pen", x: 0, y: 0, w: 0, h: 0, z: maxZ() + 1 }, smooth(g.pts))]]));
        return;
      }
      case "arrow": {
        if (Math.hypot(p[0] - g.start[0], p[1] - g.start[1]) * camRef.current.zoom < 6) return;
        const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
        const toId = el?.closest<HTMLElement>("[data-id]")?.dataset.id;
        const to = toId && toId !== g.from && byId.get(toId)?.kind !== "arrow" && byId.get(toId)?.kind !== "pen" ? toId : undefined;
        const base: CanvasItem = { id: g.id, kind: "arrow", x: 0, y: 0, w: 0, h: 0, z: maxZ() + 1, from: g.from, to };
        commit(new Map([[g.id, arrowAt(base, g.start, p)]]));
        setSelection(new Set([g.id]));
        setTool("select");
        return;
      }
    }
  };

  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (isEditable(target) || tool !== "select") return;
    const id = target.closest<HTMLElement>("[data-id]")?.dataset.id;
    const it = id ? byId.get(id) : undefined;
    if (it) {
      if (it.kind === "sticky" || it.kind === "text" || it.kind === "rect" || it.kind === "ellipse") setEditing(it.id);
      else if (it.kind === "frame") setEntered(it.id);
      setSelection(new Set([it.id]));
      return;
    }
    // Double-click on empty canvas: start typing there.
    const p = toBoard(e.clientX, e.clientY);
    const n = newItem("text", [p[0], p[1] - 14], maxZ() + 1);
    commit(new Map([[n.id, n]]));
    setSelection(new Set([n.id]));
    setEditing(n.id);
  };

  /* ----- keyboard ----- */

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (isEditable(e.target)) return;
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
    const sel = selRef.current;
    const selList = localRef.current.items.filter((i) => sel.has(i.id));

    if (e.key === " ") {
      e.preventDefault();
      if (!spaceRef.current) {
        spaceRef.current = true;
        setSpace(true);
      }
      return;
    }
    if (mod) {
      if (k === "z") {
        e.preventDefault();
        replay(e.shiftKey ? "redo" : "undo");
      } else if (k === "y") {
        e.preventDefault();
        replay("redo");
      } else if (k === "d") {
        e.preventDefault();
        duplicate(selList);
      } else if (k === "c" || k === "x") {
        if (!selList.length) return;
        e.preventDefault();
        clipboard = selList.map((i) => ({ ...i }));
        if (k === "x") deleteSelection();
      } else if (k === "v") {
        if (!clipboard.length) return;
        e.preventDefault();
        const b = union(clipboard.map((i) => ({ x: i.x, y: i.y, w: i.w, h: i.h })))!;
        const at = pointer.current;
        const [dx, dy] = at ? [at[0] - (b.x + b.w / 2), at[1] - (b.y + b.h / 2)] : [24, 24];
        duplicate(clipboard, dx, dy);
      } else if (k === "a") {
        e.preventDefault();
        setSelection(new Set(localRef.current.items.map((i) => i.id)));
      } else if (k === "=" || k === "+") {
        e.preventDefault();
        zoomBy(1);
      } else if (k === "-") {
        e.preventDefault();
        zoomBy(-1);
      } else if (k === "0") {
        e.preventDefault();
        resetZoom();
      }
      return;
    }
    if (e.shiftKey && e.code === "Digit1") return zoomToFit();
    if (e.shiftKey && e.code === "Digit0") return resetZoom();
    if (e.shiftKey && e.code === "Digit2") return selList.length ? zoomToFit(selList) : undefined;

    switch (e.key) {
      case "Backspace":
      case "Delete":
        e.preventDefault();
        deleteSelection();
        return;
      case "Escape":
        if (entered) setEntered(null);
        else if (tool !== "select") setTool("select");
        else setSelection(new Set());
        return;
      case "Enter": {
        if (selList.length !== 1) return;
        e.preventDefault();
        const it = selList[0];
        if (it.kind === "frame") setEntered(it.id);
        else if (it.kind === "sticky" || it.kind === "text" || it.kind === "rect" || it.kind === "ellipse") setEditing(it.id);
        return;
      }
      case "ArrowUp":
      case "ArrowDown":
      case "ArrowLeft":
      case "ArrowRight": {
        if (!selList.length) return;
        e.preventDefault();
        const s = e.shiftKey ? 10 : 1;
        const dx = e.key === "ArrowLeft" ? -s : e.key === "ArrowRight" ? s : 0;
        const dy = e.key === "ArrowUp" ? -s : e.key === "ArrowDown" ? s : 0;
        const orig = new Map(selList.map((i) => [i.id, i]));
        commit(translated(orig, [...orig.keys()], dx, dy, (id) => byId.get(id)));
        return;
      }
      case "]":
      case "}":
        reorder(e.shiftKey || e.key === "}" ? "front" : "forward");
        return;
      case "[":
      case "{":
        reorder(e.shiftKey || e.key === "{" ? "bottom" : "back");
        return;
    }
    if (e.altKey || e.shiftKey) return;
    const tools: Record<string, Tool> = { v: "select", f: "frame", t: "text", p: "pen", s: "sticky", r: "rect", o: "ellipse", a: "arrow" };
    if (tools[k]) {
      e.preventDefault();
      const next = tools[k];
      if (next === "rect" || next === "ellipse") setShape(next);
      setTool(next);
    }
  };

  const onKeyUp = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === " ") {
      spaceRef.current = false;
      setSpace(false);
    }
  };

  useEffect(() => {
    const off = () => {
      spaceRef.current = false;
      setSpace(false);
    };
    window.addEventListener("blur", off);
    return () => window.removeEventListener("blur", off);
  }, []);

  /* ----- overlay geometry (screen space) ----- */

  const toScreen = (b: Box): Box => ({ x: b.x * cam.zoom + cam.x, y: b.y * cam.zoom + cam.y, w: b.w * cam.zoom, h: b.h * cam.zoom });
  const selected = items.filter((i) => selection.has(i.id));
  const selBoxes = selected.map((i) => ({ id: i.id, kind: i.kind, box: toScreen(boundsOf(i, get)) }));
  const selUnion = union(selBoxes.map((s) => s.box));
  const showHandles = selUnion && !(selected.length === 1 && selected[0].kind === "arrow") && gestureKind !== "move" && gestureKind !== "marquee" && !editing;
  const hovered = hover && !selection.has(hover) && !gestureKind ? byId.get(hover) : undefined;
  const singleFrame = selected.length === 1 && selected[0].kind === "frame" && (!gestureKind || gestureKind === "pan") ? selected[0] : null;
  const frameBox = singleFrame ? toScreen(singleFrame) : null;

  const step = cam.zoom * 24;
  const gridMul = step < 12 ? Math.pow(2, Math.ceil(Math.log2(12 / step))) : 1;
  const gap = step * gridMul;
  const dotR = clamp(cam.zoom * 1.1, 0.8, 1.4);

  const cursorClass =
    space || gestureKind === "pan"
      ? gestureKind === "pan"
        ? "grabbing"
        : "grab"
      : tool === "select"
        ? ""
        : tool === "pen"
          ? "pen"
          : "crosshair";

  return (
    <div className="cv-root" ref={root} tabIndex={0} onKeyDown={onKeyDown} onKeyUp={onKeyUp}>
      <div
        className={`cv-viewport ${cursorClass}`}
        ref={viewport}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endGesture}
        onPointerCancel={endGesture}
        onPointerLeave={() => hover && setHover(null)}
        onDoubleClick={onDoubleClick}
        onContextMenu={(e) => e.preventDefault()}
        style={{
          backgroundSize: `${gap}px ${gap}px`,
          backgroundPosition: `${cam.x - gap / 2}px ${cam.y - gap / 2}px`,
          ["--cv-dot" as string]: `${dotR}px`,
        }}
      >
        <div
          className={`cv-world ${moving ? "moving" : ""} ${tool !== "select" ? "creating" : ""}`}
          style={{ transform: `translate(${cam.x}px, ${cam.y}px) scale(${cam.zoom})`, ["--cv-inv" as string]: 1 / cam.zoom }}
        >
          <ItemsLayer
            items={items}
            get={get}
            editing={editing}
            entered={entered}
            renderFrame={renderFrame}
            onEditDone={onEditDone}
            onFrameAction={handleFrameAction}
            draftArrow={draftArrow}
          />
        </div>

        <div className="cv-overlay">
          {hovered && hovered.kind !== "pen" && (() => {
            const b = toScreen(boundsOf(hovered, get));
            return <div className={`cv-hover ${hovered.kind === "ellipse" ? "round" : ""}`} style={{ left: b.x, top: b.y, width: b.w, height: b.h }} />;
          })()}
          {selBoxes.map((s) => (
            <div key={s.id} className={`cv-sel ${s.kind === "ellipse" ? "round" : ""}`} style={{ left: s.box.x, top: s.box.y, width: s.box.w, height: s.box.h }} />
          ))}
          {selUnion && selBoxes.length > 1 && <div className="cv-sel group" style={{ left: selUnion.x, top: selUnion.y, width: selUnion.w, height: selUnion.h }} />}
          {showHandles &&
            HANDLES.map((h) => {
              const x = selUnion.x + (h.includes("w") ? 0 : h.includes("e") ? selUnion.w : selUnion.w / 2);
              const y = selUnion.y + (h.includes("n") ? 0 : h.includes("s") ? selUnion.h : selUnion.h / 2);
              const edge = h.length === 1;
              if (edge && (h === "n" || h === "s" ? selUnion.w : selUnion.h) < 40) return null;
              return <div key={h} data-handle={h} className={`cv-handle h-${h} ${edge ? "edge" : ""}`} style={{ left: x, top: y }} />;
            })}
          {selUnion && gestureKind === "resize" && (
            <div className="cv-size num" style={{ left: selUnion.x + selUnion.w / 2, top: selUnion.y + selUnion.h + 10 }}>
              {Math.round(selUnion.w / cam.zoom)} × {Math.round(selUnion.h / cam.zoom)}
            </div>
          )}
          {guides?.map((g, i) => {
            const a = toScreen({ x: g.x1, y: g.y1, w: g.x2 - g.x1, h: g.y2 - g.y1 });
            return <div key={i} className="cv-guide" style={{ left: a.x, top: a.y, width: Math.max(a.w, 1), height: Math.max(a.h, 1) }} />;
          })}
          {marquee && (() => {
            const b = toScreen(marquee);
            return <div className="cv-marquee" style={{ left: b.x, top: b.y, width: b.w, height: b.h }} />;
          })()}
        </div>

        {cursors && cursors.length > 0 && <Cursors cursors={cursors} camera={cam} />}
      </div>

      {singleFrame && frameBox && (
        <FrameToolbar
          item={singleFrame}
          entered={entered === singleFrame.id}
          left={clamp(frameBox.x + frameBox.w / 2, 180, Math.max(180, size.w - 180))}
          top={clamp(frameBox.y - 34, 52, Math.max(52, size.h - 80))}
          onAction={(a) => handleFrameAction(singleFrame, a)}
          onDevice={(d) => setDevice(singleFrame, d)}
          onTheme={() => toggleTheme(singleFrame)}
        />
      )}

      <Toolbar tool={tool} stickyColor={stickyColor} shape={shape} onTool={setTool} onStickyColor={setStickyColor} onShape={setShape} />
      <ZoomControl zoom={cam.zoom} onZoom={zoomBy} onFit={() => zoomToFit()} onReset={resetZoom} />
    </div>
  );
}
