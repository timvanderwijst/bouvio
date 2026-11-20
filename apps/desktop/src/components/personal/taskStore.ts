import { create } from "zustand";
import { useEffect } from "react";
import { backend } from "../../backend";
import { getLang } from "../../i18n";
import type { PersonalNewTask } from "../../protocol/PersonalNewTask";
import type { PersonalTask } from "../../protocol/PersonalTask";
import { rpc, useStore } from "../../store";
import { daysUntil, isoDate } from "./dates";

export type Task = PersonalTask;
export type TaskGroup = "overdue" | "today" | "upcoming" | "none" | "done";
export const GROUPS: TaskGroup[] = ["overdue", "today", "upcoming", "none", "done"];

/** Personal calls always go to this machine's runner, never through the hub. */
export const local = <T,>(method: string, params: Record<string, unknown> = {}) => rpc<T>(method, params, null);

export function groupOf(t: Task, today = new Date()): TaskGroup {
  if (t.done) return "done";
  if (!t.due) return "none";
  const d = daysUntil(t.due, today);
  return d < 0 ? "overdue" : d === 0 ? "today" : "upcoming";
}

const bySort = (a: Task, b: Task) => a.sort - b.sort || a.created_at.localeCompare(b.created_at);

/** Same rule as the runner: the named tasks take the sort slots they already hold, in the new order. */
export function applyOrder(tasks: Task[], ids: string[]): Task[] {
  const slots = tasks.filter((t) => ids.includes(t.id)).map((t) => t.sort).sort((a, b) => a - b);
  const next = new Map(ids.map((id, i) => [id, slots[i]]));
  return tasks.map((t) => (next.has(t.id) ? { ...t, sort: next.get(t.id)! } : t)).sort(bySort);
}

interface TaskState {
  tasks: Task[] | null;
  load(force?: boolean): Promise<void>;
  add(n: Partial<PersonalNewTask> & { title: string }): Promise<void>;
  save(t: Task): Promise<void>;
  remove(id: string): Promise<void>;
  reorder(ids: string[]): Promise<void>;
}

let listening = false;
const fail = (e: unknown) => useStore.getState().notify(String(e));

export const useTasks = create<TaskState>((set, get) => ({
  tasks: null,
  async load(force = false) {
    if (!listening) {
      listening = true;
      backend.on<{ kind: string; payload: Task[] }>("workspace-notice", ({ kind, payload }) => {
        if (kind === "personal-tasks") set({ tasks: [...payload].sort(bySort) });
      });
    }
    if (get().tasks && !force) return;
    try {
      set({ tasks: (await local<Task[]>("list_tasks")).sort(bySort) });
    } catch {
      set({ tasks: [] });
    }
  },
  async add(n) {
    try {
      const t = await local<Task>("create_task", { task: { notes: null, due: null, priority: null, workspace_id: null, thread_id: null, ...n } });
      set((s) => ({ tasks: s.tasks?.some((x) => x.id === t.id) ? s.tasks : [...(s.tasks ?? []), t] }));
    } catch (e) {
      fail(e);
    }
  },
  async save(t) {
    set((s) => ({ tasks: s.tasks?.map((x) => (x.id === t.id ? t : x)) ?? null }));
    try {
      const saved = await local<Task>("update_task", { task: t });
      set((s) => ({ tasks: s.tasks?.map((x) => (x.id === saved.id ? saved : x)) ?? null }));
    } catch (e) {
      fail(e);
      get().load(true);
    }
  },
  async remove(id) {
    set((s) => ({ tasks: s.tasks?.filter((x) => x.id !== id) ?? null }));
    await local("delete_task", { id }).catch(fail);
  },
  async reorder(ids) {
    set((s) => ({ tasks: s.tasks ? applyOrder(s.tasks, ids) : null }));
    await local("reorder_tasks", { ids }).catch(fail);
  },
}));

/** Tasks due today plus overdue ones, for the rail badge. */
export function useDueCount(): number | undefined {
  const tasks = useTasks((s) => s.tasks);
  const load = useTasks((s) => s.load);
  useEffect(() => {
    load();
  }, [load]);
  const n = (tasks ?? []).filter((t) => !t.done && t.due && daysUntil(t.due) <= 0).length;
  return n || undefined;
}

/** "Today", "Tomorrow", "Fri", "12 Dec" — short and local. */
export function dueLabel(iso: string, t: (k: string) => string, today = new Date()): string {
  const d = daysUntil(iso, today);
  if (d === 0) return t("personal.due.today");
  if (d === 1) return t("personal.due.tomorrow");
  if (d === -1) return t("personal.due.yesterday");
  const [y, m, day] = iso.split("-").map(Number);
  const date = new Date(y, m - 1, day);
  if (d > 1 && d < 7) return new Intl.DateTimeFormat(getLang(), { weekday: "short" }).format(date);
  return new Intl.DateTimeFormat(getLang(), { day: "numeric", month: "short", year: y === today.getFullYear() ? undefined : "numeric" }).format(date);
}

export const todayIso = () => isoDate(new Date());
