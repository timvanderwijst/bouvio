import { AtSign, Send } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useT } from "../../i18n";
import type { Captain } from "../../protocol/Captain";
import type { HubUser } from "../../protocol/HubUser";
import { PixelAvatar } from "../PixelAvatar";
import { personColor } from "../Sidebar";

const drafts = new Map<string, string>();

export interface Mentionable {
  key: string;
  name: string;
  captain?: Captain;
  user?: HubUser;
}

/** The `@word` right before the caret, if the caret is in one. */
function mentionAt(text: string, caret: number) {
  const before = text.slice(0, caret);
  const m = before.match(/(^|[\s(])@([\p{L}\p{N}_.-]*(?: [\p{L}\p{N}_.-]*)?)$/u);
  if (!m) return null;
  return { start: caret - m[2].length - 1, query: m[2] };
}

export function ChatComposer({
  placeholder,
  people,
  disabled,
  disabledHint,
  hostName,
  onSend,
  autoFocus,
  draftKey,
  captainHint = true,
}: {
  placeholder: string;
  people: Mentionable[];
  disabled?: boolean;
  disabledHint?: string;
  hostName?: string | null;
  onSend: (text: string) => void;
  autoFocus?: boolean;
  /** Keeps a draft per channel or thread while the page is open. */
  draftKey: string;
  /** Say that `@Captain …` at the start runs on the host (top-level messages only). */
  captainHint?: boolean;
}) {
  const t = useT();
  const [text, setText] = useState(() => drafts.get(draftKey) ?? "");
  const [pick, setPick] = useState<{ start: number; query: string } | null>(null);
  const [hot, setHot] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);

  // Parents key this component by `draftKey`, so state starts fresh per channel.
  useEffect(() => {
    drafts.set(draftKey, text);
  }, [draftKey, text]);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus, draftKey]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  const matches = useMemo(() => {
    if (!pick) return [];
    const q = pick.query.toLowerCase();
    return people.filter((p) => p.name.toLowerCase().startsWith(q) || p.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(q))).slice(0, 8);
  }, [pick, people]);

  const captainLead = useMemo(() => {
    const m = text.trimStart().match(/^@(.+)/s);
    if (!m) return null;
    const rest = m[1].toLowerCase();
    return people
      .filter((p) => p.captain && rest.startsWith(p.name.toLowerCase()))
      .sort((a, b) => b.name.length - a.name.length)[0];
  }, [text, people]);

  function choose(p: Mentionable) {
    if (!pick) return;
    const el = ref.current;
    const caret = el?.selectionStart ?? text.length;
    const next = `${text.slice(0, pick.start)}@${p.name} ${text.slice(caret)}`;
    setText(next);
    setPick(null);
    const pos = pick.start + p.name.length + 2;
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(pos, pos);
    });
  }

  function update(value: string, caret: number) {
    setText(value);
    const m = mentionAt(value, caret);
    setPick(m);
    setHot(0);
  }

  function submit() {
    const body = text.trim();
    if (!body || disabled) return;
    onSend(body);
    setText("");
    setPick(null);
  }

  if (disabled)
    return (
      <div className="cm-composer disabled">
        <span>{disabledHint}</span>
      </div>
    );

  return (
    <div className="cm-composer-wrap">
      {captainHint && captainLead?.captain && (
        <div className="cm-composer-hint">
          <PixelAvatar seed={captainLead.captain.avatar_seed} size={14} />
          {hostName ? t("comms.captainRunsOn", { name: captainLead.name, host: hostName }) : t("comms.captainRunsHere", { name: captainLead.name })}
        </div>
      )}
      <form
        className="cm-composer"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {pick && matches.length > 0 && (
          <div className="menu-list up cm-mentions" role="listbox">
            {matches.map((p, i) => (
              <button
                type="button"
                key={p.key}
                role="option"
                aria-selected={i === hot}
                className={`menu-item ${i === hot ? "hot" : ""}`}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setHot(i)}
                onClick={() => choose(p)}
              >
                <span className="menu-icon">
                  {p.captain ? (
                    <PixelAvatar seed={p.captain.avatar_seed} size={16} />
                  ) : (
                    <span className="person-avatar" style={{ background: personColor(p.name) }}>
                      {p.name.slice(0, 1)}
                    </span>
                  )}
                </span>
                <span className="menu-label">{p.name}</span>
                <span className="menu-hint">{p.captain ? t("comms.captain") : p.user?.email}</span>
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={ref}
          rows={1}
          value={text}
          placeholder={placeholder}
          aria-label={placeholder}
          onChange={(e) => update(e.target.value, e.target.selectionStart)}
          onClick={(e) => setPick(mentionAt(text, e.currentTarget.selectionStart))}
          onBlur={() => setTimeout(() => setPick(null), 100)}
          onKeyDown={(e) => {
            if (pick && matches.length) {
              if (e.key === "ArrowDown") return e.preventDefault(), setHot((h) => (h + 1) % matches.length);
              if (e.key === "ArrowUp") return e.preventDefault(), setHot((h) => (h - 1 + matches.length) % matches.length);
              if (e.key === "Enter" || e.key === "Tab") return e.preventDefault(), choose(matches[hot]);
              if (e.key === "Escape") return e.preventDefault(), setPick(null);
            }
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <button
          type="button"
          className="icon-btn"
          title={t("comms.mention")}
          aria-label={t("comms.mention")}
          onClick={() => {
            const el = ref.current;
            const caret = el?.selectionStart ?? text.length;
            const pre = text.slice(0, caret);
            const add = pre && !/\s$/.test(pre) ? " @" : "@";
            update(pre + add + text.slice(caret), caret + add.length);
            requestAnimationFrame(() => {
              el?.focus();
              el?.setSelectionRange(caret + add.length, caret + add.length);
            });
          }}
        >
          <AtSign size={15} />
        </button>
        <button className="send" disabled={!text.trim()} aria-label={t("composer.send")}>
          <Send size={14} />
        </button>
      </form>
    </div>
  );
}

