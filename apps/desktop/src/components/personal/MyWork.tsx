import { useState } from "react";
import { useT } from "../../i18n";
import { NotesView } from "./Notes";
import { TasksView } from "./Tasks";

/** Rail page: my own tasks across workspaces, and my notes. */
export function MyWorkPage({ sub }: { sub?: string }) {
  const t = useT();
  const [tab, setTab] = useState<"tasks" | "notes">(sub === "notes" ? "notes" : "tasks");
  return (
    <div className={`page wide p-work ${tab === "notes" ? "is-notes" : ""}`}>
      <div className="page-head">
        <h1 className="page-title">{t("personal.work")}</h1>
        <div className="choice small" role="tablist">
          {(["tasks", "notes"] as const).map((x) => (
            <button key={x} type="button" role="tab" aria-selected={tab === x} className={tab === x ? "on" : ""} onClick={() => setTab(x)}>
              {t(`personal.work.${x}`)}
            </button>
          ))}
        </div>
      </div>
      {tab === "tasks" ? <TasksView /> : <NotesView />}
    </div>
  );
}
