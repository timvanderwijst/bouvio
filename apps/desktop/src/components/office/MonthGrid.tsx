import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import type { ReactNode } from "react";
import { getLang, useT } from "../../i18n";

/** Local date as YYYY-MM-DD. */
export const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export function startOfWeek(d: Date) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}

/** The six weeks shown for a month, Monday first. */
export function monthDays(month: Date): Date[] {
  const first = startOfWeek(new Date(month.getFullYear(), month.getMonth(), 1));
  return Array.from({ length: 42 }, (_, i) => new Date(first.getFullYear(), first.getMonth(), first.getDate() + i));
}

export function weekDays(day: Date): Date[] {
  const first = startOfWeek(day);
  return Array.from({ length: 7 }, (_, i) => new Date(first.getFullYear(), first.getMonth(), first.getDate() + i));
}

export function weekdayNames(): string[] {
  const fmt = new Intl.DateTimeFormat(getLang(), { weekday: "short" });
  return weekDays(new Date(2026, 0, 5)).map((d) => fmt.format(d));
}

export function CalNav({ label, onPrev, onNext, onToday }: { label: string; onPrev: () => void; onNext: () => void; onToday: () => void }) {
  const t = useT();
  return (
    <div className="cal-nav">
      <span className="cal-label">{label}</span>
      <button className="icon-btn" onClick={onPrev} title={t("office.cal.prev")}>
        <ChevronLeft size={16} />
      </button>
      <button className="btn small ghost" onClick={onToday}>
        {t("office.cal.today")}
      </button>
      <button className="icon-btn" onClick={onNext} title={t("office.cal.next")}>
        <ChevronRight size={16} />
      </button>
    </div>
  );
}

/** A month (or one week, when `days` has seven) of day cells. */
export function DayGrid({
  days,
  month,
  render,
  onAdd,
  onDrop,
  tall = false,
}: {
  days: Date[];
  month?: number;
  render: (day: Date, key: string) => ReactNode;
  onAdd?: (key: string) => void;
  onDrop?: (key: string, data: string) => void;
  tall?: boolean;
}) {
  const today = isoDay(new Date());
  return (
    <div className={`cal-grid ${tall ? "week" : ""}`}>
      {weekdayNames().map((n) => (
        <div key={n} className="cal-dow">
          {n}
        </div>
      ))}
      {days.map((d) => {
        const key = isoDay(d);
        return (
          <div
            key={key}
            className={`cal-day ${month !== undefined && d.getMonth() !== month ? "out" : ""} ${key === today ? "today" : ""}`}
            onDragOver={onDrop ? (e) => (e.preventDefault(), e.currentTarget.classList.add("drop")) : undefined}
            onDragLeave={(e) => e.currentTarget.classList.remove("drop")}
            onDrop={
              onDrop
                ? (e) => {
                    e.preventDefault();
                    e.currentTarget.classList.remove("drop");
                    onDrop(key, e.dataTransfer.getData("text/plain"));
                  }
                : undefined
            }
          >
            <div className="cal-day-head">
              <span className="cal-num">{d.getDate()}</span>
              {onAdd && (
                <button className="cal-add" onClick={() => onAdd(key)}>
                  <Plus size={12} />
                </button>
              )}
            </div>
            <div className="cal-items">{render(d, key)}</div>
          </div>
        );
      })}
    </div>
  );
}
