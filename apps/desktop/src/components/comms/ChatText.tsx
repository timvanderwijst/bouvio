import { Fragment, type ReactNode } from "react";
import { backend } from "../../backend";
import { useStore } from "../../store";

// Chat text: paragraphs, fenced and inline code, bold, links, links to threads
// (`cuna://thread/<id>`, as leads post them) and @mention chips.
// Nothing is interpreted as HTML.

export interface MentionTarget {
  name: string;
  kind: "person" | "lead" | "me";
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function openThread(id: string) {
  useStore.getState().openThread(id);
}

function inline(text: string, mention: RegExp | null, targets: Map<string, MentionTarget>, base: number): ReactNode[] {
  const parts: string[] = [
    "(`[^`\\n]+`)",
    "(\\*\\*[^*\\n]+\\*\\*)",
    "(\\[[^\\]\\n]+\\]\\((?:https?|cuna):\\/\\/[^)\\s]+\\))",
    "(https?:\\/\\/[^\\s<>()]+[^\\s<>().,;:!?'\"])",
  ];
  if (mention) parts.push(`(${mention.source})`);
  const re = new RegExp(parts.join("|"), "giu");
  const out: ReactNode[] = [];
  let last = 0;
  let k = base;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    let start = m.index;
    let tok = m[0];
    // The mention pattern includes the character before the @.
    if (m[5] !== undefined) {
      const at = tok.indexOf("@");
      start += at;
      tok = tok.slice(at);
    }
    if (start > last) out.push(text.slice(last, start));
    if (m[1]) out.push(<code key={k++}>{tok.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={k++}>{tok.slice(2, -2)}</strong>);
    else if (m[3]) {
      const mm = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/)!;
      const [, label, href] = mm;
      const thread = href.match(/^cuna:\/\/thread\/([0-9a-f-]{36})$/i);
      if (thread)
        out.push(
          <button key={k++} type="button" className="cm-thread-link" onClick={() => openThread(thread[1])}>
            {label}
          </button>,
        );
      else if (/^https?:/.test(href))
        out.push(
          <a key={k++} href={href} target="_blank" rel="noreferrer" onClick={(e) => (e.preventDefault(), backend.openUrl(href))}>
            {label}
          </a>,
        );
      else out.push(label);
    } else if (m[4])
      out.push(
        <a key={k++} href={tok} target="_blank" rel="noreferrer" onClick={(e) => (e.preventDefault(), backend.openUrl(tok))}>
          {tok}
        </a>,
      );
    else {
      const who = tok.slice(1).toLowerCase();
      const target = targets.get(who) ?? (who === "here" ? { name: "here", kind: "person" as const } : undefined);
      out.push(
        <span key={k++} className={`cm-mention ${target?.kind ?? ""}`}>
          {tok}
        </span>,
      );
    }
    last = start + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Text between code fences loses the newline that touches a fence. */
const trimAround = (s: string, start: boolean, end: boolean) => (end ? (start ? s.replace(/^\n/, "") : s).replace(/\n$/, "") : start ? s.replace(/^\n/, "") : s);

export function ChatText({ text, targets }: { text: string; targets: MentionTarget[] }) {
  const map = new Map(targets.map((x) => [x.name.toLowerCase(), x]));
  const names = [...targets.map((x) => x.name), "here"].filter(Boolean).sort((a, b) => b.length - a.length);
  const mention = names.length ? new RegExp(`(?:^|[^\\p{L}\\p{N}_])@(?:${names.map(escapeRe).join("|")})(?![\\p{L}\\p{N}_])`, "u") : null;

  // Split out fenced code first.
  const blocks = text.split(/```/);
  return (
    <div className="cm-text">
      {blocks.map((b, i) =>
        i % 2 === 1 ? (
          <pre key={i} className="cm-pre">
            {b.replace(/^[\w-]*\n/, "")}
          </pre>
        ) : (
          <Fragment key={i}>{inline(trimAround(b, i > 0, i < blocks.length - 1), mention, map, i * 1000)}</Fragment>
        ),
      )}
    </div>
  );
}
