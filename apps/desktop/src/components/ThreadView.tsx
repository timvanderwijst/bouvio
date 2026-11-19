import { AlertTriangle, ChevronRight, FileText, Globe, Pencil, Search, SquareTerminal, Wrench } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useT } from "../i18n";
import type { Thread } from "../protocol/Thread";
import type { ThreadEnvelope } from "../protocol/ThreadEnvelope";
import { useStore } from "../store";
import { duration, toolSummary } from "../lib/format";
import { Markdown } from "./Markdown";
import { ApprovalCard, ArtifactCard, SpawnedRow } from "./ThreadExtras";
import type { Artifact } from "../protocol/Artifact";
import { StatusIcon } from "./StatusIcon";

interface Tool {
  id: string;
  name: string;
  input: unknown;
  output?: string;
  error?: boolean;
}

type Item =
  | { kind: "user"; text: string; author: string; key: string }
  | { kind: "text"; text: string; key: string }
  | { kind: "steps"; tools: Tool[]; first: boolean; start: number; ms?: number; key: string }
  | { kind: "error"; text: string; key: string }
  | { kind: "approval"; id: string; tool: string; input: unknown; resolved?: { allowed: boolean; by: string }; key: string }
  | { kind: "spawned"; threadId: string; title: string; key: string }
  | { kind: "artifact"; artifact: Artifact; key: string };

/** Fold the flat event log into what a person reads: messages and turns of work. */
function fold(events: ThreadEnvelope[]): Item[] {
  const items: Item[] = [];
  const byId = new Map<string, Tool>();
  let steps: Extract<Item, { kind: "steps" }> | null = null;
  let turnFirst: Extract<Item, { kind: "steps" }> | null = null;

  for (const { event: e, seq, at } of events) {
    const key = String(seq);
    switch (e.type) {
      case "user_message":
        items.push({ kind: "user", text: e.text, author: e.author, key });
        steps = { kind: "steps", tools: [], first: true, start: new Date(at).getTime(), key: `s${key}` };
        turnFirst = steps;
        items.push(steps);
        break;
      case "tool_use": {
        if (!steps) {
          steps = { kind: "steps", tools: [], first: false, start: new Date(at).getTime(), key: `s${key}` };
          items.push(steps);
        }
        const tool: Tool = { id: e.id, name: e.name, input: e.input };
        byId.set(e.id, tool);
        steps.tools.push(tool);
        break;
      }
      case "tool_result": {
        const tool = byId.get(e.tool_use_id);
        if (tool) {
          tool.output = e.output;
          tool.error = e.is_error;
        }
        break;
      }
      case "assistant_text":
        items.push({ kind: "text", text: e.text, key });
        steps = null;
        break;
      case "turn_complete":
        if (turnFirst) turnFirst.ms = e.duration_ms;
        steps = null;
        turnFirst = null;
        break;
      case "error":
        items.push({ kind: "error", text: e.message, key });
        break;
      case "approval_request":
        items.push({ kind: "approval", id: e.id, tool: e.tool, input: e.input, key });
        break;
      case "approval_resolved": {
        const a = items.find((x): x is Extract<Item, { kind: "approval" }> => x.kind === "approval" && x.id === e.id);
        if (a) a.resolved = { allowed: e.allowed, by: e.by };
        break;
      }
      case "thread_spawned":
        items.push({ kind: "spawned", threadId: e.thread_id, title: e.title, key });
        break;
      case "artifact_created":
        items.push({ kind: "artifact", artifact: e.artifact, key });
        break;
    }
  }
  // Drop empty step groups that are not a turn's "Worked for" line.
  return items.filter((it) => it.kind !== "steps" || it.first || it.tools.length > 0);
}

export function ThreadView({ thread }: { thread: Thread }) {
  const t = useT();
  const events = useStore((s) => s.events[thread.id]);
  const items = useMemo(() => fold(events ?? []), [events]);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  // Follow new output, unless the reader scrolled up to look at something.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [items.length, events?.length]);

  return (
    <div
      className="thread-scroll"
      ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
    >
      <div className="thread">
        {items.map((it, i) => {
          const isLastTurn = !items.slice(i + 1).some((x) => x.kind === "user");
          switch (it.kind) {
            case "user":
              return (
                <div key={it.key} className="msg-user">
                  <div className="bubble">{it.text}</div>
                </div>
              );
            case "text":
              return (
                <div key={it.key} className="msg-agent">
                  <Markdown text={it.text} />
                </div>
              );
            case "error":
              return (
                <div key={it.key} className="msg-error">
                  <AlertTriangle size={14} />
                  <span>{it.text}</span>
                </div>
              );
            case "approval":
              return <ApprovalCard key={it.key} id={it.id} tool={it.tool} input={it.input} resolved={it.resolved} />;
            case "spawned":
              return <SpawnedRow key={it.key} threadId={it.threadId} title={it.title} />;
            case "artifact":
              return <ArtifactCard key={it.key} artifact={it.artifact} />;
            case "steps":
              return <Steps key={it.key} item={it} live={isLastTurn && it.ms === undefined && thread.status === "working"} />;
          }
        })}
        {thread.status === "blocked" && !items.some((x) => x.kind === "approval" && !x.resolved) && (
          <div className="msg-meta needs">
            <StatusIcon status="blocked" size={13} />
            <span>{t("status.blocked")}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function Steps({ item, live }: { item: Extract<Item, { kind: "steps" }>; live: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const now = useNow(live);
  const has = item.tools.length > 0;

  let label: string;
  if (item.first) {
    if (live) label = t("thread.working", { time: duration(now - item.start) });
    else if (item.ms !== undefined) label = t("thread.worked", { time: duration(item.ms) });
    else label = t("thread.steps", { count: item.tools.length });
  } else label = t("thread.steps", { count: item.tools.length });

  if (!item.first && !has) return null;
  if (item.first && !live && item.ms === undefined && !has) return null;

  return (
    <div className={`steps ${open ? "open" : ""}`}>
      <button className={`msg-meta ${live ? "live" : ""}`} onClick={() => has && setOpen((o) => !o)} disabled={!has}>
        {live && <StatusIcon status="working" size={12} />}
        <span>{label}</span>
        {has && item.first && <span className="dot-sep">{t("thread.steps", { count: item.tools.length })}</span>}
        {has && <ChevronRight size={12} className="chev" />}
      </button>
      {has && (
        <div className="steps-body">
          <div className="steps-inner">
            {item.tools.map((tool) => (
              <ToolRow key={tool.id} tool={tool} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ToolRow({ tool }: { tool: Tool }) {
  const [open, setOpen] = useState(false);
  const Icon =
    tool.name === "Bash"
      ? SquareTerminal
      : tool.name === "Read"
        ? FileText
        : ["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(tool.name)
          ? Pencil
          : ["Grep", "Glob"].includes(tool.name)
            ? Search
            : tool.name.startsWith("Web")
              ? Globe
              : Wrench;
  const summary = toolSummary(tool.name, tool.input);
  return (
    <div className={`tool ${tool.error ? "err" : ""} ${tool.output === undefined ? "pending" : ""}`}>
      <button className="tool-row" onClick={() => setOpen((o) => !o)}>
        <Icon size={13} />
        <span className="tool-name">{tool.name}</span>
        <span className="tool-sum">{summary}</span>
      </button>
      {open && tool.output !== undefined && <pre className="tool-out">{tool.output.length > 4000 ? tool.output.slice(0, 4000) + "\n…" : tool.output || "(no output)"}</pre>}
    </div>
  );
}

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}
