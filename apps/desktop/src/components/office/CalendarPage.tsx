import { CircleDot, Clock, Database } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import * as Y from "yjs";
import { backend } from "../../backend";
import { getLang, t, useT } from "../../i18n";
import type { Automation } from "../../protocol/Automation";
import { rpc, useStore, useWsData } from "../../store";
import { createDoc, openDoc, useDocs } from "./common";
import { nextRuns } from "./cron";
import { addRow, readDb } from "./db";
import { cellText, fieldList, titleField } from "./dbview";
import { CalNav, DayGrid, isoDay, monthDays, startOfWeek, weekDays } from "./MonthGrid";
import { acquire, fromB64, release, REMOTE } from "./sync";
import "./office.css";

interface CalEvent {
  key: string;
  day: string;
  title: string;
  kind: "row" | "automation" | "issue";
  time?: string;
  color: number;
  open: () => void;
}

/** Live Y.Docs of every database in the workspace, for reading dates. */
function useDatabases(ids: string[], ws: string | null) {
  const docs = useRef(new Map<string, Y.Doc>());
  const [version, setVersion] = useState(0);
  const key = ids.join(",");
  useEffect(() => {
    if (!ws) return;
    let live = true;
    for (const id of ids) {
      if (docs.current.has(id)) continue;
      const d = new Y.Doc();
      docs.current.set(id, d);
      rpc<string>("get_doc_state", { id }, ws)
        .then((s) => {
          Y.applyUpdate(d, fromB64(s), REMOTE);
          if (live) setVersion((v) => v + 1);
        })
        .catch(() => {});
    }
    for (const id of [...docs.current.keys()]) if (!ids.includes(id)) docs.current.delete(id);
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ws]);
  useEffect(
    () =>
      backend.on<{ kind: string; payload: any }>("workspace-notice", ({ kind, payload }) => {
        if (kind !== "office-update") return;
        const d = docs.current.get(payload?.id);
        if (!d) return;
        Y.applyUpdate(d, fromB64(payload.update), REMOTE);
        setVersion((v) => v + 1);
      }),
    [],
  );
  return { docs: docs.current, version };
}

export function CalendarPage() {
  const tr = useT();
  const ws = useStore((s) => s.workspaceId);
  const notify = useStore((s) => s.notify);
  const go = useStore((s) => s.go);
  const data = useWsData();
  const docs = useDocs();
  const [mode, setMode] = useState<"month" | "week">("month");
  const [anchor, setAnchor] = useState(() => new Date());
  const [showIssues, setShowIssues] = useState(false);
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [adding, setAdding] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const dbs = useMemo(() => (docs ?? []).filter((d) => d.kind === "database"), [docs]);
  const { docs: ydocs, version } = useDatabases(
    dbs.map((d) => d.id),
    ws,
  );

  useEffect(() => {
    if (!ws) return;
    rpc<Automation[]>("list_automations", { workspace_id: ws })
      .then(setAutomations)
      .catch(() => setAutomations([]));
  }, [ws]);
  useEffect(() => {
    if (showIssues) useStore.getState().load("issues");
  }, [showIssues]);

  const days = mode === "month" ? monthDays(anchor) : weekDays(anchor);
  const from = days[0];
  const until = new Date(days[days.length - 1].getFullYear(), days[days.length - 1].getMonth(), days[days.length - 1].getDate() + 1);

  const events = useMemo(() => {
    const out: CalEvent[] = [];
    dbs.forEach((db, i) => {
      const y = ydocs.get(db.id);
      if (!y) return;
      const { schema, rows } = readDb(y);
      const title = titleField(schema);
      for (const f of fieldList(schema).filter((x) => x.type === "date"))
        for (const r of rows) {
          const v = r[f.id];
          if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(v)) continue;
          const name = (title && cellText(title, r[title.id])) || t("office.untitled");
          out.push({ key: `${db.id}-${r.id}-${f.id}`, day: v.slice(0, 10), title: name, kind: "row", color: i % 6, open: () => openDoc(db.id) });
        }
    });
    const timeFmt = new Intl.DateTimeFormat(getLang(), { hour: "2-digit", minute: "2-digit" });
    for (const a of automations.filter((x) => x.enabled))
      for (const at of nextRuns(a.schedule, new Date(Math.max(Date.now(), from.getTime()) - 1), until, 62))
        out.push({ key: `${a.id}-${at.getTime()}`, day: isoDay(at), title: a.name, kind: "automation", time: timeFmt.format(at), color: 6, open: () => go({ kind: "page", page: "automations" }) });
    if (showIssues)
      for (const i of data.issues ?? [])
        out.push({ key: `issue-${i.id}`, day: isoDay(new Date(i.updated_at)), title: `${i.key} ${i.title}`, kind: "issue", color: 7, open: () => go({ kind: "page", page: "issues" }) });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dbs, version, automations, showIssues, data.issues, from.getTime(), until.getTime(), go]);

  const byDay = useMemo(() => {
    const m: Record<string, CalEvent[]> = {};
    for (const e of events) (m[e.day] ??= []).push(e);
    for (const list of Object.values(m)) list.sort((a, b) => (a.time ?? "").localeCompare(b.time ?? ""));
    return m;
  }, [events]);

  const create = async (day: string, title: string) => {
    setAdding(null);
    setDraft("");
    if (!title.trim() || !ws) return;
    try {
      let cal = dbs.find((d) => d.title.trim().toLowerCase() === "calendar");
      if (!cal) cal = (await createDoc("database", { title: "Calendar", template: "calendar", open: false })) ?? undefined;
      if (!cal) return;
      const s = acquire(cal.id, ws);
      await s.loaded();
      const { schema } = readDb(s.ydoc);
      const date = fieldList(schema).find((f) => f.type === "date");
      const name = titleField(schema);
      addRow(s.ydoc, { ...(name ? { [name.id]: title.trim() } : {}), ...(date ? { [date.id]: day } : {}) });
      await s.flush();
      release(s);
    } catch (e) {
      notify(String(e));
    }
  };

  const label =
    mode === "month"
      ? new Intl.DateTimeFormat(getLang(), { month: "long", year: "numeric" }).format(anchor)
      : `${new Intl.DateTimeFormat(getLang(), { day: "numeric", month: "short" }).format(days[0])} – ${new Intl.DateTimeFormat(getLang(), { day: "numeric", month: "short", year: "numeric" }).format(days[6])}`;
  const step = (n: number) => setAnchor(mode === "month" ? new Date(anchor.getFullYear(), anchor.getMonth() + n, 1) : new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + 7 * n));

  return (
    <div className="office-calendar">
      <div className="cal-head">
        <h1 className="page-title">{tr("office.calendar")}</h1>
        <CalNav label={label} onPrev={() => step(-1)} onNext={() => step(1)} onToday={() => setAnchor(mode === "week" ? startOfWeek(new Date()) : new Date())} />
        <div className="page-actions">
          <label className="toggle">
            <input type="checkbox" checked={showIssues} onChange={(e) => setShowIssues(e.target.checked)} />
            {tr("office.cal.issues")}
          </label>
          <div className="choice small">
            {(["month", "week"] as const).map((m) => (
              <button key={m} className={mode === m ? "on" : ""} onClick={() => setMode(m)}>
                {tr(`office.cal.${m}`)}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="cal-body">
        <DayGrid
          days={days}
          month={mode === "month" ? anchor.getMonth() : undefined}
          tall={mode === "week"}
          onAdd={(key) => {
            setAdding(key);
            setDraft("");
          }}
          render={(_, key) => (
            <>
              {(byDay[key] ?? []).slice(0, mode === "month" ? 4 : 40).map((e) => (
                <button key={e.key} className={`cal-item ev-${e.color} k-${e.kind}`} onClick={e.open} title={e.title}>
                  {e.kind === "automation" ? <Clock size={11} /> : e.kind === "issue" ? <CircleDot size={11} /> : <Database size={11} />}
                  {e.time && <span className="cal-time">{e.time}</span>}
                  <span className="truncate">{e.title}</span>
                </button>
              ))}
              {mode === "month" && (byDay[key]?.length ?? 0) > 4 && (
                <button
                  className="cal-more"
                  onClick={() => {
                    setAnchor(new Date(`${key}T00:00:00`));
                    setMode("week");
                  }}
                >
                  {tr("office.cal.more", { n: byDay[key].length - 4 })}
                </button>
              )}
              {adding === key && (
                <input
                  className="cal-input"
                  autoFocus
                  value={draft}
                  placeholder={tr("office.cal.newEvent")}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => (draft.trim() ? create(key, draft) : setAdding(null))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    if (e.key === "Escape") setAdding(null);
                  }}
                />
              )}
            </>
          )}
        />
      </div>
    </div>
  );
}
