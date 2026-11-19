import type { ReactNode } from "react";

export type ItemKind = "sticky" | "text" | "rect" | "ellipse" | "arrow" | "pen" | "frame" | "image" | "task";

/** Colour token names shared by stickies and shapes (see `--sticky-*` in canvas.css). */
export type CanvasColor = "yellow" | "green" | "blue" | "pink" | "purple" | "grey";
export const CANVAS_COLORS: CanvasColor[] = ["yellow", "green", "blue", "pink", "purple", "grey"];

export interface CanvasFrame {
  kind: "url" | "artifact" | "thread";
  src: string;
  label: string;
  branch?: string;
  threadId?: string;
  /** Theme the frame's content should render in; toggled from the frame toolbar. Unset = follow the app. */
  theme?: "light" | "dark";
}

export interface CanvasItem {
  id: string;
  kind: ItemKind;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation?: number;
  text?: string;
  color?: string; // sticky/shape colour token name: "yellow"|"green"|"blue"|"pink"|"purple"|"grey"
  author?: string; // display name, shown small on stickies
  points?: [number, number][]; // pen/arrow, relative to x,y
  from?: string; // arrow bound to item ids (optional)
  to?: string;
  frame?: CanvasFrame;
  src?: string; // image url
  issueKey?: string; // task card
  status?: string;
  z: number;
}

export interface CanvasCamera {
  x: number;
  y: number;
  zoom: number;
}

export interface CanvasDoc {
  items: CanvasItem[];
  camera?: CanvasCamera;
}

export interface RemoteCursor {
  id: string;
  name: string;
  color: string;
  x: number;
  y: number;
}

export type FrameAction = "open" | "reload" | "variant" | "inspect";

export interface CanvasProps {
  doc: CanvasDoc;
  /** Every committed change (debounce is the caller's job). */
  onChange(doc: CanvasDoc): void;
  cursors?: RemoteCursor[];
  /** Board coordinates, throttled to ~30 Hz. */
  onCursor?(x: number, y: number): void;
  /** Author name for new stickies. */
  me: string;
  /** Drives chat context chips. */
  onSelectionChange?(items: CanvasItem[]): void;
  /** App renders iframe content; default renders a placeholder card. Keep it stable (useCallback). */
  renderFrame?(item: CanvasItem): ReactNode;
  onFrameAction?(item: CanvasItem, action: FrameAction): void;
}

export type Tool = "select" | "frame" | "text" | "pen" | "sticky" | "rect" | "ellipse" | "arrow";
