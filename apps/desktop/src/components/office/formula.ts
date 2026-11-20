// A small spreadsheet formula engine: parse, evaluate, format. Pure, no DOM.
// Test: node --experimental-strip-types src/components/office/formula.test.ts

export interface Fmt {
  /** number format */
  n?: "number" | "percent" | "eur" | "usd" | "date";
  /** bold */
  b?: boolean;
  /** alignment */
  a?: "left" | "center" | "right";
}

export interface Cell {
  v: string | number | boolean | null;
  f?: string;
  fmt?: Fmt;
}

export type ErrCode = "#REF!" | "#DIV/0!" | "#NAME?" | "#VALUE!" | "#N/A" | "#ERROR!";

export class FErr {
  readonly code: ErrCode;
  constructor(code: ErrCode) {
    this.code = code;
  }
  toString() {
    return this.code;
  }
}

export type Value = number | string | boolean | null | FErr;
type Arg = Value | Value[][];

// ---- addresses ----------------------------------------------------------------------------

export function colName(i: number): string {
  let s = "";
  i += 1;
  while (i > 0) {
    const m = (i - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s;
}

export function colIndex(name: string): number {
  let n = 0;
  for (const ch of name.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export const addr = (c: number, r: number) => `${colName(c)}${r + 1}`;

/** "B3" → {c: 1, r: 2}; null when not an address. */
export function parseAddr(a: string): { c: number; r: number } | null {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(a);
  if (!m) return null;
  const r = Number(m[2]) - 1;
  if (r < 0) return null;
  return { c: colIndex(m[1]), r };
}

// ---- tokens ---------------------------------------------------------------------------------

type Tok =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "ref"; v: string }
  | { t: "range"; a: string; b: string }
  | { t: "name"; v: string }
  | { t: "op"; v: string }
  | { t: "(" }
  | { t: ")" }
  | { t: "," };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      const m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i))!;
      if (!m) throw new Error("number");
      out.push({ t: "num", v: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (ch === '"') {
      let s = "";
      i++;
      while (i < src.length) {
        if (src[i] === '"' && src[i + 1] === '"') {
          s += '"';
          i += 2;
        } else if (src[i] === '"') break;
        else s += src[i++];
      }
      if (src[i] !== '"') throw new Error("string");
      i++;
      out.push({ t: "str", v: s });
      continue;
    }
    const word = /^\$?[A-Za-z_][A-Za-z0-9_.$]*/.exec(src.slice(i));
    if (word) {
      const w = word[0];
      i += w.length;
      const range = /^:(\$?[A-Za-z]{1,3}\$?\d+)/.exec(src.slice(i));
      if (parseAddr(w) && range) {
        out.push({ t: "range", a: w.replace(/\$/g, "").toUpperCase(), b: range[1].replace(/\$/g, "").toUpperCase() });
        i += range[0].length;
      } else if (parseAddr(w)) out.push({ t: "ref", v: w.replace(/\$/g, "").toUpperCase() });
      else out.push({ t: "name", v: w.toUpperCase() });
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === "<=" || two === ">=" || two === "<>") {
      out.push({ t: "op", v: two });
      i += 2;
      continue;
    }
    if ("+-*/^&=<>%".includes(ch)) {
      out.push({ t: "op", v: ch });
      i++;
      continue;
    }
    if (ch === "(" || ch === ")") {
      out.push({ t: ch });
      i++;
      continue;
    }
    if (ch === "," || ch === ";") {
      out.push({ t: "," });
      i++;
      continue;
    }
    throw new Error(`unexpected ${ch}`);
  }
  return out;
}

// ---- parser ---------------------------------------------------------------------------------

export type Node =
  | { k: "lit"; v: Value }
  | { k: "ref"; a: string }
  | { k: "range"; a: string; b: string }
  | { k: "un"; op: string; x: Node }
  | { k: "bin"; op: string; l: Node; r: Node }
  | { k: "call"; name: string; args: Node[] }
  | { k: "name"; name: string };

const PREC: Record<string, number> = { "=": 1, "<>": 1, "<": 1, ">": 1, "<=": 1, ">=": 1, "&": 2, "+": 3, "-": 3, "*": 4, "/": 4, "^": 5 };

export function parse(src: string): Node {
  const toks = tokenize(src);
  let i = 0;
  const peek = () => toks[i];
  const expr = (min: number): Node => {
    let left = unary();
    for (;;) {
      const tk = peek();
      if (!tk || tk.t !== "op" || PREC[tk.v] === undefined || PREC[tk.v] < min) break;
      i++;
      // ^ is right-associative, the rest left.
      const right = expr(tk.v === "^" ? PREC[tk.v] : PREC[tk.v] + 1);
      left = { k: "bin", op: tk.v, l: left, r: right };
    }
    return left;
  };
  const unary = (): Node => {
    const tk = peek();
    if (tk && tk.t === "op" && (tk.v === "-" || tk.v === "+")) {
      i++;
      return { k: "un", op: tk.v, x: unary() };
    }
    let n = primary();
    while (peek()?.t === "op" && (peek() as { v: string }).v === "%") {
      i++;
      n = { k: "bin", op: "/", l: n, r: { k: "lit", v: 100 } };
    }
    return n;
  };
  const primary = (): Node => {
    const tk = toks[i++];
    if (!tk) throw new Error("end");
    switch (tk.t) {
      case "num":
        return { k: "lit", v: tk.v };
      case "str":
        return { k: "lit", v: tk.v };
      case "ref":
        return { k: "ref", a: tk.v };
      case "range":
        return { k: "range", a: tk.a, b: tk.b };
      case "(": {
        const e = expr(0);
        if (toks[i++]?.t !== ")") throw new Error(")");
        return e;
      }
      case "name": {
        if (peek()?.t === "(") {
          i++;
          const args: Node[] = [];
          if (peek()?.t !== ")") {
            for (;;) {
              args.push(expr(0));
              if (peek()?.t === ",") i++;
              else break;
            }
          }
          if (toks[i++]?.t !== ")") throw new Error(")");
          return { k: "call", name: tk.v, args };
        }
        if (tk.v === "TRUE") return { k: "lit", v: true };
        if (tk.v === "FALSE") return { k: "lit", v: false };
        return { k: "name", name: tk.v };
      }
      default:
        throw new Error("unexpected");
    }
  };
  const n = expr(0);
  if (i < toks.length) throw new Error("trailing");
  return n;
}

// ---- evaluation -------------------------------------------------------------------------------

const isErr = (v: unknown): v is FErr => v instanceof FErr;

function num(v: Value): number | FErr {
  if (isErr(v)) return v;
  if (v === null || v === "") return 0;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : new FErr("#VALUE!");
}

function str(v: Value): string {
  if (v === null) return "";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") return String(Math.round(v * 1e10) / 1e10);
  return String(v);
}

function bool(v: Value): boolean | FErr {
  if (isErr(v)) return v;
  if (typeof v === "string") {
    if (v.toUpperCase() === "TRUE") return true;
    if (v.toUpperCase() === "FALSE" || v === "") return false;
    return new FErr("#VALUE!");
  }
  return !!v;
}

/** Every value of the arguments, ranges flattened. */
const flat = (args: Arg[]): Value[] => args.flatMap((a) => (Array.isArray(a) ? a.flat() : [a]));

/** Numbers among the arguments: numbers in ranges, anything numeric given directly. */
function nums(args: Arg[]): number[] | FErr {
  const out: number[] = [];
  for (const a of args) {
    if (Array.isArray(a)) {
      for (const v of a.flat()) {
        if (isErr(v)) return v;
        if (typeof v === "number") out.push(v);
      }
    } else {
      const n = num(a);
      if (isErr(n)) return n;
      out.push(n);
    }
  }
  return out;
}

const scalar = (a: Arg): Value => (Array.isArray(a) ? (a[0]?.[0] ?? null) : a);

/** Days since 1899-12-30, like other spreadsheets. */
export function dateSerial(d: Date): number {
  return Math.floor((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(1899, 11, 30)) / 86400000);
}

export function serialToIso(n: number): string {
  return new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400000).toISOString().slice(0, 10);
}

function compare(a: Value, b: Value): number {
  if (a === null) a = typeof b === "string" ? "" : 0;
  if (b === null) b = typeof a === "string" ? "" : 0;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") return a.localeCompare(b, undefined, { sensitivity: "base" });
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  // numbers < text < booleans
  const rank = (v: Value) => (typeof v === "number" ? 0 : typeof v === "string" ? 1 : 2);
  return rank(a) - rank(b);
}

type Fn = (args: Arg[], raw: Node[], ev: (n: Node) => Arg) => Value;

const FNS: Record<string, Fn> = {
  SUM: (a) => {
    const n = nums(a);
    return isErr(n) ? n : n.reduce((x, y) => x + y, 0);
  },
  AVERAGE: (a) => {
    const n = nums(a);
    if (isErr(n)) return n;
    return n.length ? n.reduce((x, y) => x + y, 0) / n.length : new FErr("#DIV/0!");
  },
  MIN: (a) => {
    const n = nums(a);
    return isErr(n) ? n : n.length ? Math.min(...n) : 0;
  },
  MAX: (a) => {
    const n = nums(a);
    return isErr(n) ? n : n.length ? Math.max(...n) : 0;
  },
  COUNT: (a) => flat(a).filter((v) => typeof v === "number").length,
  COUNTA: (a) => flat(a).filter((v) => v !== null && v !== "").length,
  IF: (_a, raw, ev) => {
    if (raw.length < 2) return new FErr("#VALUE!");
    const c = bool(scalar(ev(raw[0])));
    if (isErr(c)) return c;
    if (c) return scalar(ev(raw[1]));
    return raw[2] ? scalar(ev(raw[2])) : false;
  },
  AND: (a) => {
    for (const v of flat(a)) {
      const b = bool(v);
      if (isErr(b)) return b;
      if (!b) return false;
    }
    return true;
  },
  OR: (a) => {
    let any = false;
    for (const v of flat(a)) {
      const b = bool(v);
      if (isErr(b)) return b;
      any ||= b;
    }
    return any;
  },
  ROUND: (a) => {
    const x = num(scalar(a[0] ?? null));
    const d = num(scalar(a[1] ?? 0));
    if (isErr(x)) return x;
    if (isErr(d)) return d;
    const f = 10 ** Math.trunc(d);
    return Math.sign(x) * (Math.round(Math.abs(x) * f + 1e-9) / f);
  },
  ABS: (a) => {
    const x = num(scalar(a[0] ?? null));
    return isErr(x) ? x : Math.abs(x);
  },
  CONCAT: (a) => {
    const v = flat(a);
    const e = v.find(isErr);
    return e ?? v.map(str).join("");
  },
  LEN: (a) => {
    const v = scalar(a[0] ?? null);
    return isErr(v) ? v : str(v).length;
  },
  UPPER: (a) => {
    const v = scalar(a[0] ?? null);
    return isErr(v) ? v : str(v).toUpperCase();
  },
  LOWER: (a) => {
    const v = scalar(a[0] ?? null);
    return isErr(v) ? v : str(v).toLowerCase();
  },
  TODAY: () => dateSerial(new Date()),
  VLOOKUP: (a) => {
    const key = scalar(a[0] ?? null);
    const table = a[1];
    const col = num(scalar(a[2] ?? null));
    const approx = a[3] === undefined ? true : bool(scalar(a[3]));
    if (isErr(key)) return key;
    if (isErr(col)) return col;
    if (isErr(approx)) return approx;
    if (!Array.isArray(table)) return new FErr("#VALUE!");
    const c = Math.trunc(col) - 1;
    if (c < 0 || c >= (table[0]?.length ?? 0)) return new FErr("#REF!");
    if (!approx) {
      const row = table.find((r) => r[0] !== null && compare(r[0], key) === 0 && typeof r[0] === typeof key);
      return row ? row[c] : new FErr("#N/A");
    }
    let hit: Value[] | null = null;
    for (const r of table) {
      if (r[0] === null) continue;
      if (compare(r[0], key) <= 0) hit = r;
      else break;
    }
    return hit ? hit[c] : new FErr("#N/A");
  },
};
FNS.CONCATENATE = FNS.CONCAT;

/** Raw value of a cell as typed (numbers stay numbers, empty is null). */
export function literal(cell: Cell | undefined): Value {
  if (!cell) return null;
  const v = cell.v;
  if (v === "" || v === undefined) return null;
  return v;
}

export interface Sheet {
  /** Computed value of one cell. */
  get(a: string): Value;
}

/**
 * Evaluate a sheet lazily: each cell is computed once, on demand. A cell that
 * depends on itself, directly or not, is #REF!.
 */
export function evaluate(cells: Record<string, Cell>, maxRows = 100000, maxCols = 702): Sheet {
  const done = new Map<string, Value>();
  const busy = new Set<string>();
  const parsed = new Map<string, Node | FErr>();

  const ast = (a: string, f: string) => {
    let n = parsed.get(a);
    if (!n) {
      try {
        n = parse(f.replace(/^=/, ""));
      } catch {
        n = new FErr("#ERROR!");
      }
      parsed.set(a, n);
    }
    return n;
  };

  const get = (a: string): Value => {
    if (done.has(a)) return done.get(a)!;
    const cell = cells[a];
    if (!cell?.f) {
      const v = literal(cell);
      done.set(a, v);
      return v;
    }
    if (busy.has(a)) return new FErr("#REF!");
    busy.add(a);
    const n = ast(a, cell.f);
    let v: Value;
    if (isErr(n)) v = n;
    else {
      const r = run(n);
      v = Array.isArray(r) ? (r[0]?.[0] ?? null) : r;
      // An empty reference shows as 0 in a formula cell.
      if (v === null) v = 0;
    }
    busy.delete(a);
    done.set(a, v);
    return v;
  };

  let maxRow = -1;
  for (const k of Object.keys(cells)) maxRow = Math.max(maxRow, parseAddr(k)?.r ?? 0);

  const range = (a: string, b: string): Value[][] | FErr => {
    const p = parseAddr(a);
    const q = parseAddr(b);
    if (!p || !q) return new FErr("#REF!");
    const [c0, c1] = [Math.min(p.c, q.c), Math.max(p.c, q.c)];
    const [r0, r1] = [Math.min(p.r, q.r), Math.max(p.r, q.r)];
    if (c1 >= maxCols || r1 >= maxRows) return new FErr("#REF!");
    // Big ranges (A:A-like) only touch the cells that exist.
    const rows: Value[][] = [];
    const lastRow = Math.min(r1, Math.max(r0, maxRow));
    for (let r = r0; r <= lastRow; r++) {
      const row: Value[] = [];
      for (let c = c0; c <= c1; c++) row.push(get(addr(c, r)));
      rows.push(row);
    }
    return rows;
  };

  const run = (n: Node): Arg => {
    switch (n.k) {
      case "lit":
        return n.v;
      case "ref": {
        const p = parseAddr(n.a);
        if (!p || p.c >= maxCols || p.r >= maxRows) return new FErr("#REF!");
        return get(n.a);
      }
      case "range":
        return range(n.a, n.b);
      case "name":
        return new FErr("#NAME?");
      case "un": {
        const x = num(scalar(run(n.x)));
        if (isErr(x)) return x;
        return n.op === "-" ? -x : x;
      }
      case "bin": {
        const l = scalar(run(n.l));
        const r = scalar(run(n.r));
        if (isErr(l)) return l;
        if (isErr(r)) return r;
        if (n.op === "&") return str(l) + str(r);
        if (["=", "<>", "<", ">", "<=", ">="].includes(n.op)) {
          const c = compare(l ?? (typeof r === "string" ? "" : 0), r ?? (typeof l === "string" ? "" : 0));
          return n.op === "=" ? c === 0 : n.op === "<>" ? c !== 0 : n.op === "<" ? c < 0 : n.op === ">" ? c > 0 : n.op === "<=" ? c <= 0 : c >= 0;
        }
        const x = num(l);
        const y = num(r);
        if (isErr(x)) return x;
        if (isErr(y)) return y;
        switch (n.op) {
          case "+":
            return x + y;
          case "-":
            return x - y;
          case "*":
            return x * y;
          case "/":
            return y === 0 ? new FErr("#DIV/0!") : x / y;
          case "^":
            return x ** y;
        }
        return new FErr("#VALUE!");
      }
      case "call": {
        const fn = FNS[n.name];
        if (!fn) return new FErr("#NAME?");
        // IF evaluates lazily; the rest get their arguments up front.
        if (n.name === "IF") return fn([], n.args, run);
        const args = n.args.map(run);
        const e = args.find((a) => isErr(a)) as FErr | undefined;
        if (e) return e;
        return fn(args, n.args, run);
      }
    }
  };

  return { get };
}

/** Every computed value, for cells that hold something. */
export function computeAll(cells: Record<string, Cell>): Record<string, Value> {
  const s = evaluate(cells);
  const out: Record<string, Value> = {};
  for (const a of Object.keys(cells)) out[a] = s.get(a);
  return out;
}

// ---- input and display ----------------------------------------------------------------------

/** What someone typed into a cell, as a cell. Keeps an existing format. */
export function parseInput(text: string, fmt?: Fmt): Cell | null {
  const s = text.trim();
  if (!s) return null;
  if (s.startsWith("=") && s.length > 1) return { v: "", f: s, ...(fmt ? { fmt } : {}) };
  const pct = /^(-?\d+(?:[.,]\d+)?)\s*%$/.exec(s);
  if (pct) return { v: Number(pct[1].replace(",", ".")) / 100, fmt: { ...fmt, n: "percent" } };
  const cur = /^([€$])\s*(-?[\d.,]+)$/.exec(s) ?? /^(-?[\d.,]+)\s*([€$])$/.exec(s);
  if (cur) {
    const sym = cur[1] === "€" || cur[1] === "$" ? cur[1] : cur[2];
    const n = numberish(cur[1] === sym ? cur[2] : cur[1]);
    if (n !== null) return { v: n, fmt: { ...fmt, n: sym === "€" ? "eur" : "usd" } };
  }
  const n = numberish(s);
  if (n !== null) return { v: n, ...(fmt ? { fmt } : {}) };
  if (/^(true|false)$/i.test(s)) return { v: s.toUpperCase() === "TRUE", ...(fmt ? { fmt } : {}) };
  return { v: text, ...(fmt ? { fmt } : {}) };
}

/** "1234.5", "1,234.5" and "1.234,5" all read as numbers. */
function numberish(s: string): number | null {
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(s)) return Number(s);
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) return Number(s.replace(/,/g, ""));
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) return Number(s.replace(/\./g, "").replace(",", "."));
  if (/^-?\d+,\d+$/.test(s)) return Number(s.replace(",", "."));
  return null;
}

export function formatValue(v: Value, fmt?: Fmt, locale = "en"): string {
  if (v === null) return "";
  if (isErr(v)) return v.code;
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "string") return v;
  switch (fmt?.n) {
    case "percent":
      return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 2 }).format(v);
    case "eur":
      return new Intl.NumberFormat(locale, { style: "currency", currency: "EUR" }).format(v);
    case "usd":
      return new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(v);
    case "date":
      return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(new Date(serialToIso(v)));
    case "number":
      return new Intl.NumberFormat(locale, { maximumFractionDigits: 2, minimumFractionDigits: 2 }).format(v);
  }
  return String(Math.round(v * 1e10) / 1e10);
}

/** The text an editor starts with for a cell. */
export const editText = (c: Cell | undefined) => (c?.f ? c.f : c?.v === null || c?.v === undefined ? "" : typeof c.v === "boolean" ? (c.v ? "TRUE" : "FALSE") : String(c.v));

// ---- CSV / TSV --------------------------------------------------------------------------------

export function parseDelimited(text: string, sep: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"' && cur === "") q = true;
    else if (ch === sep) {
      row.push(cur);
      cur = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cur);
      rows.push(row);
      row = [];
      cur = "";
    } else cur += ch;
  }
  if (cur !== "" || row.length) {
    row.push(cur);
    rows.push(row);
  }
  return rows;
}

export function toDelimited(rows: string[][], sep: string): string {
  const esc = (s: string) => (s.includes(sep) || s.includes('"') || s.includes("\n") ? `"${s.replace(/"/g, '""')}"` : s);
  return rows.map((r) => r.map(esc).join(sep)).join("\n");
}
