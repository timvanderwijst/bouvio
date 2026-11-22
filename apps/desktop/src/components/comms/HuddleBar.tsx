import { GripVertical, Headphones, Maximize2, Mic, MicOff, Minimize2, MonitorUp, PhoneOff, Video, VideoOff, X } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useT } from "../../i18n";
import type { HubUser } from "../../protocol/HubUser";
import { useStore } from "../../store";
import { personColor } from "../Sidebar";
import { joinHuddle, leaveHuddle, MAX_PEOPLE, setExpanded, toggleCamera, toggleMute, toggleScreen, useHuddle, type PeerView } from "./huddle";
import { atLeast, roleIn, useComms } from "./state";

function Media({ stream, muted = false, className }: { stream: MediaStream; muted?: boolean; className?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== stream) ref.current.srcObject = stream;
  }, [stream]);
  return <video ref={ref} className={className} autoPlay playsInline muted={muted} />;
}

function Sound({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== stream) ref.current.srcObject = stream;
  }, [stream]);
  return <audio ref={ref} autoPlay />;
}

function Face({ user, speaking, muted, size = 28 }: { user: Pick<HubUser, "name">; speaking: boolean; muted: boolean; size?: number }) {
  return (
    <span className={`hd-face ${speaking ? "speaking" : ""}`} style={{ width: size, height: size }} title={user.name}>
      <span className="hd-face-in" style={{ background: personColor(user.name) }}>
        {user.name.slice(0, 1).toUpperCase()}
      </span>
      {muted && (
        <span className="hd-face-muted" aria-hidden>
          <MicOff size={9} />
        </span>
      )}
    </span>
  );
}

const POS_KEY = "cuna.ioms.huddlePos";
function savedPos() {
  try {
    const p = JSON.parse(localStorage.getItem(POS_KEY) ?? "");
    if (typeof p?.right === "number" && typeof p?.bottom === "number") return p as { right: number; bottom: number };
  } catch {}
  return { right: 20, bottom: 20 };
}

/** The floating huddle: avatars, controls, and the video grid when expanded.
 * When not in one, a small pill invites you into the current workspace's huddle. */
export function HuddleBar() {
  const t = useT();
  const h = useHuddle();
  const me = useStore((s) => s.hub.user);
  const workspaceId = useStore((s) => s.workspaceId);
  const ws = useStore((s) => s.workspaces.find((w) => w.id === (h.ws ?? s.workspaceId)));
  const people = useComms((s) => (workspaceId ? s.huddles[workspaceId] : undefined));
  const [pos, setPos] = useState(savedPos);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const drag = useRef<{ x: number; y: number; right: number; bottom: number } | null>(null);

  const onDown = (e: ReactPointerEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    drag.current = { x: e.clientX, y: e.clientY, right: pos.right, bottom: pos.bottom };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const right = Math.max(8, Math.min(window.innerWidth - 120, d.right - (e.clientX - d.x)));
    const bottom = Math.max(8, Math.min(window.innerHeight - 60, d.bottom - (e.clientY - d.y)));
    setPos({ right, bottom });
  };
  const onUp = () => {
    if (!drag.current) return;
    drag.current = null;
    try {
      localStorage.setItem(POS_KEY, JSON.stringify(pos));
    } catch {}
  };
  const style = { right: pos.right, bottom: pos.bottom };

  // Not in a huddle: offer to join the one in this workspace.
  if (h.status === "idle") {
    const others = Object.values(people ?? {}).filter((p) => p.user.id !== me?.id);
    const sig = others.map((p) => p.user.id).sort().join(",");
    if (!workspaceId || !others.length || dismissed === sig || !me) return null;
    const canJoin = atLeast(roleIn(ws), "commenter") && others.length < MAX_PEOPLE;
    return (
      <div className="hd hd-invite" style={style} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} role="region" aria-label={t("comms.huddle.title")}>
        <span className="hd-faces">
          {others.slice(0, 4).map((p) => (
            <Face key={p.user.id} user={p.user} speaking={false} muted={false} size={24} />
          ))}
        </span>
        <span className="hd-invite-text truncate">{t("comms.huddle.live", { names: others.map((p) => p.user.name).join(", ") })}</span>
        <button className="btn small primary" disabled={!canJoin} onClick={() => joinHuddle(workspaceId)}>
          <Headphones size={13} />
          {t("comms.huddle.join")}
        </button>
        <button className="icon-btn" aria-label={t("common.cancel")} onClick={() => setDismissed(sig)}>
          <X size={14} />
        </button>
      </div>
    );
  }

  const peers = Object.values(h.peers);
  const tiles: { key: string; name: string; stream?: MediaStream; screen?: boolean; speaking: boolean; muted: boolean; mine?: boolean; state?: PeerView["state"] }[] = [];
  if (h.screen) tiles.push({ key: "me:screen", name: me?.name ?? "", stream: h.screen, screen: true, speaking: false, muted: true, mine: true });
  for (const p of peers) if (p.media.screen && p.screen) tiles.push({ key: `${p.id}:screen`, name: p.user.name, stream: p.screen, screen: true, speaking: false, muted: true });
  tiles.push({ key: "me", name: me?.name ?? "", stream: h.camera, speaking: !!h.speaking.me, muted: h.media.muted, mine: true });
  for (const p of peers) tiles.push({ key: p.id, name: p.user.name, stream: p.media.camera ? p.camera : undefined, speaking: !!h.speaking[p.id], muted: p.media.muted, state: p.state });

  return (
    <div className={`hd hd-live ${h.expanded ? "expanded" : ""}`} style={style} role="region" aria-label={t("comms.huddle.title")}>
      {peers.map((p) => p.audio && <Sound key={p.id} stream={p.audio} />)}
      {h.expanded && (
        <div className={`hd-grid n${Math.min(tiles.length, 9)}`}>
          {tiles.map((tile) => (
            <div key={tile.key} className={`hd-tile ${tile.screen ? "screen" : ""} ${tile.speaking ? "speaking" : ""}`}>
              {tile.stream ? (
                <Media stream={tile.stream} muted className={tile.mine && !tile.screen ? "mirror" : ""} />
              ) : (
                <span className="hd-tile-face" style={{ background: personColor(tile.name) }}>
                  {tile.name.slice(0, 1).toUpperCase()}
                </span>
              )}
              <span className="hd-tile-name">
                {tile.muted && !tile.screen && <MicOff size={11} />}
                {tile.screen ? t("comms.huddle.screenOf", { name: tile.mine ? t("thread.you") : tile.name }) : tile.mine ? t("thread.you") : tile.name}
                {tile.state && tile.state !== "connected" && <span className="hd-state">{t(`comms.huddle.state.${tile.state === "new" ? "connecting" : tile.state}`)}</span>}
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="hd-bar" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}>
        <GripVertical size={14} className="hd-grip" aria-hidden />
        <span className="hd-faces">
          {me && <Face user={me} speaking={!!h.speaking.me} muted={h.media.muted} />}
          {peers.slice(0, 6).map((p) => (
            <Face key={p.id} user={p.user} speaking={!!h.speaking[p.id]} muted={p.media.muted} />
          ))}
        </span>
        <span className="hd-where truncate">
          {h.status === "joining" ? t("comms.huddle.joining") : ws?.name}
          {h.error && <span className="hd-error"> · {h.error}</span>}
        </span>
        <div className="hd-controls">
          <button className={`icon-btn ${h.media.muted ? "off" : ""}`} onClick={toggleMute} aria-pressed={h.media.muted} title={h.media.muted ? t("comms.huddle.unmute") : t("comms.huddle.mute")} aria-label={h.media.muted ? t("comms.huddle.unmute") : t("comms.huddle.mute")}>
            {h.media.muted ? <MicOff size={15} /> : <Mic size={15} />}
          </button>
          <button className={`icon-btn ${h.media.camera ? "on" : ""}`} onClick={toggleCamera} aria-pressed={h.media.camera} title={t("comms.huddle.camera")} aria-label={t("comms.huddle.camera")}>
            {h.media.camera ? <Video size={15} /> : <VideoOff size={15} />}
          </button>
          <button className={`icon-btn ${h.media.screen ? "on" : ""}`} onClick={toggleScreen} aria-pressed={h.media.screen} title={t("comms.huddle.screen")} aria-label={t("comms.huddle.screen")}>
            <MonitorUp size={15} />
          </button>
          <button className="icon-btn" onClick={() => setExpanded(!h.expanded)} title={h.expanded ? t("comms.huddle.collapse") : t("comms.huddle.expand")} aria-label={h.expanded ? t("comms.huddle.collapse") : t("comms.huddle.expand")}>
            {h.expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
          <button className="icon-btn hd-leave" onClick={leaveHuddle} title={t("comms.huddle.leave")} aria-label={t("comms.huddle.leave")}>
            <PhoneOff size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}

/** For the sidebar's People section: who is in this workspace's huddle, one click to join. */
export function HuddleSidebarRow() {
  const t = useT();
  const workspaceId = useStore((s) => s.workspaceId);
  const me = useStore((s) => s.hub.user?.id);
  const people = useComms((s) => (workspaceId ? s.huddles[workspaceId] : undefined));
  const inHuddle = useHuddle((s) => s.ws === workspaceId && s.status !== "idle");
  const list = Object.values(people ?? {}).filter((p) => p.user.id !== me);
  if (!workspaceId || (!list.length && !inHuddle)) return null;
  return (
    <button className="sb-row cm-sb-huddle" onClick={() => (inHuddle ? null : joinHuddle(workspaceId))}>
      <Headphones size={15} />
      <span className="truncate">{inHuddle ? t("comms.huddle.inHuddle") : t("comms.huddle.live", { names: list.map((p) => p.user.name).join(", ") })}</span>
      <span className="cm-live-dot" />
    </button>
  );
}
