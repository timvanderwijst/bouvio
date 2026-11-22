import { Sparkles } from "lucide-react";
import { useState } from "react";
import { useT } from "../../i18n";
import type { Thread } from "../../protocol/Thread";
import { rpc, useStore } from "../../store";
import { Dialog } from "../Dialog";

/** Start a thread with a document (or part of it) as context, and open it. */
export async function askAgent(question: string, context: string, title: string) {
  const s = useStore.getState();
  const ws = s.workspaceId;
  if (!ws) return;
  const thread = await rpc<Thread>("create_thread", {
    thread: { workspace_id: ws, lead_id: null, title: null, harness: s.prefs.harness, model: s.prefs.model, effort: s.prefs.effort, approval: s.prefs.approval, isolate: false },
  });
  useStore.setState((st) => {
    const list = st.threads[ws] ?? [];
    return {
      threads: { ...st.threads, [ws]: list.some((x) => x.id === thread.id) ? list : [thread, ...list] },
      events: { ...st.events, [thread.id]: st.events[thread.id] ?? [] },
    };
  });
  const text = `${question.trim()}\n\n---\nFrom "${title}":\n\n${context.trim().slice(0, 60_000)}`;
  await rpc("send_message", { thread_id: thread.id, text });
  await s.openThread(thread.id);
}

export function AskDialog({ title, context, scope, onClose }: { title: string; context: string; scope: "doc" | "selection"; onClose: () => void }) {
  const t = useT();
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!q.trim() || busy) return;
    setBusy(true);
    try {
      await askAgent(q, context, title);
      onClose();
    } catch (e) {
      useStore.getState().notify(String(e));
      setBusy(false);
    }
  };
  return (
    <Dialog title={t("office.ask.title")} onClose={onClose}>
      <div className="form">
        <span className="ask-chip office-ask-scope">
          <Sparkles size={12} />
          {scope === "selection" ? t("office.ask.selection") : t("office.ask.doc", { title })}
        </span>
        <textarea
          className="input area office-ask-input"
          autoFocus
          rows={3}
          placeholder={t("office.ask.placeholder")}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && submit()}
        />
        <div className="form-actions">
          <button className="btn ghost" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className="btn primary" disabled={!q.trim() || busy} onClick={submit}>
            {t("office.ask.send")}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
