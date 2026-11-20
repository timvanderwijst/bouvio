import { Check, Copy, MessageSquare, Pin, PinOff, SmilePlus } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { ago } from "../../lib/format";
import type { ChatMessage } from "../../protocol/ChatMessage";
import type { ReplySummary } from "../../protocol/ReplySummary";
import { personColor } from "../Sidebar";
import { ChatText, type MentionTarget } from "./ChatText";

export const EMOJI = ["👍", "❤️", "😂", "🎉", "🙏", "👀", "🔥", "✅", "🚀", "💯", "🤔", "😅", "😮", "😢", "👏", "🙌", "💡", "⚡", "🐛", "📌", "👋", "✨", "😎", "🤝"];

export function EmojiPicker({ onPick, onClose }: { onPick: (e: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [up, setUp] = useState(false);
  useLayoutEffect(() => {
    // Open upwards when there is no room below inside the scrolling list.
    const el = ref.current;
    const box = el?.closest(".cm-scroll")?.getBoundingClientRect();
    const r = el?.getBoundingClientRect();
    if (box && r && r.bottom > box.bottom) setUp(true);
  }, []);
  useEffect(() => {
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    ref.current?.querySelector("button")?.focus();
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [onClose]);
  return (
    <div ref={ref} className={`cm-emoji ${up ? "up" : ""}`} role="dialog">
      {EMOJI.map((e) => (
        <button
          key={e}
          type="button"
          onClick={() => {
            onPick(e);
            onClose();
          }}
        >
          {e}
        </button>
      ))}
    </div>
  );
}

export function Avatar({ name, size = "lg" }: { name: string; size?: "lg" | "sm" }) {
  return (
    <span className={`person-avatar ${size === "lg" ? "lg" : ""}`} style={{ background: personColor(name) }} aria-hidden>
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

export function MessageRow({
  m,
  cont,
  me,
  targets,
  names,
  summary,
  canReact,
  canPin,
  inThread,
  highlight,
  onReact,
  onPin,
  onThread,
}: {
  m: ChatMessage;
  /** Same author as the message above, shortly after: no avatar or name. */
  cont: boolean;
  me: string | undefined;
  targets: MentionTarget[];
  /** user id → name, for who reacted. */
  names: Record<string, string>;
  summary?: ReplySummary;
  canReact: boolean;
  canPin: boolean;
  inThread?: boolean;
  highlight?: boolean;
  onReact: (emoji: string) => void;
  onPin?: (pinned: boolean) => void;
  onThread?: () => void;
}) {
  const t = useT();
  const [picker, setPicker] = useState(false);
  const [copied, setCopied] = useState(false);

  return (
    <div id={`cm-${m.id}`} className={`cm-msg ${cont ? "cont" : ""} ${picker ? "held" : ""} ${highlight ? "flash" : ""} ${m.pinned ? "pinned" : ""}`}>
      <div className="cm-gutter">{cont ? <span className="cm-time-hover">{time(m.at)}</span> : <Avatar name={m.author.name} />}</div>
      <div className="cm-body">
        {!cont && (
          <div className="cm-meta">
            <b>{m.author.name}</b>
            <span title={new Date(m.at).toLocaleString()}>{time(m.at)}</span>
            {m.pinned && (
              <span className="cm-pinned-tag">
                <Pin size={11} />
                {t("comms.pinned")}
              </span>
            )}
          </div>
        )}
        <ChatText text={m.text} targets={targets} />
        {m.reactions.length > 0 && (
          <div className="cm-reactions">
            {m.reactions.map(([emoji, users]) => {
              const mine = !!me && users.includes(me);
              const who = users.map((u) => names[u] ?? "?").join(", ");
              return (
                <button
                  key={emoji}
                  type="button"
                  className={`cm-reaction ${mine ? "mine" : ""}`}
                  disabled={!canReact}
                  title={who}
                  aria-pressed={mine}
                  aria-label={`${emoji} ${users.length}: ${who}`}
                  onClick={() => onReact(emoji)}
                >
                  <span>{emoji}</span>
                  <span className="n">{users.length}</span>
                </button>
              );
            })}
            {canReact && (
              <button type="button" className="cm-reaction add" aria-label={t("comms.react")} onClick={() => setPicker(true)}>
                <SmilePlus size={13} />
              </button>
            )}
          </div>
        )}
        {!inThread && summary && summary.count > 0 && (
          <button type="button" className="cm-replies" onClick={onThread}>
            <span className="cm-stack">
              {summary.authors.slice(0, 3).map((a) => (
                <Avatar key={a.id} name={a.name} size="sm" />
              ))}
            </span>
            <b>{t("comms.replies", { count: summary.count })}</b>
            <span>{t("comms.lastReply", { when: ago(summary.last_at) })}</span>
          </button>
        )}
      </div>
      <div className="cm-actions" role="toolbar" aria-label={t("comms.actions")}>
        {canReact && (
          <button type="button" className="icon-btn" title={t("comms.react")} aria-label={t("comms.react")} onClick={() => setPicker((p) => !p)}>
            <SmilePlus size={15} />
          </button>
        )}
        {!inThread && onThread && canReact && (
          <button type="button" className="icon-btn" title={t("comms.replyInThread")} aria-label={t("comms.replyInThread")} onClick={onThread}>
            <MessageSquare size={15} />
          </button>
        )}
        {canPin && onPin && (
          <button type="button" className="icon-btn" title={m.pinned ? t("comms.unpin") : t("comms.pin")} aria-label={m.pinned ? t("comms.unpin") : t("comms.pin")} onClick={() => onPin(!m.pinned)}>
            {m.pinned ? <PinOff size={15} /> : <Pin size={15} />}
          </button>
        )}
        <button
          type="button"
          className="icon-btn"
          title={t("comms.copy")}
          aria-label={t("comms.copy")}
          onClick={() => {
            navigator.clipboard?.writeText(m.text).catch(() => {});
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
        >
          {copied ? <Check size={15} /> : <Copy size={15} />}
        </button>
        {picker && <EmojiPicker onPick={onReact} onClose={() => setPicker(false)} />}
      </div>
    </div>
  );
}

/** "Today", "Yesterday", or the date. */
export function dayLabel(iso: string, today: string, yesterday: string) {
  const d = new Date(iso);
  const now = new Date();
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((start(now) - start(d)) / 86_400_000);
  if (days === 0) return today;
  if (days === 1) return yesterday;
  return d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}

export const sameDay = (a: string, b: string) => new Date(a).toDateString() === new Date(b).toDateString();
export const grouped = (prev: ChatMessage | undefined, m: ChatMessage) =>
  !!prev && prev.author.id === m.author.id && sameDay(prev.at, m.at) && new Date(m.at).getTime() - new Date(prev.at).getTime() < 5 * 60_000;
