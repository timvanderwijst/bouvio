import { Check, ChevronDown, MessageSquarePlus, RotateCw, Send, Undo2 } from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { useT } from "../../i18n";
import { parseDiff, type DiffFile, type DiffLine } from "../../lib/diff";
import { ago } from "../../lib/format";
import type { ReviewComment } from "../../protocol/ReviewComment";
import type { ReviewSide } from "../../protocol/ReviewSide";
import type { Thread } from "../../protocol/Thread";
import { rpc, useStore } from "../../store";
import { Empty } from "../Panel";
import { errText, useDevNotice } from "./state";

const sideOf = (l: DiffLine): ReviewSide => (l.kind === "del" ? "old" : "new");
const numOf = (l: DiffLine) => (l.kind === "del" ? l.old : l.new) ?? 0;
const keyOf = (path: string, side: ReviewSide, line: number) => `${path}\u0000${side}\u0000${line}`;

/** Every open comment as one code review message, by file and line. */
export function reviewMessage(comments: ReviewComment[]) {
  const byFile = new Map<string, ReviewComment[]>();
  for (const c of [...comments].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)) {
    if (!byFile.has(c.path)) byFile.set(c.path, []);
    byFile.get(c.path)!.push(c);
  }
  const parts = ["Code review: please address these comments, then reply with what you changed.", ""];
  let n = 1;
  for (const [path, list] of byFile) {
    for (const c of list) {
      parts.push(`${n++}. \`${path}:${c.line}\`${c.side === "old" ? " (removed line)" : ""}${c.outdated ? " (line has changed since)" : ""}`);
      if (c.line_text.trim()) parts.push(`   > ${c.line_text.trim()}`);
      for (const l of c.text.split("\n")) parts.push(`   ${l}`);
      parts.push("");
    }
  }
  return parts.join("\n").trimEnd();
}

export function ReviewPanel({ thread }: { thread: Thread | null }) {
  const t = useT();
  if (!thread) return <Empty text={t("dev.review.noThread")} />;
  if (!thread.cwd) return <Empty text={t("dev.review.noRepo")} />;
  return <Review key={thread.id} thread={thread} />;
}

function Review({ thread }: { thread: Thread }) {
  const t = useT();
  const notify = useStore((s) => s.notify);
  const [raw, setRaw] = useState<string | null>(null);
  const [comments, setComments] = useState<ReviewComment[]>([]);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [showResolved, setShowResolved] = useState(false);
  const [draftAt, setDraftAt] = useState<string | null>(null);
  const turns = useStore((s) => (s.events[thread.id] ?? []).filter((e) => e.event.type === "turn_complete").length);

  const loadComments = useCallback(() => rpc<ReviewComment[]>("list_review_comments", { thread_id: thread.id }).then(setComments, () => {}), [thread.id]);
  const load = useCallback(async () => {
    setBusy(true);
    try {
      setRaw(await rpc<string>("thread_diff", { thread_id: thread.id }));
    } catch (e) {
      setRaw(`error: ${errText(e)}`);
    } finally {
      setBusy(false);
    }
    // After the diff: the runner follows comments through it.
    await loadComments();
  }, [thread.id, loadComments]);

  // Files change when a turn ends.
  useEffect(() => {
    load();
  }, [load, turns]);
  useDevNotice("dev-review", (p: { thread_id: string }) => p?.thread_id === thread.id && loadComments());

  const files = useMemo(() => parseDiff(raw?.startsWith("error:") ? "" : raw ?? ""), [raw]);
  const open = comments.filter((c) => !c.resolved);
  const visible = comments.filter((c) => showResolved || !c.resolved);
  const at = useMemo(() => {
    const m = new Map<string, ReviewComment[]>();
    for (const c of visible.filter((c) => !c.outdated)) {
      const k = keyOf(c.path, c.side, c.line);
      m.set(k, [...(m.get(k) ?? []), c]);
    }
    return m;
  }, [visible]);
  const outdated = visible.filter((c) => c.outdated);

  const add = async (path: string, line: DiffLine, text: string) => {
    try {
      const c = await rpc<ReviewComment>("add_review_comment", { thread_id: thread.id, path, line: numOf(line), side: sideOf(line), text });
      setComments((cs) => [...cs.filter((x) => x.id !== c.id), c]);
      setDraftAt(null);
    } catch (e) {
      notify(errText(e));
    }
  };
  const resolve = async (c: ReviewComment, resolved: boolean) => {
    try {
      const n = await rpc<ReviewComment>("resolve_review_comment", { id: c.id, resolved });
      setComments((cs) => cs.map((x) => (x.id === n.id ? n : x)));
    } catch (e) {
      notify(errText(e));
    }
  };
  const sendAll = async () => {
    if (!open.length) return;
    setSending(true);
    try {
      await rpc("send_message", { thread_id: thread.id, text: reviewMessage(open) });
      // Handed over: the agent works on them now.
      await Promise.all(open.map((c) => rpc("resolve_review_comment", { id: c.id, resolved: true }).catch(() => {})));
      await loadComments();
      notify(t("dev.review.sent", { count: open.length }));
    } catch (e) {
      notify(errText(e));
    } finally {
      setSending(false);
    }
  };

  if (raw?.startsWith("error:")) return <Empty text={raw.slice(7)} />;
  return (
    <div className="changes dv-review">
      <div className="changes-head">
        <span>{t("dev.review.open", { count: open.length })}</span>
        <div className="composer-spacer" />
        {comments.some((c) => c.resolved) && (
          <button className={`btn ghost small ${showResolved ? "on" : ""}`} onClick={() => setShowResolved((s) => !s)}>
            {t(showResolved ? "dev.review.hideResolved" : "dev.review.showResolved")}
          </button>
        )}
        <button className={`icon-btn ${busy ? "spin" : ""}`} onClick={load} aria-label={t("dev.refresh")} title={t("dev.refresh")}>
          <RotateCw size={13} />
        </button>
        <button className={`btn small primary ${sending ? "is-busy" : ""}`} disabled={!open.length || sending} onClick={sendAll} title={t("dev.review.sendHint")}>
          <Send size={12} />
          {t("dev.review.send")}
        </button>
      </div>
      {outdated.length > 0 && (
        <div className="dv-outdated">
          <div className="dv-outdated-title">{t("dev.review.outdated")}</div>
          {outdated.map((c) => (
            <CommentCard key={c.id} c={c} onResolve={resolve} showWhere />
          ))}
        </div>
      )}
      {raw === null ? (
        <Empty text={t("dev.loading")} />
      ) : files.length === 0 ? (
        <Empty text={t("dev.review.noChanges")} />
      ) : (
        files.map((f) => <FileReview key={f.path} file={f} at={at} draftAt={draftAt} setDraftAt={setDraftAt} onAdd={add} onResolve={resolve} />)
      )}
      {files.length > 0 && open.length === 0 && <div className="dv-review-tip">{t("dev.review.tip")}</div>}
    </div>
  );
}

function FileReview({
  file,
  at,
  draftAt,
  setDraftAt,
  onAdd,
  onResolve,
}: {
  file: DiffFile;
  at: Map<string, ReviewComment[]>;
  draftAt: string | null;
  setDraftAt: (k: string | null) => void;
  onAdd: (path: string, line: DiffLine, text: string) => Promise<void>;
  onResolve: (c: ReviewComment, resolved: boolean) => void;
}) {
  const [open, setOpen] = useState(true);
  const count = [...at.keys()].filter((k) => k.startsWith(file.path + "\u0000")).length;
  return (
    <div className="file">
      <button className="file-head" onClick={() => setOpen((o) => !o)}>
        <ChevronDown size={12} className={open ? "" : "rot"} />
        <span className="file-path truncate">{file.path}</span>
        {count > 0 && <span className="dv-count">{count}</span>}
        <span className="add">+{file.adds}</span>
        <span className="del">−{file.dels}</span>
      </button>
      {open && (
        <div className="diff">
          {file.hunks.map((h, i) => (
            <div key={i}>
              <div className="diff-hunk">{h.header}</div>
              {h.lines.map((l, j) => {
                const k = keyOf(file.path, sideOf(l), numOf(l));
                const here = at.get(k);
                return (
                  <Fragment key={j}>
                    <div className={`diff-line ${l.kind} ${here ? "dv-has" : ""} ${draftAt === k ? "dv-target" : ""}`}>
                      <button className="ln dv-ln" onClick={() => setDraftAt(draftAt === k ? null : k)} aria-label={`Comment on line ${numOf(l)}`}>
                        <span>{numOf(l)}</span>
                        <MessageSquarePlus size={11} />
                      </button>
                      <span className="sign">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : ""}</span>
                      <span className="code">{l.text || " "}</span>
                    </div>
                    {(here || draftAt === k) && (
                      <div className="dv-thread-box">
                        {here?.map((c) => <CommentCard key={c.id} c={c} onResolve={onResolve} />)}
                        {draftAt === k && <CommentBox onCancel={() => setDraftAt(null)} onSubmit={(text) => onAdd(file.path, l, text)} />}
                      </div>
                    )}
                  </Fragment>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CommentBox({ onCancel, onSubmit }: { onCancel: () => void; onSubmit: (text: string) => Promise<void> }) {
  const t = useT();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    await onSubmit(text);
    setBusy(false);
  };
  return (
    <div className="dv-comment-box">
      <textarea
        autoFocus
        className="input"
        rows={3}
        value={text}
        placeholder={t("dev.review.placeholder")}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit();
        }}
      />
      <div className="dv-comment-actions">
        <span className="dv-hint">{t("dev.review.keys")}</span>
        <div className="composer-spacer" />
        <button className="btn ghost small" onClick={onCancel}>
          {t("dev.cancel")}
        </button>
        <button className="btn primary small" disabled={!text.trim() || busy} onClick={submit}>
          {t("dev.review.comment")}
        </button>
      </div>
    </div>
  );
}

function CommentCard({ c, onResolve, showWhere }: { c: ReviewComment; onResolve: (c: ReviewComment, resolved: boolean) => void; showWhere?: boolean }) {
  const t = useT();
  return (
    <div className={`dv-comment ${c.resolved ? "resolved" : ""}`}>
      <div className="dv-comment-head">
        <span className="dv-avatar" aria-hidden>
          {c.author.slice(0, 1).toUpperCase()}
        </span>
        <span className="dv-comment-author">{c.author}</span>
        <span className="dv-row-meta">{ago(c.created_at)}</span>
        {showWhere && <span className="mono dv-row-meta truncate">{`${c.path}:${c.line}`}</span>}
        <div className="composer-spacer" />
        <button className="icon-btn" title={t(c.resolved ? "dev.review.reopen" : "dev.review.resolve")} aria-label={t(c.resolved ? "dev.review.reopen" : "dev.review.resolve")} onClick={() => onResolve(c, !c.resolved)}>
          {c.resolved ? <Undo2 size={13} /> : <Check size={13} />}
        </button>
      </div>
      {showWhere && c.line_text.trim() && <pre className="dv-quote">{c.line_text}</pre>}
      <div className="dv-comment-text">{c.text}</div>
    </div>
  );
}
