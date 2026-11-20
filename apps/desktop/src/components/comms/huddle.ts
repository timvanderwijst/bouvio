// Huddles: a WebRTC mesh (up to ~8 people) for voice, camera and screen.
//
// Signalling goes through the hub (`signal` messages, relayed per workspace):
//   join   broadcast   {peer, media}           a newcomer says hello
//   offer  targeted    {peer, to_peer, sdp}    everyone already there offers to the newcomer
//   answer targeted    {peer, to_peer, sdp}
//   ice    targeted    {peer, to_peer, candidate}
//   state  broadcast   {peer, media}           mute / camera / screen changed
//   leave  broadcast   {peer}
// Every connection carries three transceivers in a fixed order (audio, camera,
// screen), so turning the camera or screen on and off is a `replaceTrack`, never
// a renegotiation.

import { create } from "zustand";
import { backend } from "../../backend";
import type { HubUser } from "../../protocol/HubUser";
import type { HuddleMedia } from "../../protocol/HuddleMedia";
import type { IceConfig } from "../../protocol/IceConfig";
import type { IceServer } from "../../protocol/IceServer";
import type { JsonValue } from "../../../../../crates/protocol/bindings/serde_json/JsonValue";
import { t } from "../../i18n";
import { useStore } from "../../store";
import { useComms, type SignalEvent } from "./state";

export const MAX_PEOPLE = 8;
const DEFAULT_ICE: IceServer[] = [{ urls: ["stun:stun.l.google.com:19302"] }];
const SPEAKING_LEVEL = 0.035;

export interface PeerView {
  id: string;
  user: HubUser;
  media: HuddleMedia;
  state: RTCPeerConnectionState | "new";
  audio?: MediaStream;
  camera?: MediaStream;
  screen?: MediaStream;
}

interface HuddleStore {
  ws: string | null;
  status: "idle" | "joining" | "live";
  error: string | null;
  media: HuddleMedia;
  /** False when the microphone is blocked or missing: listen only. */
  mic: boolean;
  camera?: MediaStream;
  screen?: MediaStream;
  peers: Record<string, PeerView>;
  /** Who is speaking now: peer ids, and "me". */
  speaking: Record<string, boolean>;
  expanded: boolean;
}

export const useHuddle = create<HuddleStore>(() => ({
  ws: null,
  status: "idle",
  error: null,
  media: { muted: false, camera: false, screen: false },
  mic: true,
  peers: {},
  speaking: {},
  expanded: false,
}));

const hs = useHuddle.setState;
const hg = useHuddle.getState;

// ---- module state: the parts that are not React state ------------------------------

interface Peer {
  pc: RTCPeerConnection;
  user: HubUser;
  conn?: number;
  pending: RTCIceCandidateInit[];
}

let myPeer = "";
let ice: IceServer[] = DEFAULT_ICE;
let localAudio: MediaStream | null = null;
const peers = new Map<string, Peer>();
let unlisten: (() => void) | null = null;
let audioCtx: AudioContext | null = null;
const meters = new Map<string, { node: AnalyserNode; source: MediaStreamAudioSourceNode; buf: Uint8Array<ArrayBuffer> }>();
let meterTimer = 0;

const json = (v: unknown) => v as JsonValue;

function signal(kind: string, to: string | null, payload: Record<string, unknown>) {
  const ws = hg().ws;
  if (!ws) return;
  backend.hub.send({ t: "signal", workspace_id: ws, to, kind, payload: json({ ...payload, peer: myPeer }) }).catch(() => {});
}

function setPeer(id: string, p: Partial<PeerView>) {
  hs((s) => {
    const prev = s.peers[id];
    if (!prev && !p.user) return s;
    return { peers: { ...s.peers, [id]: { ...(prev ?? { id, media: { muted: false, camera: false, screen: false }, state: "new" }), ...p } as PeerView } };
  });
}

function permissionText(e: unknown, what: "mic" | "camera" | "screen") {
  const name = (e as DOMException)?.name;
  if (name === "NotAllowedError" || name === "SecurityError") return t(`comms.huddle.blocked.${what}`);
  if (name === "NotFoundError" || name === "OverconstrainedError") return t(`comms.huddle.missing.${what}`);
  if (!navigator.mediaDevices) return t("comms.huddle.unsupported");
  return String((e as Error)?.message ?? e);
}

// ---- joining and leaving ------------------------------------------------------------

export async function joinHuddle(ws: string) {
  const s = hg();
  if (s.status !== "idle") {
    if (s.ws === ws) return;
    leaveHuddle();
  }
  const already = Object.keys(useComms.getState().huddles[ws] ?? {}).length;
  if (already >= MAX_PEOPLE) {
    useStore.getState().notify(t("comms.huddle.full", { max: MAX_PEOPLE }));
    return;
  }
  if (typeof RTCPeerConnection === "undefined") {
    useStore.getState().notify(t("comms.huddle.unsupported"));
    return;
  }
  hs({ ws, status: "joining", error: null, peers: {}, speaking: {}, media: { muted: false, camera: false, screen: false }, mic: true, camera: undefined, screen: undefined });
  myPeer = crypto.randomUUID();
  try {
    const cfg = await backend.hub.request<IceConfig | null>("GET", "/ice");
    ice = cfg?.iceServers?.length ? cfg.iceServers : DEFAULT_ICE;
  } catch {
    ice = DEFAULT_ICE;
  }
  try {
    localAudio = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    meter("me", localAudio);
  } catch (e) {
    localAudio = null;
    hs({ mic: false, media: { ...hg().media, muted: true }, error: permissionText(e, "mic") });
  }
  if (hg().ws !== ws) return; // left while asking for the microphone
  unlisten = backend.on<SignalEvent>("hub-signal", (e) => {
    onSignal(e).catch((err) => console.warn("huddle signal", err));
  });
  const user = useStore.getState().hub.user;
  if (user) {
    useComms.setState((c) => ({ huddles: { ...c.huddles, [ws]: { ...(c.huddles[ws] ?? {}), [user.id]: { user } } } }));
  }
  signal("join", null, { media: hg().media });
  hs({ status: "live" });
  startMeters();
}

export function leaveHuddle() {
  const ws = hg().ws;
  if (!ws) return;
  signal("leave", null, {});
  for (const [id, p] of peers) {
    p.pc.close();
    unmeter(id);
  }
  peers.clear();
  localAudio?.getTracks().forEach((tr) => tr.stop());
  hg().camera?.getTracks().forEach((tr) => tr.stop());
  hg().screen?.getTracks().forEach((tr) => tr.stop());
  localAudio = null;
  unmeter("me");
  stopMeters();
  unlisten?.();
  unlisten = null;
  const user = useStore.getState().hub.user;
  if (user) {
    useComms.setState((c) => {
      const map = { ...(c.huddles[ws] ?? {}) };
      delete map[user.id];
      return { huddles: { ...c.huddles, [ws]: map } };
    });
  }
  hs({ ws: null, status: "idle", peers: {}, speaking: {}, camera: undefined, screen: undefined, expanded: false, error: null });
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => leaveHuddle());
}

// ---- local media ----------------------------------------------------------------------

function senders(pc: RTCPeerConnection) {
  return pc.getTransceivers().map((tr) => tr.sender);
}

function localTracks(): (MediaStreamTrack | null)[] {
  const s = hg();
  return [localAudio?.getAudioTracks()[0] ?? null, s.camera?.getVideoTracks()[0] ?? null, s.screen?.getVideoTracks()[0] ?? null];
}

async function attachLocal(pc: RTCPeerConnection) {
  const tracks = localTracks();
  const list = senders(pc);
  await Promise.all(list.slice(0, 3).map((snd, i) => snd.replaceTrack(tracks[i]).catch(() => {})));
}

function broadcastState() {
  signal("state", null, { media: hg().media });
}

export function toggleMute() {
  const s = hg();
  if (!s.mic || !localAudio) {
    useStore.getState().notify(s.error ?? t("comms.huddle.blocked.mic"));
    return;
  }
  const muted = !s.media.muted;
  localAudio.getAudioTracks().forEach((tr) => (tr.enabled = !muted));
  hs({ media: { ...s.media, muted } });
  broadcastState();
}

async function setSlot(slot: 1 | 2, track: MediaStreamTrack | null) {
  await Promise.all([...peers.values()].map((p) => senders(p.pc)[slot]?.replaceTrack(track).catch(() => {})));
}

export async function toggleCamera() {
  const s = hg();
  if (s.camera) {
    s.camera.getTracks().forEach((tr) => tr.stop());
    hs({ camera: undefined, media: { ...hg().media, camera: false } });
    await setSlot(1, null);
  } else {
    try {
      const cam = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24 } } });
      if (hg().status === "idle") return cam.getTracks().forEach((tr) => tr.stop());
      hs({ camera: cam, media: { ...hg().media, camera: true } });
      await setSlot(1, cam.getVideoTracks()[0]);
    } catch (e) {
      useStore.getState().notify(permissionText(e, "camera"));
      return;
    }
  }
  broadcastState();
}

export async function toggleScreen() {
  const s = hg();
  if (s.screen) {
    s.screen.getTracks().forEach((tr) => tr.stop());
    hs({ screen: undefined, media: { ...hg().media, screen: false } });
    await setSlot(2, null);
  } else {
    try {
      if (!navigator.mediaDevices?.getDisplayMedia) throw new Error(t("comms.huddle.noScreen"));
      const screen = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15 } }, audio: false });
      if (hg().status === "idle") return screen.getTracks().forEach((tr) => tr.stop());
      const track = screen.getVideoTracks()[0];
      track.contentHint = "detail";
      // The browser's own "Stop sharing" button.
      track.addEventListener("ended", () => {
        if (hg().screen === screen) toggleScreen();
      });
      hs({ screen, media: { ...hg().media, screen: true }, expanded: true });
      await setSlot(2, track);
    } catch (e) {
      // Cancelling the picker is not an error worth a toast.
      if ((e as DOMException)?.name !== "NotAllowedError" && (e as DOMException)?.name !== "AbortError") useStore.getState().notify(permissionText(e, "screen"));
      return;
    }
  }
  broadcastState();
}

export function setExpanded(expanded: boolean) {
  hs({ expanded });
}

// ---- peers ------------------------------------------------------------------------------

function newPeer(id: string, user: HubUser, conn: number | undefined, offerer: boolean): Peer {
  const old = peers.get(id);
  if (old) {
    old.pc.close();
    unmeter(id);
  }
  const pc = new RTCPeerConnection({ iceServers: ice as RTCIceServer[] });
  const peer: Peer = { pc, user, conn, pending: [] };
  peers.set(id, peer);
  if (offerer) {
    pc.addTransceiver("audio", { direction: "sendrecv" });
    pc.addTransceiver("video", { direction: "sendrecv" });
    pc.addTransceiver("video", { direction: "sendrecv" });
  }
  pc.onicecandidate = (e) => {
    if (e.candidate) signal("ice", user.id, { to_peer: id, candidate: e.candidate.toJSON() });
  };
  pc.ontrack = (e) => {
    const slot = pc.getTransceivers().indexOf(e.transceiver);
    const stream = new MediaStream([e.track]);
    if (slot === 0) {
      setPeer(id, { audio: stream });
      meter(id, stream);
    } else if (slot === 1) setPeer(id, { camera: stream });
    else if (slot === 2) setPeer(id, { screen: stream });
  };
  pc.onconnectionstatechange = () => {
    setPeer(id, { state: pc.connectionState });
    // One retry with fresh ICE from the side that made the first offer.
    if (pc.connectionState === "failed" && offerer && peers.get(id)?.pc === pc) {
      pc.createOffer({ iceRestart: true })
        .then((o) => pc.setLocalDescription(o))
        .then(() => signal("offer", user.id, { to_peer: id, sdp: pc.localDescription?.sdp, media: hg().media }))
        .catch(() => {});
    }
  };
  setPeer(id, { user, state: "new" });
  return peer;
}

function dropPeer(id: string) {
  const p = peers.get(id);
  if (!p) return;
  p.pc.close();
  peers.delete(id);
  unmeter(id);
  hs((s) => {
    const next = { ...s.peers };
    delete next[id];
    const speaking = { ...s.speaking };
    delete speaking[id];
    return { peers: next, speaking };
  });
}

async function flush(p: Peer) {
  const list = p.pending.splice(0);
  for (const c of list) await p.pc.addIceCandidate(c).catch(() => {});
}

async function onSignal(e: SignalEvent) {
  const s = hg();
  if (e.workspace_id !== s.ws || s.status === "idle") return;
  const p = e.payload ?? {};
  const from: string | undefined = p.peer;
  // The hub's own leave, when someone's connection dropped, names the connection.
  if (e.kind === "leave" && !from) return dropConn(e.from.id, p.conn);
  if (!from || from === myPeer) return;
  if (p.to_peer && p.to_peer !== myPeer) return; // for another tab of mine

  switch (e.kind) {
    case "join": {
      if (peers.size + 1 >= MAX_PEOPLE) return;
      // Whoever is already here offers to the newcomer.
      const peer = newPeer(from, e.from, p.conn, true);
      setPeer(from, { media: p.media ?? { muted: false, camera: false, screen: false } });
      await attachLocal(peer.pc);
      const offer = await peer.pc.createOffer();
      await peer.pc.setLocalDescription(offer);
      signal("offer", e.from.id, { to_peer: from, sdp: offer.sdp, media: hg().media });
      break;
    }
    case "offer": {
      let peer = peers.get(from);
      // Both sides offered at once: the lower peer id gives way and answers.
      if (peer && peer.pc.signalingState === "have-local-offer") {
        if (myPeer > from) return;
        peer = undefined;
      }
      if (!peer || peer.pc.connectionState === "closed") peer = newPeer(from, e.from, p.conn, false);
      if (p.media) setPeer(from, { media: p.media });
      await peer.pc.setRemoteDescription({ type: "offer", sdp: p.sdp });
      for (const tr of peer.pc.getTransceivers()) tr.direction = "sendrecv";
      await attachLocal(peer.pc);
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      signal("answer", e.from.id, { to_peer: from, sdp: answer.sdp });
      await flush(peer);
      break;
    }
    case "answer": {
      const peer = peers.get(from);
      if (!peer || peer.pc.signalingState !== "have-local-offer") return;
      await peer.pc.setRemoteDescription({ type: "answer", sdp: p.sdp });
      await flush(peer);
      break;
    }
    case "ice": {
      const peer = peers.get(from);
      if (!peer || !p.candidate) return;
      if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(p.candidate).catch(() => {});
      else peer.pending.push(p.candidate);
      break;
    }
    case "state": {
      if (p.media) setPeer(from, { media: p.media });
      break;
    }
    case "leave": {
      dropPeer(from);
      break;
    }
  }
}

/** The hub says a connection hung up: drop the peer it carried. */
export function dropConn(user: string, conn: number | undefined) {
  for (const [id, p] of peers) if (p.user.id === user && (conn === undefined || p.conn === conn)) dropPeer(id);
}

// ---- who is speaking --------------------------------------------------------------------

function meter(id: string, stream: MediaStream) {
  try {
    audioCtx ??= new AudioContext();
    if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
    unmeter(id);
    const source = audioCtx.createMediaStreamSource(stream);
    const node = audioCtx.createAnalyser();
    node.fftSize = 512;
    source.connect(node);
    meters.set(id, { node, source, buf: new Uint8Array(new ArrayBuffer(node.fftSize)) });
  } catch {
    // No WebAudio: no speaking ring, nothing else breaks.
  }
}

function unmeter(id: string) {
  const m = meters.get(id);
  if (!m) return;
  m.source.disconnect();
  meters.delete(id);
}

function startMeters() {
  stopMeters();
  meterTimer = window.setInterval(() => {
    const s = hg();
    let changed = false;
    const next: Record<string, boolean> = { ...s.speaking };
    for (const [id, m] of meters) {
      m.node.getByteTimeDomainData(m.buf);
      let sum = 0;
      for (let i = 0; i < m.buf.length; i++) {
        const v = (m.buf[i] - 128) / 128;
        sum += v * v;
      }
      const loud = Math.sqrt(sum / m.buf.length) > SPEAKING_LEVEL && !(id === "me" && s.media.muted) && !(id !== "me" && s.peers[id]?.media.muted);
      if (!!next[id] !== loud) {
        next[id] = loud;
        changed = true;
      }
    }
    if (changed) hs({ speaking: next });
  }, 150);
}

function stopMeters() {
  window.clearInterval(meterTimer);
  meterTimer = 0;
}
