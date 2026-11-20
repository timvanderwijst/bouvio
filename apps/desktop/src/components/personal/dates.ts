// Natural dates for quick add: "today", "tomorrow", "fri", "next week", "12 dec".
// Pure and dependency-free, so `node dates.test.mjs` can run it as is.

export type QuickPriority = "low" | "medium" | "high";

export interface QuickAdd {
  title: string;
  /** Local date, YYYY-MM-DD. */
  due: string | null;
  priority: QuickPriority | null;
}

const WEEKDAYS: Record<string, number> = {
  sun: 0, sunday: 0, zondag: 0,
  mon: 1, monday: 1, maandag: 1,
  tue: 2, tues: 2, tuesday: 2, dinsdag: 2,
  wed: 3, wednesday: 3, woensdag: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, donderdag: 4,
  fri: 5, friday: 5, vrijdag: 5,
  sat: 6, saturday: 6, zaterdag: 6,
};

const MONTHS: Record<string, number> = {
  jan: 0, january: 0, januari: 0,
  feb: 1, february: 1, februari: 1,
  mar: 2, march: 2, mrt: 2, maart: 2,
  apr: 3, april: 3,
  may: 4, mei: 4,
  jun: 5, june: 5, juni: 5,
  jul: 6, july: 6, juli: 6,
  aug: 7, august: 7, augustus: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9, okt: 9, oktober: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

export function isoDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

const alt = (o: Record<string, number>) => Object.keys(o).sort((a, b) => b.length - a.length).join("|");
const LEAD = "(?:(?:on|by|due|op|voor|per)\\s+)?";
const RULES: { re: RegExp; date: (m: RegExpMatchArray, today: Date) => Date | null }[] = [
  { re: new RegExp(`(?:^|\\s)${LEAD}(?:today|tod|vandaag)(?=\\s|$)`, "i"), date: (_, t) => t },
  { re: new RegExp(`(?:^|\\s)${LEAD}(?:tomorrow|tmrw?|morgen)(?=\\s|$)`, "i"), date: (_, t) => addDays(t, 1) },
  {
    re: new RegExp(`(?:^|\\s)${LEAD}(?:next week|volgende week)(?=\\s|$)`, "i"),
    // The Monday after this week.
    date: (_, t) => addDays(t, ((8 - t.getDay()) % 7) || 7),
  },
  {
    re: new RegExp(`(?:^|\\s)${LEAD}(\\d{1,2})(?:st|nd|rd|th)?\\s+(${alt(MONTHS)})\\.?(?:\\s+(\\d{4}))?(?=\\s|$)`, "i"),
    date: (m, t) => dayMonth(+m[1], MONTHS[m[2].toLowerCase()], m[3] ? +m[3] : null, t),
  },
  {
    re: new RegExp(`(?:^|\\s)${LEAD}(${alt(MONTHS)})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?(?=\\s|$)`, "i"),
    date: (m, t) => dayMonth(+m[2], MONTHS[m[1].toLowerCase()], m[3] ? +m[3] : null, t),
  },
  {
    // A weekday only counts after "on/by" or at the very end: "sun cream" stays a title.
    re: new RegExp(`(?:^|\\s)(?:(?:on|by|due|op|voor)\\s+(?:next\\s+)?(${alt(WEEKDAYS)})(?=\\s|$)|(?:next\\s+)?(${alt(WEEKDAYS)})\\.?$)`, "i"),
    date: (m, t) => {
      const want = WEEKDAYS[(m[1] ?? m[2]).toLowerCase()];
      // Always ahead: "fri" on a Friday means next Friday.
      return addDays(t, ((want - t.getDay() + 7) % 7) || 7);
    },
  },
];

function dayMonth(day: number, month: number, year: number | null, today: Date): Date | null {
  const y = year ?? today.getFullYear();
  let d = new Date(y, month, day);
  if (d.getMonth() !== month) return null; // 31 feb
  // Without a year, a date that has passed means next year.
  if (year === null && d < new Date(today.getFullYear(), today.getMonth(), today.getDate())) d = new Date(y + 1, month, day);
  return d;
}

const PRIORITY = /(?:^|\s)(!{1,3}|!(?:high|hoog|h|med|medium|m|low|laag|l))(?=\s|$)/i;

/** Pull a due date and a priority out of a quick-add line. */
export function parseQuickAdd(input: string, today: Date = new Date()): QuickAdd {
  let text = ` ${input.trim()} `.replace(/\s+/g, " ");
  let due: string | null = null;
  let priority: QuickPriority | null = null;

  const p = text.match(PRIORITY);
  if (p) {
    const v = p[1].toLowerCase();
    priority = v === "!!!" || /^!(high|hoog|h)$/.test(v) ? "high" : v === "!!" || /^!(med|medium|m)$/.test(v) ? "medium" : "low";
    text = text.replace(p[0], " ");
  }

  const base = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  for (const rule of RULES) {
    const m = text.trim().match(rule.re);
    if (!m) continue;
    const d = rule.date(m, base);
    if (!d) continue;
    due = isoDate(d);
    text = text.trim().replace(m[0], " ");
    break;
  }
  return { title: text.replace(/\s+/g, " ").trim(), due, priority };
}

/** Days from `today` to an ISO date: negative is overdue. */
export function daysUntil(iso: string, today: Date = new Date()): number {
  const [y, m, d] = iso.split("-").map(Number);
  const a = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  return Math.round((new Date(y, m - 1, d).getTime() - a) / 86_400_000);
}
