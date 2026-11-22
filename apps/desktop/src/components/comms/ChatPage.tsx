import { Hash, Headphones, Pin, Plus, X } from "lucide-react";
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useT } from "../../i18n";
import type { ChatMessage } from "../../protocol/ChatMessage";
import { useStore, useWorkspace, useWorkspaceLeads, useWsData } from "../../store";
import { Empty } from "../Panel";
import { ChatComposer, type Mentionable } from "./ChatComposer";
import type { MentionTarget } from "./ChatText";
import { joinHuddle, leaveHuddle, MAX_PEOPLE, useHuddle } from "./huddle";
import { Avatar, dayLabel, grouped, MessageRow, sameDay } from "./Message";
import {
  atLeast,
  channelKey,
  closeChannel,
  createChannel,
  GENERAL,
  loadChannel,
  loadChannels,
  loadHuddle,
  loadOlder,
  loadPinned,
  loadThread,
  markRead,
  pin,
  react,
  reply,
  roleIn,
  send,
  useComms,
} from "./state";

const EMPTY: ChatMessage[] = [];
const lastChannel = (ws: string) => {
  try {
    return localStorage.getItem(`cuna.ioms.channel.${ws}`) || GENERAL;
  } catch {
    return GENERAL;
  }
};

/** `sub` from navigation: `channel`, or `channel~message` to jump to a message,
 * or `channel~message~thread` to open its thread. */
function parseSub(sub: string | undefined) {
  if (!sub) return null;
  const [channel, message, thread] = sub.split("~");
  return { channel: channel || GENERAL, message: message || null, thread: thread === "thread" };
}

export function ChatPage({ sub }: { sub?: string }) {
  const t = useT();
  const ws = useWorkspace();
  const hub = useStore((s) => s.hub);
  const setDialog = useStore((s) => s.setDialog);
  const shared = ws?.kind === "shared";

  if (!ws || !shared)
    return (
      <div className="page soon">
        <h1 className="page-title">{t("chat.notShared")}</h1>
        <p>{t("chat.notSharedHint")}</p>
        <button className="btn primary" onClick={() => setDialog("share")}>
          {t("share.title")}
        </button>
      </div>
    );
  if (!hub.user)
    return (
      <div className="page soon">
        <h1 className="page-title">{t("comms.signedOut")}</h1>
        <p>{t("comms.signedOutHint")}</p>
        <button className="btn primary" onClick={() => setDialog("signin")}>
          {t("hub.signIn")}
        </button>
      </div>
    );
  return <Chat key={ws.id} wsId={ws.id} sub={sub} />;
}

function Chat({ wsId, sub }: { wsId: string; sub?: string }) {
  const t = useT();
  const ws = useWorkspace()!;
  const hubUser = useStore((s) => s.hub.user);
  const load = useStore((s) => s.load);
  const notify = useStore((s) => s.notify);
  const data = useWsData();
  const leads = useWorkspaceLeads();
  const role = roleIn(ws);
  const canWrite = atLeast(role, "commenter");
  const canPin = atLeast(role, "operator");

  const target = parseSub(sub);
  const [channel, setChannel] = useState(() => target?.channel ?? lastChannel(wsId));
  const [thread, setThread] = useState<string | null>(target?.thread ? target.message : null);
  const [flash, setFlash] = useState<string | null>(target?.message ?? null);

  useEffect(() => {
    const next = parseSub(sub);
    if (!next) return;
    setChannel(next.channel);
    setThread(next.thread ? next.message : null);
    setFlash(next.message);
  }, [sub]);

  const k = channelKey(wsId, channel);
  const messages = useComms((s) => s.messages[k]) ?? EMPTY;
  const complete = useComms((s) => s.complete[k]);
  const summaries = useComms((s) => s.summaries);
  const channels = useComms((s) => s.channels[wsId]);
  const pinned = useComms((s) => s.pinned[wsId]) ?? EMPTY;
  const unread = useComms((s) => s.unread);
  const huddlePeople = useComms((s) => s.huddles[wsId]);
  const inHuddle = useHuddle((s) => s.ws === wsId && s.status !== "idle");

  useEffect(() => {
    load("members", true);
    loadChannels(wsId).catch(() => {});
    loadPinned(wsId).catch(() => {});
    loadHuddle(wsId).catch(() => {});
    return () => closeChannel();
  }, [wsId, load]);

  const [loading, setLoading] = useState(false);
  useEffect(() => {
    try {
      localStorage.setItem(`cuna.ioms.channel.${wsId}`, channel);
    } catch {}
    markRead(wsId, channel);
    setLoading(true);
    loadChannel(wsId, channel)
      .catch((e) => notify(String(e)))
      .finally(() => setLoading(false));
  }, [wsId, channel, notify]);

  // Mention targets and names.
  const members = data.members ?? [];
  const people: Mentionable[] = useMemo(
    () => [
      ...leads.map((c) => ({ key: `c:${c.id}`, name: c.name, lead: c })),
      ...members.filter((m) => m.user.id !== hubUser?.id).map((m) => ({ key: `u:${m.user.id}`, name: m.user.name, user: m.user })),
    ],
    [leads, members, hubUser?.id],
  );
  const targets: MentionTarget[] = useMemo(
    () => [
      ...leads.map((c) => ({ name: c.name, kind: "lead" as const })),
      ...members.map((m) => ({ name: m.user.name, kind: m.user.id === hubUser?.id ? ("me" as const) : ("person" as const) })),
    ],
    [leads, members, hubUser?.id],
  );
  const names = useMemo(() => Object.fromEntries(members.map((m) => [m.user.id, m.user.name])), [members]);

  // Scrolling: stay at the bottom unless reading back; keep the place when older messages load.
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const prevHeight = useRef(0);
  const prevFirst = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const first = messages[0]?.id;
    if (prevFirst.current && first !== prevFirst.current && prevHeight.current) {
      el.scrollTop += el.scrollHeight - prevHeight.current;
    } else if (atBottom.current && !flash) {
      el.scrollTop = el.scrollHeight;
    }
    prevFirst.current = first;
    prevHeight.current = el.scrollHeight;
  }, [messages, flash]);
  useEffect(() => {
    atBottom.current = true;
    prevFirst.current = undefined;
  }, [channel]);
  useEffect(() => {
    if (!flash) return;
    const el = document.getElementById(`cm-${flash}`);
    if (!el) return;
    el.scrollIntoView({ block: "center" });
    const tm = setTimeout(() => setFlash(null), 1600);
    return () => clearTimeout(tm);
  }, [flash, messages]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    if (el.scrollTop < 80 && !complete && !loading && messages.length) {
      prevHeight.current = el.scrollHeight;
      setLoading(true);
      loadOlder(wsId, channel)
        .catch(() => {})
        .finally(() => setLoading(false));
    }
  };

  const doReact = useCallback((id: string, emoji: string) => react(wsId, id, emoji).catch((e) => notify(String(e))), [wsId, notify]);
  const doPin = useCallback((id: string, p: boolean) => pin(wsId, id, p).catch((e) => notify(String(e))), [wsId, notify]);

  const [pinsOpen, setPinsOpen] = useState(false);
  const [newChannel, setNewChannel] = useState<string | null>(null);
  const others = Object.values(huddlePeople ?? {}).filter((p) => p.user.id !== hubUser?.id);
  const huddleFull = Object.keys(huddlePeople ?? {}).length >= MAX_PEOPLE && !inHuddle;
  const online = members.filter((m) => m.online);

  return (
    <div className={`cm ${thread ? "with-thread" : ""}`}>
      <aside className="cm-side" aria-label={t("comms.channels")}>
        <div className="cm-side-head">
          <span>{t("comms.channels")}</span>
          {canWrite && (
            <button className="icon-btn" title={t("comms.newChannel")} aria-label={t("comms.newChannel")} onClick={() => setNewChannel("")}>
              <Plus size={14} />
            </button>
          )}
        </div>
        {(channels ?? [{ name: GENERAL }]).map((c) => {
          const n = c.name === channel ? 0 : unread[channelKey(wsId, c.name)] ?? 0;
          return (
            <button
              key={c.name}
              className={`sb-row cm-channel ${c.name === channel ? "active" : ""} ${n ? "unread" : ""}`}
              onClick={() => {
                setChannel(c.name);
                setThread(null);
              }}
            >
              <Hash size={14} />
              <span className="truncate">{c.name === GENERAL ? t("ws.general") : c.name}</span>
              {n > 0 && <span className="sb-count">{n}</span>}
            </button>
          );
        })}
        {newChannel !== null && (
          <form
            className="cm-new-channel"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!newChannel.trim()) return setNewChannel(null);
              try {
                const ch = await createChannel(wsId, newChannel);
                setChannel(ch.name);
                setThread(null);
                setNewChannel(null);
              } catch (err) {
                notify(String(err));
              }
            }}
          >
            <Hash size={14} />
            <input
              className="input"
              autoFocus
              value={newChannel}
              placeholder={t("comms.channelName")}
              aria-label={t("comms.channelName")}
              onChange={(e) => setNewChannel(e.target.value)}
              onBlur={() => !newChannel.trim() && setNewChannel(null)}
              onKeyDown={(e) => e.key === "Escape" && setNewChannel(null)}
            />
          </form>
        )}
        {others.length > 0 && !inHuddle && (
          <button className="cm-side-huddle" onClick={() => joinHuddle(wsId)} disabled={!canWrite || huddleFull} title={t("comms.huddle.join")}>
            <Headphones size={14} />
            <span className="truncate">{t("comms.huddle.live", { names: others.map((p) => p.user.name).join(", ") })}</span>
            <span className="cm-live-dot" />
          </button>
        )}
      </aside>

      <section className="cm-main">
        <header className="cm-head">
          <Hash size={16} className="cm-head-hash" />
          <h1 className="cm-title">{channel === GENERAL ? t("ws.general") : channel}</h1>
          <span className="cm-head-sub">{t("comms.online", { count: online.length, total: members.length })}</span>
          <div className="composer-spacer" />
          <span className="cm-stack cm-people" aria-hidden>
            {members.slice(0, 5).map((m) => (
              <Avatar key={m.user.id} name={m.user.name} size="sm" />
            ))}
          </span>
          <div className="cm-pop-wrap">
            <button className={`btn small ghost ${pinsOpen ? "on" : ""}`} onClick={() => setPinsOpen((o) => !o)} aria-expanded={pinsOpen} title={t("comms.pinnedTitle")}>
              <Pin size={14} />
              {pinned.length > 0 && <span>{pinned.length}</span>}
            </button>
            {pinsOpen && <Pins wsId={wsId} list={pinned} onClose={() => setPinsOpen(false)} onOpen={(m) => {
              setPinsOpen(false);
              if (m.parent) {
                setChannel(m.channel);
                setThread(m.parent);
              } else {
                setChannel(m.channel);
                setFlash(m.id);
              }
            }} />}
          </div>
          <button
            className={`btn small ${inHuddle ? "cm-huddle-on" : others.length ? "primary" : ""}`}
            disabled={!canWrite || huddleFull}
            title={!canWrite ? t("comms.needsCommenter") : huddleFull ? t("comms.huddle.full", { max: MAX_PEOPLE }) : undefined}
            onClick={() => (inHuddle ? leaveHuddle() : joinHuddle(wsId))}
          >
            <Headphones size={14} />
            {inHuddle ? t("comms.huddle.leave") : others.length ? t("comms.huddle.joinCount", { count: others.length }) : t("comms.huddle.start")}
          </button>
        </header>

        <div className="cm-scroll" ref={scroller} onScroll={onScroll}>
          <div className="cm-list">
            {complete && messages.length > 0 && <div className="cm-start">{t("comms.channelStart", { channel: channel === GENERAL ? t("ws.general") : channel })}</div>}
            {messages.length === 0 && !loading && <Empty text={t("comms.channelEmpty")} />}
            {messages.map((m, i) => {
              const prev = messages[i - 1];
              const newDay = !prev || !sameDay(prev.at, m.at);
              return (
                <Fragment key={m.id}>
                  {newDay && (
                    <div className="cm-day" role="separator">
                      <span>{dayLabel(m.at, t("comms.today"), t("comms.yesterday"))}</span>
                    </div>
                  )}
                  <MessageRow
                    m={m}
                    cont={grouped(prev, m)}
                    me={hubUser?.id}
                    targets={targets}
                    names={names}
                    summary={summaries[m.id]}
                    canReact={canWrite}
                    canPin={canPin}
                    highlight={flash === m.id}
                    onReact={(e) => doReact(m.id, e)}
                    onPin={(p) => doPin(m.id, p)}
                    onThread={() => setThread(m.id)}
                  />
                </Fragment>
              );
            })}
          </div>
        </div>
        <ChatComposer
          key={k}
          draftKey={k}
          autoFocus
          people={people}
          placeholder={t("comms.messageChannel", { channel: channel === GENERAL ? t("ws.general") : channel })}
          disabled={!canWrite}
          disabledHint={t("comms.needsCommenter")}
          hostName={ws.host?.name ?? null}
          onSend={(text) => {
            atBottom.current = true;
            send(wsId, channel, text).catch((e) => notify(String(e)));
          }}
        />
      </section>

      {thread && (
        <ThreadPanel
          wsId={wsId}
          parentId={thread}
          root={messages.find((m) => m.id === thread)}
          targets={targets}
          names={names}
          people={people}
          canWrite={canWrite}
          canPin={canPin}
          hostName={ws.host?.name ?? null}
          onReact={doReact}
          onPin={doPin}
          onClose={() => setThread(null)}
        />
      )}
    </div>
  );
}

function Pins({ wsId, list, onClose, onOpen }: { wsId: string; list: ChatMessage[]; onClose: () => void; onOpen: (m: ChatMessage) => void }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    loadPinned(wsId).catch(() => {});
    const close = (e: MouseEvent) => !ref.current?.parentElement?.contains(e.target as Node) && onClose();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [wsId, onClose]);
  return (
    <div ref={ref} className="cm-pop" role="dialog" aria-label={t("comms.pinnedTitle")}>
      <div className="cm-pop-head">{t("comms.pinnedTitle")}</div>
      {list.length === 0 && <div className="cm-pop-empty">{t("comms.noPins")}</div>}
      {list.map((m) => (
        <button key={m.id} className="cm-pin-row" onClick={() => onOpen(m)}>
          <span className="cm-pin-meta">
            <b>{m.author.name}</b> · #{m.channel === GENERAL ? t("ws.general") : m.channel} · {new Date(m.at).toLocaleDateString()}
          </span>
          <span className="cm-pin-text">{m.text}</span>
        </button>
      ))}
    </div>
  );
}

function ThreadPanel({
  wsId,
  parentId,
  root,
  targets,
  names,
  people,
  canWrite,
  canPin,
  hostName,
  onReact,
  onPin,
  onClose,
}: {
  wsId: string;
  parentId: string;
  root?: ChatMessage;
  targets: MentionTarget[];
  names: Record<string, string>;
  people: Mentionable[];
  canWrite: boolean;
  canPin: boolean;
  hostName: string | null;
  onReact: (id: string, emoji: string) => void;
  onPin: (id: string, pinned: boolean) => void;
  onClose: () => void;
}) {
  const t = useT();
  const me = useStore((s) => s.hub.user?.id);
  const notify = useStore((s) => s.notify);
  const replies = useComms((s) => s.replies[parentId]) ?? EMPTY;
  const [parent, setParent] = useState<ChatMessage | undefined>(root);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadThread(wsId, parentId).catch((e) => notify(String(e)));
  }, [wsId, parentId, notify]);
  useEffect(() => {
    if (root) setParent(root);
  }, [root]);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [replies.length]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && !(e.target as HTMLElement)?.closest?.(".cm-emoji") && onClose();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);

  return (
    <aside className="cm-thread" aria-label={t("comms.thread")}>
      <header className="cm-thread-head">
        <b>{t("comms.thread")}</b>
        {parent && <span className="cm-head-sub">#{parent.channel === GENERAL ? t("ws.general") : parent.channel}</span>}
        <div className="composer-spacer" />
        <button className="icon-btn" onClick={onClose} aria-label={t("common.cancel")}>
          <X size={15} />
        </button>
      </header>
      <div className="cm-scroll">
        <div className="cm-list is-thread">
          {parent && (
            <MessageRow m={parent} cont={false} me={me} targets={targets} names={names} canReact={canWrite} canPin={canPin} inThread onReact={(e) => onReact(parent.id, e)} onPin={(p) => onPin(parent.id, p)} />
          )}
          {replies.length > 0 && (
            <div className="cm-day thin" role="separator">
              <span>{t("comms.replies", { count: replies.length })}</span>
            </div>
          )}
          {replies.map((m, i) => (
            <MessageRow
              key={m.id}
              m={m}
              cont={grouped(replies[i - 1], m)}
              me={me}
              targets={targets}
              names={names}
              canReact={canWrite}
              canPin={canPin}
              inThread
              onReact={(e) => onReact(m.id, e)}
              onPin={(p) => onPin(m.id, p)}
            />
          ))}
          <div ref={end} />
        </div>
      </div>
      <ChatComposer
        key={parentId}
        draftKey={`thread:${parentId}`}
        autoFocus
        leadHint={false}
        people={people}
        placeholder={t("comms.replyPlaceholder")}
        disabled={!canWrite}
        disabledHint={t("comms.needsCommenter")}
        hostName={hostName}
        onSend={(text) => reply(wsId, parentId, text).catch((e) => notify(String(e)))}
      />
    </aside>
  );
}
