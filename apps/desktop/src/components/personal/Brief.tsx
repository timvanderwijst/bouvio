import { CheckSquare, Clock, RotateCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { getLang, useT } from "../../i18n";
import type { Brief } from "../../protocol/Brief";
import type { BriefItem } from "../../protocol/BriefItem";
import type { BriefKind } from "../../protocol/BriefKind";
import type { IssueStatus } from "../../protocol/IssueStatus";
import { useStore } from "../../store";
import { Markdown } from "../Markdown";
import { StatusIcon } from "../StatusIcon";
import { IssueIcon } from "../Work";
import { isoDate } from "./dates";
import { local } from "./taskStore";

const KINDS: BriefKind[] = ["waiting", "failed", "finished", "issue", "automation", "task"];

function KindIcon({ item }: { item: BriefItem }) {
  switch (item.kind) {
    case "waiting":
      return <StatusIcon status="blocked" size={13} />;
    case "failed":
      return <StatusIcon status="error" size={13} />;
    case "finished":
      return <StatusIcon status="done" size={13} />;
    case "issue":
      return <IssueIcon status={(item.detail as IssueStatus) ?? "todo"} size={13} />;
    case "automation":
      return <Clock size={13} className="p-muted-icon" />;
    case "task":
      return <CheckSquare size={13} className="p-muted-icon" />;
  }
}

/** Open what a brief line is about: its thread, the issues or automations page, or My work. */
async function openItem(item: BriefItem) {
  const s = useStore.getState();
  if (item.kind === "task") return s.go({ kind: "ext", id: "personal.work" });
  const known = item.thread_id && Object.values(s.threads).some((l) => l.some((x) => x.id === item.thread_id));
  if (known) return s.openThread(item.thread_id!);
  if (item.workspace_id) {
    await s.selectWorkspace(item.workspace_id);
    s.go({ kind: "page", page: item.kind === "automation" ? "automations" : "issues" });
  }
}

function ItemRow({ item }: { item: BriefItem }) {
  const t = useT();
  const detail = item.kind === "issue" && item.detail ? t(`issue.${item.detail}`) : item.detail === "overdue" ? t("personal.group.overdue") : item.detail;
  return (
    <button type="button" className="p-brief-row" onClick={() => openItem(item)}>
      <KindIcon item={item} />
      <span className="truncate p-brief-title">{item.title}</span>
      {detail && <span className={`p-brief-detail ${item.detail === "overdue" ? "overdue" : ""}`}>{detail}</span>}
      {item.workspace && <span className="p-brief-ws truncate">{item.workspace}</span>}
    </button>
  );
}

/** Home, first: what happened in the last 24 hours, in a few lines. */
export function BriefBlock() {
  const t = useT();
  const [brief, setBrief] = useState<Brief | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (regenerate: boolean) => {
    setBusy(true);
    try {
      setBrief(await local<Brief>("get_brief", { date: isoDate(new Date()), regenerate }));
      setError(null);
    } catch (e) {
      setError(String(e).replace(/^Error: /, ""));
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    load(false);
  }, [load]);

  const date = new Intl.DateTimeFormat(getLang(), { weekday: "long", day: "numeric", month: "long" }).format(new Date());
  const items = brief?.items ?? [];

  return (
    <section className="p-card p-brief" aria-label={t("personal.brief.title")} aria-busy={busy}>
      <header className="p-card-head">
        <span className="p-card-title">{t("personal.brief.title")}</span>
        <span className="p-card-meta">{date}</span>
        <div className="composer-spacer" />
        <button
          type="button"
          className={`icon-btn ${busy ? "spin" : ""}`}
          onClick={() => load(true)}
          disabled={busy}
          title={t("personal.brief.regenerate")}
          aria-label={t("personal.brief.regenerate")}
        >
          <RotateCw size={13} />
        </button>
      </header>
      {!brief && busy ? (
        <div className="p-brief-skel" aria-hidden>
          {[92, 78, 85, 64, 70].map((w, i) => (
            <span key={i} className="shimmer" style={{ width: `${w}%` }} />
          ))}
        </div>
      ) : error && !brief ? (
        <p className="p-quiet">{error}</p>
      ) : items.length === 0 ? (
        <p className="p-quiet">{t("personal.brief.quiet")}</p>
      ) : brief?.ai ? (
        <>
          <div className={`p-brief-md ${busy ? "stale" : ""}`}>
            <Markdown text={brief.markdown} />
          </div>
          <div className="p-brief-links">
            {items.slice(0, 8).map((i) => (
              <ItemRow key={`${i.kind}${i.id}`} item={i} />
            ))}
          </div>
        </>
      ) : (
        <div className={`p-brief-groups ${busy ? "stale" : ""}`}>
          {KINDS.map((k) => {
            const list = items.filter((i) => i.kind === k);
            if (!list.length) return null;
            return (
              <div key={k} className="p-brief-group">
                <div className="p-brief-kind">{t(`personal.brief.${k}`)}</div>
                {list.map((i) => (
                  <ItemRow key={i.id} item={i} />
                ))}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
