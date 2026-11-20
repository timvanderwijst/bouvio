import { AtSign, CheckCheck, CircleAlert, CircleCheck } from "lucide-react";
import { useState } from "react";
import { useT } from "../../i18n";
import { ago } from "../../lib/format";
import { useStore } from "../../store";
import { Empty } from "../Panel";
import { markRead, useInboxItems, type InboxItem } from "./inbox";

type Filter = "all" | InboxItem["kind"];

async function open(item: InboxItem) {
  const s = useStore.getState();
  if (item.thread) {
    await s.openThread(item.thread);
    return;
  }
  if (item.chat) {
    if (s.workspaceId !== item.ws) await s.selectWorkspace(item.ws);
    const { channel, message, parent } = item.chat;
    useStore.getState().go({ kind: "ext", id: "comms.chat", sub: parent ? `${channel}~${parent}~thread` : `${channel}~${message}` });
  }
}

export function InboxPage() {
  const t = useT();
  const items = useInboxItems();
  const workspaces = useStore((s) => s.workspaces);
  const [filter, setFilter] = useState<Filter>("all");
  const shown = items.filter((i) => filter === "all" || i.kind === filter);
  const unread = items.filter((i) => i.unread);
  const count = (k: InboxItem["kind"]) => items.filter((i) => i.kind === k && i.unread).length;

  return (
    <div className="page cm-inbox">
      <div className="page-head">
        <h1 className="page-title">{t("comms.inbox")}</h1>
        <button className="btn small" disabled={!unread.length} onClick={() => markRead(unread.map((i) => i.id))}>
          <CheckCheck size={14} />
          {t("comms.inbox.markAll")}
        </button>
      </div>
      <div className="choice small cm-inbox-filter" role="tablist">
        {(["all", "mention", "needs", "finished"] as Filter[]).map((f) => (
          <button key={f} role="tab" aria-selected={filter === f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>
            {t(`comms.inbox.${f}`)}
            {f !== "all" && count(f) > 0 && <span className="cm-inbox-n">{count(f)}</span>}
          </button>
        ))}
      </div>
      <div className="list">
        {shown.map((i) => (
          <button
            key={i.id}
            className={`cm-inbox-row ${i.unread ? "unread" : ""}`}
            onClick={() => {
              markRead([i.id]);
              open(i);
            }}
          >
            <span className={`cm-inbox-icon ${i.kind}`}>
              {i.kind === "mention" ? <AtSign size={14} /> : i.kind === "needs" ? <CircleAlert size={14} /> : <CircleCheck size={14} />}
            </span>
            <span className="cm-inbox-text">
              <span className="cm-inbox-title truncate">{i.title}</span>
              <span className="cm-inbox-body truncate">{i.body}</span>
            </span>
            <span className="list-meta">{workspaces.find((w) => w.id === i.ws)?.name}</span>
            <span className="list-meta when">{ago(i.at)}</span>
            <span className={i.unread ? "cm-unread-dot" : "cm-unread-dot off"} aria-label={i.unread ? t("comms.inbox.unread") : undefined} />
          </button>
        ))}
        {shown.length === 0 && <Empty text={t("comms.inbox.empty")} />}
      </div>
    </div>
  );
}
