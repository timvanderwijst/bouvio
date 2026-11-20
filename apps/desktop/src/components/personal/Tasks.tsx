import { ArrowUpRight, CalendarDays, ChevronDown, Flag, GripVertical, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../../i18n";
import type { PersonalTaskPriority } from "../../protocol/PersonalTaskPriority";
import { useStore } from "../../store";
import { Menu } from "../Menu";
import { parseQuickAdd } from "./dates";
import { GROUPS, dueLabel, groupOf, todayIso, useTasks, type Task, type TaskGroup } from "./taskStore";

const PRIORITIES: PersonalTaskPriority[] = ["none", "low", "medium", "high"];

/** One line to add a task; dates and priority are read from the text. */
export function QuickAdd({ defaultDue = null, autoFocus = false }: { defaultDue?: string | null; autoFocus?: boolean }) {
  const t = useT();
  const add = useTasks((s) => s.add);
  const [text, setText] = useState("");
  const parsed = useMemo(() => parseQuickAdd(text), [text]);
  const due = parsed.due ?? defaultDue;

  const submit = () => {
    const title = parsed.title || text.trim();
    if (!title) return;
    add({ title, due, priority: parsed.priority });
    setText("");
  };

  return (
    <form
      className="p-quick"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Plus size={15} className="p-quick-icon" />
      <input
        className="p-quick-input"
        value={text}
        autoFocus={autoFocus}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && setText("")}
        placeholder={t("personal.tasks.quickHint")}
        aria-label={t("personal.tasks.add")}
      />
      {text.trim() && due && (
        <span className="p-chip">
          <CalendarDays size={12} />
          {dueLabel(due, t)}
        </span>
      )}
      {text.trim() && parsed.priority && (
        <span className={`p-chip prio-${parsed.priority}`}>
          <Flag size={12} />
          {t(`personal.priority.${parsed.priority}`)}
        </span>
      )}
    </form>
  );
}

export function Check({ done, onToggle, label }: { done: boolean; onToggle: () => void; label: string }) {
  return (
    <button type="button" className={`p-check ${done ? "on" : ""}`} onClick={onToggle} role="checkbox" aria-checked={done} aria-label={label}>
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
        <circle className="p-check-ring" cx="8" cy="8" r="6.75" />
        <path className="p-check-mark" d="M5 8.3l2 2 4-4.3" />
      </svg>
    </button>
  );
}

interface RowProps {
  task: Task;
  open?: boolean;
  onOpen?: () => void;
  showDue?: boolean;
  drag?: {
    onDragStart: (e: React.DragEvent) => void;
    onDragOver: (e: React.DragEvent) => void;
    onDrop: (e: React.DragEvent) => void;
    onDragEnd: () => void;
    drop: "before" | "after" | null;
    dragging: boolean;
  };
}

export function TaskRow({ task, open = false, onOpen, showDue = true, drag }: RowProps) {
  const t = useT();
  const save = useTasks((s) => s.save);
  const ws = useStore((s) => (task.workspace_id ? s.workspaces.find((w) => w.id === task.workspace_id) : undefined));
  // The check plays before the row moves to Done.
  const [checking, setChecking] = useState(false);
  const timer = useRef<number>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const toggle = () => {
    if (task.done) return save({ ...task, done: false });
    setChecking(true);
    timer.current = window.setTimeout(() => save({ ...task, done: true }), 480);
  };
  const g = groupOf(task);
  const cls = ["p-task", open && "open", checking && "checking", task.done && "done", drag?.drop && `drop-${drag.drop}`, drag?.dragging && "dragging"].filter(Boolean).join(" ");

  return (
    <div className={cls} draggable={!!drag} onDragStart={drag?.onDragStart} onDragOver={drag?.onDragOver} onDrop={drag?.onDrop} onDragEnd={drag?.onDragEnd}>
      {drag && <GripVertical size={13} className="p-grip" aria-hidden />}
      <Check done={task.done || checking} onToggle={toggle} label={task.title} />
      <button type="button" className="p-task-main" onClick={onOpen} aria-expanded={onOpen ? open : undefined}>
        <span className="p-task-title truncate">{task.title}</span>
        {task.notes && <span className="p-task-notes truncate">{task.notes.split("\n")[0]}</span>}
      </button>
      {task.priority !== "none" && (
        <span className={`p-prio prio-${task.priority}`} title={t(`personal.priority.${task.priority}`)}>
          <Flag size={12} />
        </span>
      )}
      {ws && <span className="p-task-ws truncate">{ws.name}</span>}
      {showDue && task.due && !task.done && <span className={`p-task-due ${g}`}>{dueLabel(task.due, t)}</span>}
    </div>
  );
}

function TaskEditor({ task }: { task: Task }) {
  const t = useT();
  const save = useTasks((s) => s.save);
  const remove = useTasks((s) => s.remove);
  const workspaces = useStore((s) => s.workspaces);
  const openThread = useStore((s) => s.openThread);
  const [title, setTitle] = useState(task.title);
  const [notes, setNotes] = useState(task.notes ?? "");
  return (
    <div className="p-task-edit">
      <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => title.trim() && title !== task.title && save({ ...task, title })} aria-label={t("personal.tasks.title")} />
      <textarea
        className="input area"
        rows={2}
        value={notes}
        placeholder={t("personal.tasks.notesHint")}
        onChange={(e) => setNotes(e.target.value)}
        onBlur={() => notes !== (task.notes ?? "") && save({ ...task, notes: notes || null })}
      />
      <div className="p-task-props">
        <label className="p-prop">
          <CalendarDays size={13} />
          <input type="date" className="input p-date" value={task.due ?? ""} onChange={(e) => save({ ...task, due: e.target.value || null })} aria-label={t("personal.tasks.due")} />
        </label>
        <div className="choice small" role="group" aria-label={t("personal.tasks.priority")}>
          {PRIORITIES.map((p) => (
            <button key={p} type="button" className={task.priority === p ? "on" : ""} onClick={() => save({ ...task, priority: p })}>
              {t(`personal.priority.${p}`)}
            </button>
          ))}
        </div>
        <Menu
          value={task.workspace_id}
          items={[{ value: null, label: t("personal.tasks.noWorkspace") }, ...workspaces.map((w) => ({ value: w.id as string | null, label: w.name }))]}
          onChange={(w) => save({ ...task, workspace_id: w })}
        />
        <div className="composer-spacer" />
        {task.thread_id && (
          <button type="button" className="btn ghost small" onClick={() => openThread(task.thread_id!)}>
            <ArrowUpRight size={13} />
            {t("personal.tasks.openThread")}
          </button>
        )}
        <button type="button" className="icon-btn" onClick={() => remove(task.id)} title={t("common.delete")} aria-label={t("common.delete")}>
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
}

/** All tasks in groups: overdue, today, upcoming, no date, done. Drag to reorder within a group. */
export function TasksView() {
  const t = useT();
  const tasks = useTasks((s) => s.tasks);
  const load = useTasks((s) => s.load);
  const reorder = useTasks((s) => s.reorder);
  const [open, setOpen] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [drag, setDrag] = useState<{ id: string; group: TaskGroup } | null>(null);
  const [over, setOver] = useState<{ id: string; before: boolean } | null>(null);
  useEffect(() => {
    load();
  }, [load]);

  const groups = useMemo(() => {
    const m = new Map<TaskGroup, Task[]>(GROUPS.map((g) => [g, []]));
    for (const x of tasks ?? []) m.get(groupOf(x))!.push(x);
    m.get("done")!.sort((a, b) => (b.done_at ?? "").localeCompare(a.done_at ?? ""));
    return m;
  }, [tasks]);

  if (!tasks) return <div className="p-skel-list">{[0, 1, 2, 3].map((i) => <div key={i} className="shimmer p-skel-row" />)}</div>;

  const drop = (group: TaskGroup, items: Task[]) => {
    if (!drag || !over || drag.group !== group || drag.id === over.id) return;
    const ids = items.map((x) => x.id).filter((id) => id !== drag.id);
    const at = ids.indexOf(over.id) + (over.before ? 0 : 1);
    ids.splice(at, 0, drag.id);
    reorder(ids);
  };

  return (
    <div className="p-tasks">
      <QuickAdd autoFocus />
      {tasks.length === 0 && <div className="empty small">{t("personal.tasks.none")}</div>}
      {GROUPS.map((g) => {
        const items = groups.get(g)!;
        if (!items.length) return null;
        const collapsed = g === "done" && !showDone;
        return (
          <section key={g} className={`p-group g-${g}`}>
            {g === "done" ? (
              <button type="button" className="group-head" onClick={() => setShowDone((v) => !v)} aria-expanded={showDone}>
                <span>{t("personal.group.done")}</span>
                <span className="group-count">{items.length}</span>
                <ChevronDown size={12} className={showDone ? "" : "rot"} />
              </button>
            ) : (
              <div className="group-head static">
                <span>{t(`personal.group.${g}`)}</span>
                <span className="group-count">{items.length}</span>
              </div>
            )}
            {!collapsed &&
              items.slice(0, g === "done" ? 30 : undefined).map((x) => (
                <div key={x.id}>
                  <TaskRow
                    task={x}
                    open={open === x.id}
                    onOpen={() => setOpen(open === x.id ? null : x.id)}
                    showDue={g !== "today"}
                    drag={
                      g === "done"
                        ? undefined
                        : {
                            dragging: drag?.id === x.id,
                            drop: over?.id === x.id && drag?.group === g && drag.id !== x.id ? (over.before ? "before" : "after") : null,
                            onDragStart: (e) => {
                              e.dataTransfer.effectAllowed = "move";
                              e.dataTransfer.setData("text/plain", x.id);
                              setDrag({ id: x.id, group: g });
                            },
                            onDragOver: (e) => {
                              if (!drag || drag.group !== g) return;
                              e.preventDefault();
                              const r = e.currentTarget.getBoundingClientRect();
                              const before = e.clientY < r.top + r.height / 2;
                              if (over?.id !== x.id || over.before !== before) setOver({ id: x.id, before });
                            },
                            onDrop: (e) => {
                              e.preventDefault();
                              drop(g, items);
                            },
                            onDragEnd: () => {
                              setDrag(null);
                              setOver(null);
                            },
                          }
                    }
                  />
                  {open === x.id && <TaskEditor key={x.id} task={x} />}
                </div>
              ))}
          </section>
        );
      })}
    </div>
  );
}

/** Home: what is due today (and overdue), with a quick add. */
export function TodayBlock() {
  const t = useT();
  const tasks = useTasks((s) => s.tasks);
  const load = useTasks((s) => s.load);
  const go = useStore((s) => s.go);
  useEffect(() => {
    load();
  }, [load]);
  const due = (tasks ?? []).filter((x) => {
    const g = groupOf(x);
    return g === "today" || g === "overdue";
  });

  return (
    <section className="p-card p-today" aria-label={t("personal.today")}>
      <header className="p-card-head">
        <span className="p-card-title">{t("personal.today")}</span>
        {due.length > 0 && <span className="group-count">{due.length}</span>}
        <div className="composer-spacer" />
        <button type="button" className="btn ghost small" onClick={() => go({ kind: "ext", id: "personal.work" })}>
          {t("personal.work")}
          <ArrowUpRight size={13} />
        </button>
      </header>
      {tasks === null ? (
        <div className="shimmer p-skel-row" />
      ) : (
        <div className="p-today-list">
          {due.map((x) => (
            <TaskRow key={x.id} task={x} showDue={groupOf(x) === "overdue"} onOpen={() => go({ kind: "ext", id: "personal.work" })} />
          ))}
          {due.length === 0 && <p className="p-quiet">{t("personal.today.clear")}</p>}
        </div>
      )}
      <QuickAdd defaultDue={todayIso()} />
    </section>
  );
}
