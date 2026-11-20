// Upcoming runs of a five-field cron expression (minute hour day month weekday),
// in local time, for the calendar. Pure.

function field(src: string, min: number, max: number): number[] | null {
  const out = new Set<number>();
  for (const part of src.split(",")) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part.trim());
    if (!m) return null;
    const step = m[4] ? Number(m[4]) : 1;
    let lo = min;
    let hi = max;
    if (m[1] !== "*") {
      lo = Number(m[2]);
      hi = m[3] !== undefined ? Number(m[3]) : m[4] ? max : lo;
    }
    if (lo < min || hi > max || lo > hi || step < 1) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

/** Runs strictly after `from` and before `until`, at most `limit`. Invalid → []. */
export function nextRuns(expr: string, from: Date, until: Date, limit = 500): Date[] {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return [];
  const minutes = field(parts[0], 0, 59);
  const hours = field(parts[1], 0, 23);
  const days = field(parts[2], 1, 31);
  const months = field(parts[3], 1, 12);
  // 7 is Sunday too.
  const dows = field(parts[4].replace(/\b7\b/g, "0"), 0, 6);
  if (!minutes || !hours || !days || !months || !dows) return [];
  const anyDay = parts[2] === "*";
  const anyDow = parts[4] === "*";
  const out: Date[] = [];
  const day = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  while (day < until && out.length < limit) {
    const domOk = days.includes(day.getDate());
    const dowOk = dows.includes(day.getDay());
    // Classic cron: when both are restricted, either one matching is enough.
    const dayOk = anyDay && anyDow ? true : anyDay ? dowOk : anyDow ? domOk : domOk || dowOk;
    if (months.includes(day.getMonth() + 1) && dayOk) {
      for (const h of hours)
        for (const m of minutes) {
          const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
          if (at > from && at < until && out.length < limit) out.push(at);
        }
    }
    day.setDate(day.getDate() + 1);
  }
  return out;
}
