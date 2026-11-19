import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Canvas, Inspector, type CanvasDoc, type CanvasItem, type RemoteCursor } from "./components/canvas";
import "./styles/tokens.css";
import "./styles/app.css";

const s = (id: string, x: number, y: number, text: string, author: string, color: string): CanvasItem => ({ id, kind: "sticky", x, y, w: 180, h: 180, text, author, color, z: 10 });

const initial: CanvasDoc = {
  items: [
    { id: "f2", kind: "frame", x: 0, y: 0, w: 880, h: 560, z: 1, frame: { kind: "url", src: "http://localhost:5173/revenue", label: "Abloh 2", branch: "abloh-2" } },
    { id: "f3", kind: "frame", x: 960, y: 0, w: 880, h: 560, z: 2, frame: { kind: "url", src: "http://localhost:5174/revenue", label: "Abloh 3", branch: "abloh-3" } },
    s("s1", 0, -320, "Revenue chart needs a comparison to last quarter", "Vincent", "yellow"),
    s("s2", 204, -320, "KPI cards: too many decimals", "Xavier", "pink"),
    s("s3", 408, -320, "Love the calmer sidebar in Abloh 3", "Jordan", "green"),
    s("s4", 960, -320, "Can we try the table with sticky headers?", "Vincent", "blue"),
    s("s5", 1164, -320, "Ship Abloh 3 behind a flag first", "Jordan", "purple"),
    { id: "t0", kind: "text", x: 0, y: -380, w: 360, h: 28, text: "Revenue page — review round 2", z: 11 },
    { id: "k1", kind: "task", x: 0, y: 640, w: 250, h: 74, issueKey: "BOU-142", status: "in_progress", text: "Quarter-over-quarter comparison on revenue chart", z: 12 },
    { id: "k2", kind: "task", x: 270, y: 640, w: 250, h: 74, issueKey: "BOU-143", status: "todo", text: "Round KPI values to whole numbers", z: 12 },
    { id: "k3", kind: "task", x: 540, y: 640, w: 250, h: 74, issueKey: "BOU-139", status: "done", text: "Calmer sidebar navigation", z: 12 },
    { id: "k4", kind: "task", x: 960, y: 640, w: 250, h: 74, issueKey: "BOU-151", status: "backlog", text: "Sticky table headers", z: 12 },
    { id: "a1", kind: "arrow", x: 0, y: 0, w: 0, h: 0, from: "s3", to: "f3", z: 13 },
    { id: "p1", kind: "pen", x: 1380, y: -300, w: 200, h: 120, z: 14, points: [[10, 90], [30, 60], [60, 40], [100, 30], [140, 40], [170, 70], [180, 100]] },
  ],
};

function Dashboard({ item }: { item: CanvasItem }) {
  const v3 = item.id === "f3";
  const dark = item.frame?.theme === "dark";
  const bars = v3 ? [42, 55, 48, 63, 70, 66, 78, 84, 80, 92, 88, 97] : [30, 45, 38, 60, 52, 68, 58, 74, 70, 82, 76, 90];
  const c = dark ? { bg: "#141416", card: "#1C1C1F", ink: "#EEE", mute: "#888", line: "#2A2A2E" } : { bg: v3 ? "#FAFAF9" : "#F3F4F7", card: "#FFF", ink: "#16161A", mute: "#8A8A90", line: "#E8E8EC" };
  const acc = v3 ? "#3E63DD" : "#7C5CD6";
  return (
    <div style={{ display: "flex", height: "100%", background: c.bg, color: c.ink, fontFamily: "var(--font-ui)", fontSize: 14 }}>
      <div style={{ width: v3 ? 180 : 200, padding: 20, borderRight: v3 ? "none" : `1px solid ${c.line}`, background: v3 ? "transparent" : c.card, display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ fontWeight: 700, marginBottom: 14 }}>Abloh</div>
        {["Overview", "Revenue", "Customers", "Products", "Settings"].map((n) => (
          <div key={n} style={{ padding: "7px 10px", borderRadius: 8, background: n === "Revenue" ? (v3 ? `${acc}18` : acc) : "transparent", color: n === "Revenue" ? (v3 ? acc : "#fff") : c.mute, fontWeight: n === "Revenue" ? 600 : 400 }}>{n}</div>
        ))}
      </div>
      <div style={{ flex: 1, padding: 28, display: "flex", flexDirection: "column", gap: 18 }}>
        <div style={{ fontSize: 22, fontWeight: 700 }}>Revenue</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14 }}>
          {[["MRR", "€48.2k", "+12%"], ["ARR", "€578k", "+9%"], ["Churn", v3 ? "2%" : "2.14%", "−0.3"]].map(([k, v, d]) => (
            <div key={k} style={{ background: c.card, borderRadius: 12, padding: 16, boxShadow: `0 0 0 1px ${c.line}` }}>
              <div style={{ color: c.mute, fontSize: 12 }}>{k}</div>
              <div style={{ fontSize: 24, fontWeight: 700, marginTop: 4 }}>{v}</div>
              <div style={{ color: "#2F9E5A", fontSize: 12, marginTop: 2 }}>{d}</div>
            </div>
          ))}
        </div>
        <div style={{ flex: 1, background: c.card, borderRadius: 12, padding: 18, boxShadow: `0 0 0 1px ${c.line}`, display: "flex", alignItems: "flex-end", gap: 10 }}>
          {bars.map((h, i) => (
            <div key={i} style={{ flex: 1, height: `${h}%`, borderRadius: 6, background: i === bars.length - 1 ? acc : `${acc}55` }} />
          ))}
        </div>
      </div>
    </div>
  );
}

function Demo() {
  const [doc, setDoc] = useState(initial);
  const [sel, setSel] = useState<CanvasItem[]>([]);
  const [t, setT] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setT((x) => x + 1), 700);
    return () => clearInterval(id);
  }, []);
  const cursors: RemoteCursor[] = [
    { id: "x", name: "Xavier", color: "#E5484D", x: 620 + Math.sin(t / 2) * 40, y: 300 + Math.cos(t / 2) * 20 },
    { id: "j", name: "Jordan", color: "#2F9E5A", x: 1500 + Math.cos(t / 3) * 30, y: 180 },
  ];
  const renderFrame = useCallback((item: CanvasItem) => <Dashboard item={item} />, []);
  (window as unknown as { __doc: CanvasDoc }).__doc = doc;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 280px", height: "100%" }}>
      <Canvas
        doc={doc}
        onChange={setDoc}
        me="Vincent"
        cursors={cursors}
        onSelectionChange={setSel}
        renderFrame={renderFrame}
        onFrameAction={(i, a) => console.log("frame action", i.id, a)}
      />
      <div style={{ background: "var(--sheet)", boxShadow: "-1px 0 0 var(--line)", overflow: "auto" }}>
        <Inspector
          items={sel}
          onChange={(next) => {
            const m = new Map(next.map((i) => [i.id, i]));
            setDoc((d) => ({ ...d, items: d.items.map((i) => m.get(i.id) ?? i) }));
          }}
        />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Demo />);
