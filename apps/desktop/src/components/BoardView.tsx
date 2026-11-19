import { ArrowLeft, ArrowUp, Frame, Play } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { backend } from "../backend";
import { useT } from "../i18n";
import type { Board } from "../protocol/Board";
import type { DevServer } from "../protocol/DevServer";
import type { Thread } from "../protocol/Thread";
import { boardListeners, rpc, useStore, useWorkspaceThreads, useWsData } from "../store";
import { Canvas, Inspector, type CanvasDoc, type CanvasItem, type RemoteCursor } from "./canvas";
import { Menu } from "./Menu";
import { Empty } from "./Panel";
import { personColor } from "./Sidebar";
import { ArtifactPreview } from "./Studio";

const uid = () => crypto.randomUUID();

/** A live frame: the app running on a thread's branch, or a page, or an artifact. */
function FrameBody({ item, reloads, servers, onStart }: { item: CanvasItem; reloads: number; servers: Record<string, DevServer>; onStart: (threadId: string) => void }) {
  const t = useT();
  const artifacts = useWsData().artifacts ?? [];
  const f = item.frame;
  if (!f) return null;
  if (f.kind === "url") return <iframe key={reloads} className="frame-iframe" title={f.label} src={f.src} sandbox="allow-scripts allow-forms allow-same-origin" />;
  if (f.kind === "artifact") {
    const a = artifacts.find((x) => x.id === f.src);
    return a ? <ArtifactPreview artifact={a} /> : <Empty text={f.label} />;
  }
  const dev = f.threadId ? servers[f.threadId] : undefined;
  if (dev?.running) return <iframe key={reloads} className="frame-iframe" title={f.label} src={dev.url} />;
  return (
    <div className="frame-idle">
      <span className="mono">{f.branch}</span>
      <button className="btn small" onClick={() => f.threadId && onStart(f.threadId)}>
        <Play size={13} />
        {t("dev.run")}
      </button>
    </div>
  );
}

export function BoardView({ id }: { id: string }) {
  const t = useT();
  const me = useStore((s) => s.hub.user?.name ?? s.userName);
  const myId = useStore((s) => s.hub.user?.id);
  const go = useStore((s) => s.go);
  const notify = useStore((s) => s.notify);
  const workspaceId = useStore((s) => s.workspaceId);
  const threads = useWorkspaceThreads();
  const data = useWsData();
  const [board, setBoard] = useState<Board | null>(null);
  const [doc, setDoc] = useState<CanvasDoc>({ items: [] });
  const [selection, setSelection] = useState<CanvasItem[]>([]);
  const [servers, setServers] = useState<Record<string, DevServer>>({});
  const [reloads, setReloads] = useState(0);
  const [ask, setAsk] = useState("");
  const [variants, setVariants] = useState(1);
  const save = useRef<number>(0);
  const lastCursor = useRef(0);

  useEffect(() => {
    rpc<Board>("get_board", { id })
      .then((b) => {
        setBoard(b);
        const d = b.doc as unknown as CanvasDoc | null;
        setDoc(d?.items ? d : { items: [] });
      })
      .catch((e) => notify(String(e)));
    rpc<DevServer[]>("dev_servers", { workspace_id: workspaceId })
      .then((list) => setServers(Object.fromEntries(list.map((d) => [d.thread_id, d]))))
      .catch(() => {});
    useStore.getState().load("artifacts");
  }, [id, workspaceId, notify]);

  // Other people's edits and dev servers arrive as workspace notices.
  useEffect(() => {
    const on = (_ws: string, kind: string, p: any) => {
      if (kind === "board-doc" && p.id === id && p.by !== me) setDoc(p.doc);
      if (kind === "dev-server") setServers((s) => ({ ...s, [p.thread_id]: p }));
    };
    boardListeners.add(on);
    return () => void boardListeners.delete(on);
  }, [id, me]);

  const onChange = useCallback(
    (next: CanvasDoc) => {
      setDoc(next);
      window.clearTimeout(save.current);
      save.current = window.setTimeout(() => rpc("update_board", { id, doc: next }).catch((e) => notify(String(e))), 300);
    },
    [id, notify],
  );

  const presence = Object.values(data.presence ?? {});
  const cursors: RemoteCursor[] = presence
    .filter((p) => p.viewing === id && p.cursor && p.user.id !== myId)
    .map((p) => ({ id: p.user.id, name: p.user.name, color: personColor(p.user.name), x: p.cursor![0], y: p.cursor![1] }));

  const onCursor = (x: number, y: number) => {
    const now = Date.now();
    if (now - lastCursor.current < 50 || !workspaceId || !useStore.getState().hub.connected) return;
    lastCursor.current = now;
    backend.hub.send({ t: "presence", workspace_id: workspaceId, viewing: id, cursor: [x, y] }).catch(() => {});
  };

  const startDev = async (threadId: string) => {
    try {
      const d = await rpc<DevServer>("start_dev_server", { thread_id: threadId });
      setServers((s) => ({ ...s, [threadId]: d }));
    } catch (e) {
      notify(String(e));
    }
  };

  const addFrame = (th: Thread, at?: { x: number; y: number }) => {
    const maxX = Math.max(0, ...doc.items.map((i) => i.x + i.w));
    const item: CanvasItem = {
      id: uid(),
      kind: "frame",
      x: at?.x ?? maxX + 80,
      y: at?.y ?? 0,
      w: 640,
      h: 420,
      z: Math.max(0, ...doc.items.map((i) => i.z)) + 1,
      frame: { kind: "thread", src: th.id, threadId: th.id, label: th.title, branch: th.branch ?? undefined },
    };
    onChange({ ...doc, items: [...doc.items, item] });
  };

  /** Ask an agent about the selection. "Variants" makes one isolated thread and frame per variant. */
  const send = async (text: string, variants = 1) => {
    if (!workspaceId || !text.trim()) return;
    const context = selection
      .map((i) =>
        i.kind === "frame" ? `Frame "${i.frame?.label}"${i.frame?.branch ? ` on branch ${i.frame.branch}` : ""}` : i.kind === "sticky" || i.kind === "text" ? `Note by ${i.author ?? "someone"}: ${i.text}` : null,
      )
      .filter(Boolean)
      .join("\n");
    const prompt = context ? `${text}\n\nContext from the board "${board?.name}":\n${context}` : text;
    const s = useStore.getState();
    try {
      const base = selection.find((i) => i.kind === "frame");
      for (let n = 0; n < variants; n++) {
        const th = await rpc<Thread>("create_thread", {
          thread: { workspace_id: workspaceId, captain_id: null, title: variants > 1 ? `${text.slice(0, 40)} · ${n + 1}` : null, harness: s.prefs.harness, model: s.prefs.model, effort: s.prefs.effort, approval: s.prefs.approval, isolate: true },
        });
        await rpc("send_message", { thread_id: th.id, text: variants > 1 ? `${prompt}\n\nThis is variant ${n + 1} of ${variants}; make it clearly different from the others.` : prompt });
        if (base) addFrame(th, { x: base.x + (base.w + 60) * (n + 1), y: base.y });
      }
      setAsk("");
    } catch (e) {
      notify(String(e));
    }
  };

  const renderFrame = useCallback(
    (item: CanvasItem) => <FrameBody item={item} reloads={reloads} servers={servers} onStart={startDev} />,
    [reloads, servers], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const threadItems = useMemo(() => threads.filter((th) => th.branch).map((th) => ({ value: th.id, label: th.title, hint: th.branch ?? undefined })), [threads]);

  if (!board) return <div className="board-loading shimmer" />;
  return (
    <div className="board">
      <header className="board-head">
        <button className="icon-btn" onClick={() => go({ kind: "page", page: "studio", sub: "boards" })} aria-label={t("studio.boards")}>
          <ArrowLeft size={15} />
        </button>
        <input
          className="board-title"
          value={board.name}
          onChange={(e) => setBoard({ ...board, name: e.target.value })}
          onBlur={() => rpc("rename_board", { id, name: board.name }).catch(() => {})}
        />
        <div className="composer-spacer" />
        <div className="board-people">
          {presence
            .filter((p) => p.viewing === id)
            .map((p) => (
              <span key={p.user.id} className="person-avatar" style={{ background: personColor(p.user.name) }} title={p.user.name}>
                {p.user.name.slice(0, 1)}
              </span>
            ))}
        </div>
        <Menu value={null as string | null} items={threadItems} onChange={(tid) => tid && addFrame(threads.find((x) => x.id === tid)!)} icon={<Frame size={14} />} label={t("board.addFrame")} />
      </header>
      <div className="board-body">
        <div className="board-canvas">
          <Canvas
            doc={doc}
            onChange={onChange}
            me={me}
            cursors={cursors}
            onCursor={onCursor}
            onSelectionChange={setSelection}
            renderFrame={renderFrame}
            onFrameAction={(item, action) => {
              if (action === "reload") setReloads((r) => r + 1);
              if (action === "open") {
                const url = item.frame?.kind === "url" ? item.frame.src : item.frame?.threadId ? servers[item.frame.threadId]?.url : undefined;
                if (url) backend.openUrl(url);
                else if (item.frame?.threadId) useStore.getState().openThread(item.frame.threadId);
              }
              if (action === "variant") {
                setAsk(t("board.variantPrompt"));
                setVariants(2);
              }
              if (action === "inspect" && item.frame?.threadId) useStore.getState().openThread(item.frame.threadId);
            }}
          />
          <form
            className="board-ask"
            onSubmit={(e) => {
              e.preventDefault();
              send(ask, variants);
              setVariants(1);
            }}
          >
            {selection.length > 0 && <span className="ask-chip">{t("board.selected", { count: selection.length })}</span>}
            <input className="ask-input" value={ask} placeholder={t("board.ask")} onChange={(e) => setAsk(e.target.value)} />
            <button className="send" disabled={!ask.trim()}>
              <ArrowUp size={15} />
            </button>
          </form>
        </div>
        {selection.length > 0 && (
          <aside className="board-inspector">
            <Inspector
              items={selection}
              onChange={(changed) => {
                const map = new Map(changed.map((c) => [c.id, c]));
                onChange({ ...doc, items: doc.items.map((i) => map.get(i.id) ?? i) });
              }}
            />
          </aside>
        )}
      </div>
    </div>
  );
}
