import { ArrowLeft, ArrowUpRight, Check, Laptop, Monitor, MousePointerClick, RotateCw, Smartphone, Tablet } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { backend } from "../../backend";
import { useT } from "../../i18n";
import type { DevProxy } from "../../protocol/DevProxy";
import type { Thread } from "../../protocol/Thread";
import { rpc, useStore, useWsData } from "../../store";
import { Menu } from "../Menu";
import { Empty } from "../Panel";
import { errText, prefs } from "./state";

type Device = "desktop" | "laptop" | "tablet" | "phone";
const WIDTHS: Record<Device, number | null> = { desktop: null, laptop: 1280, tablet: 768, phone: 390 };
const ICONS = { desktop: Monitor, laptop: Laptop, tablet: Tablet, phone: Smartphone };

export interface Picked {
  selector: string;
  tag: string;
  text: string;
  rect: { x: number; y: number; width: number; height: number };
  outerHTML: string;
  source: { file: string; line: number | null; column?: number | null; approximate?: boolean } | null;
  path?: string;
}

// One proxy per thread, shared by every frame that shows it.
const cache = new Map<string, Promise<DevProxy>>();
const subs = new Map<string, Set<(p: DevProxy | null) => void>>();

function proxyFor(threadId: string, ws: string | null, fresh = false) {
  let p = fresh ? undefined : cache.get(threadId);
  if (!p) {
    p = rpc<DevProxy>("dev_proxy", { thread_id: threadId }, ws);
    cache.set(threadId, p);
    p.then(
      (d) => subs.get(threadId)?.forEach((f) => f(d)),
      () => cache.delete(threadId),
    );
  }
  return p;
}

/**
 * The thread's app through Bouvio's preview proxy (with the element picker),
 * starting its dev server when needed. Null until it is ready or when there
 * is no dev command.
 */
export function useProxiedUrl(threadId: string | null | undefined): string | null {
  return useProxy(threadId).proxy?.url ?? null;
}

function useProxy(threadId: string | null | undefined) {
  const ws = useStore((s) => s.workspaceId);
  const hasDev = useWsData().settings?.dev_command;
  const [proxy, setProxy] = useState<DevProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);

  useEffect(() => {
    useStore.getState().load("settings");
  }, [ws]);

  useEffect(() => {
    setProxy(null);
    setError(null);
    if (!threadId || !hasDev) return;
    let live = true;
    const set = (d: DevProxy | null) => live && setProxy(d);
    if (!subs.has(threadId)) subs.set(threadId, new Set());
    subs.get(threadId)!.add(set);
    proxyFor(threadId, ws, n > 0).then(set, (e) => live && setError(errText(e)));
    return () => {
      live = false;
      subs.get(threadId)?.delete(set);
    };
  }, [threadId, ws, hasDev, n]);

  return { proxy, error, retry: () => setN((x) => x + 1) };
}

/** The picked element as a Markdown block for the agent. */
export function pickedBlock(p: Picked) {
  const where = p.source ? `${p.source.file.replace(/^.*?\/(src|app|pages|components)\//, "$1/")}${p.source.line ? `:${p.source.line}` : ""}` : null;
  const lines = [`**Element** \`${p.selector}\`${p.path ? ` on \`${p.path}\`` : ""}`];
  if (p.text) lines.push(`- Text: "${p.text.length > 160 ? p.text.slice(0, 160) + "…" : p.text}"`);
  if (where) lines.push(`- Source: \`${where}\`${p.source?.approximate ? " (approximate)" : ""}`);
  lines.push(`- Size: ${p.rect.width}×${p.rect.height}`);
  lines.push("", "```html", p.outerHTML, "```");
  return lines.join("\n");
}

export function BrowserPanel({ thread }: { thread: Thread | null }) {
  const t = useT();
  const load = useStore((s) => s.load);
  const go = useStore((s) => s.go);
  const settings = useWsData().settings;
  useEffect(() => {
    load("settings");
  }, [load]);

  if (!thread) return <Empty text={t("dev.browser.noThread")} />;
  if (!settings) return <Empty text={t("dev.loading")} />;
  if (!settings.dev_command)
    return (
      <div className="dv-empty">
        <Monitor size={20} />
        <p>{t("dev.browser.noCommand")}</p>
        <button className="btn small" onClick={() => go({ kind: "page", page: "knowledge" })}>
          {t("dev.browser.setUp")}
        </button>
      </div>
    );
  if (!thread.cwd) return <Empty text={t("dev.browser.noFolder")} />;
  return <Browser key={thread.id} thread={thread} />;
}

function Browser({ thread }: { thread: Thread }) {
  const t = useT();
  const { proxy, error, retry } = useProxy(thread.id);
  const frame = useRef<HTMLIFrameElement>(null);
  const [path, setPath] = useState(() => prefs.get(`bouvio.dev.path.${thread.id}`) ?? "/");
  const [typed, setTyped] = useState(path);
  const [src, setSrc] = useState<string | null>(null);
  const [device, setDevice] = useState<Device>(() => (prefs.get("bouvio.dev.device") as Device) || "desktop");
  const [picking, setPicking] = useState(false);
  const [chip, setChip] = useState<Picked | null>(null);
  const pickRef = useRef(picking);
  pickRef.current = picking;

  useEffect(() => {
    if (proxy) setSrc(proxy.url + (path.startsWith("/") ? path : `/${path}`));
    // Only when the proxy itself changes; in-frame navigation updates `path`.
  }, [proxy?.url]);

  const post = useCallback((msg: unknown) => frame.current?.contentWindow?.postMessage(msg, "*"), []);

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const d = e.data;
      if (!d || typeof d !== "object") return;
      if (d.type === "bouvio:ready" && pickRef.current) post({ type: "bouvio:pick", on: true });
      else if (d.type === "bouvio:location" && typeof d.path === "string") {
        setPath(d.path);
        setTyped(d.path);
        prefs.set(`bouvio.dev.path.${thread.id}`, d.path);
      } else if (d.type === "bouvio:pick-cancel") setPicking(false);
      else if (d.type === "bouvio:picked") {
        setPicking(false);
        const p = d as Picked;
        const s = useStore.getState();
        const current = s.drafts[thread.id] ?? "";
        s.setDraft(thread.id, (current.trim() ? current.replace(/\s*$/, "") + "\n\n" : "") + pickedBlock(p) + "\n\n");
        setChip(p);
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [post, thread.id]);

  useEffect(() => {
    post({ type: "bouvio:pick", on: picking });
  }, [picking, post]);

  useEffect(() => {
    if (!chip) return;
    const id = setTimeout(() => setChip(null), 4000);
    return () => clearTimeout(id);
  }, [chip]);

  useEffect(() => {
    if (!picking) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setPicking(false);
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [picking]);

  const navigate = (p: string) => {
    if (!proxy) return;
    const clean = p.trim().replace(/^https?:\/\/[^/]+/, "") || "/";
    const next = clean.startsWith("/") ? clean : `/${clean}`;
    const url = proxy.url + next;
    setPath(next);
    setTyped(next);
    // The same address again reloads it.
    if (frame.current && src === url) frame.current.src = url;
    else setSrc(url);
  };

  const width = WIDTHS[device];
  const DeviceIcon = ICONS[device];
  return (
    <div className="dv-browser">
      <div className="dv-browser-bar">
        <button className="icon-btn" title={t("dev.browser.back")} aria-label={t("dev.browser.back")} disabled={!proxy} onClick={() => post({ type: "bouvio:nav", action: "back" })}>
          <ArrowLeft size={14} />
        </button>
        <button
          className="icon-btn"
          title={t("dev.browser.reload")}
          aria-label={t("dev.browser.reload")}
          disabled={!proxy}
          onClick={() => {
            post({ type: "bouvio:nav", action: "reload" });
          }}
        >
          <RotateCw size={13} />
        </button>
        <form
          className="dv-address"
          onSubmit={(e) => {
            e.preventDefault();
            navigate(typed);
          }}
        >
          <input value={typed} onChange={(e) => setTyped(e.target.value)} spellCheck={false} aria-label={t("dev.browser.path")} onFocus={(e) => e.currentTarget.select()} />
        </form>
        <Menu
          value={device}
          icon={<DeviceIcon size={14} />}
          label=""
          title={t("dev.browser.device")}
          items={(Object.keys(WIDTHS) as Device[]).map((d) => {
            const I = ICONS[d];
            return { value: d, label: t(`dev.device.${d}`), hint: WIDTHS[d] ? `${WIDTHS[d]}` : undefined, icon: <I size={14} /> };
          })}
          onChange={(d) => {
            setDevice(d);
            prefs.set("bouvio.dev.device", d);
          }}
        />
        <button className={`btn small dv-pick ${picking ? "on" : ""}`} disabled={!proxy} onClick={() => setPicking((p) => !p)} aria-pressed={picking} title={t("dev.browser.pickHint")}>
          <MousePointerClick size={13} />
          {t("dev.browser.pick")}
        </button>
        <button className="icon-btn" title={t("dev.browser.open")} aria-label={t("dev.browser.open")} disabled={!proxy} onClick={() => proxy && backend.openUrl(proxy.url + path)}>
          <ArrowUpRight size={14} />
        </button>
      </div>
      <div className={`dv-stage ${width ? "device" : ""} ${picking ? "picking" : ""}`}>
        {error ? (
          <div className="dv-empty">
            <p>{error}</p>
            <button className="btn small" onClick={retry}>
              {t("dev.retry")}
            </button>
          </div>
        ) : !src ? (
          <Empty text={t("dev.browser.starting")} />
        ) : (
          <iframe
            ref={frame}
            className="dv-frame"
            src={src}
            title={thread.title}
            style={width ? { width } : undefined}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
          />
        )}
        {picking && <div className="dv-pick-hint">{t("dev.browser.picking")}</div>}
        {chip && (
          <div className="dv-chip" role="status">
            <Check size={13} />
            <span>{t("dev.browser.added")}</span>
            <code className="truncate">{chip.source ? `${chip.source.file.split("/").pop()}${chip.source.line ? `:${chip.source.line}` : ""}` : chip.selector}</code>
          </div>
        )}
      </div>
    </div>
  );
}
