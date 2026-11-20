// Database fields, views, filters and sorts. Pure; the editor stores these in Yjs.

export type FieldType = "text" | "number" | "select" | "multi_select" | "date" | "person" | "checkbox" | "url";
export const FIELD_TYPES: FieldType[] = ["text", "number", "select", "multi_select", "date", "person", "checkbox", "url"];

export interface Option {
  id: string;
  name: string;
  color: string;
}

export interface Field {
  id: string;
  name: string;
  type: FieldType;
  order: number;
  options?: Option[];
}

export type Schema = Record<string, Field>;

export type FilterOp = "is" | "is_not" | "contains" | "empty" | "not_empty" | "gt" | "lt";
export interface Filter {
  field: string;
  op: FilterOp;
  value?: unknown;
}
export interface Sort {
  field: string;
  desc: boolean;
}

export type ViewType = "table" | "kanban" | "calendar" | "gallery";
export interface View {
  id: string;
  name: string;
  type: ViewType;
  group_by?: string;
  date_field?: string;
  filters: Filter[];
  sorts: Sort[];
}

export type Row = { id: string } & Record<string, unknown>;

export const OPTION_COLORS = ["gray", "blue", "green", "yellow", "orange", "red", "purple", "pink"];

export const fieldList = (s: Schema): Field[] => Object.values(s).sort((a, b) => a.order - b.order);

/** The field that names a row: the first text field. */
export const titleField = (s: Schema): Field | undefined => fieldList(s).find((f) => f.type === "text");

export function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || v === "" || v === false || (Array.isArray(v) && v.length === 0);
}

/** A cell as text, for search, sorting and contains filters. */
export function cellText(f: Field | undefined, v: unknown): string {
  if (isEmpty(v)) return "";
  if (!f) return String(v);
  if (f.type === "select") return f.options?.find((o) => o.id === v)?.name ?? "";
  if (f.type === "multi_select") return (v as string[]).map((id) => f.options?.find((o) => o.id === id)?.name ?? "").join(", ");
  if (f.type === "checkbox") return v ? "✓" : "";
  return String(v);
}

function matches(row: Row, schema: Schema, flt: Filter): boolean {
  const f = schema[flt.field];
  const v = row[flt.field];
  switch (flt.op) {
    case "empty":
      return isEmpty(v);
    case "not_empty":
      return !isEmpty(v);
    case "contains":
      return cellText(f, v).toLowerCase().includes(String(flt.value ?? "").toLowerCase());
    case "is":
    case "is_not": {
      let hit: boolean;
      if (f?.type === "multi_select") hit = Array.isArray(v) && v.includes(flt.value);
      else if (f?.type === "checkbox") hit = !!v === !!flt.value;
      else if (f?.type === "number") hit = Number(v) === Number(flt.value);
      else hit = String(v ?? "").toLowerCase() === String(flt.value ?? "").toLowerCase();
      return flt.op === "is" ? hit : !hit;
    }
    case "gt":
    case "lt": {
      if (isEmpty(v) || isEmpty(flt.value)) return false;
      const a = f?.type === "number" ? Number(v) : String(v);
      const b = f?.type === "number" ? Number(flt.value) : String(flt.value);
      return flt.op === "gt" ? a > b : a < b;
    }
  }
}

function cmp(f: Field | undefined, a: unknown, b: unknown): number {
  // Empty values go last whatever the direction.
  if (isEmpty(a) && isEmpty(b)) return 0;
  if (isEmpty(a)) return 1;
  if (isEmpty(b)) return -1;
  if (f?.type === "number") return Number(a) - Number(b);
  if (f?.type === "checkbox") return Number(!!a) - Number(!!b);
  if (f?.type === "select") {
    const i = (x: unknown) => f.options?.findIndex((o) => o.id === x) ?? 0;
    return i(a) - i(b);
  }
  return cellText(f, a).localeCompare(cellText(f, b), undefined, { sensitivity: "base", numeric: true });
}

export function applyView(rows: Row[], schema: Schema, view: View): Row[] {
  let out = rows.filter((r) => view.filters.every((f) => !schema[f.field] || matches(r, schema, f)));
  if (view.sorts.length) {
    out = [...out].sort((a, b) => {
      for (const s of view.sorts) {
        const f = schema[s.field];
        if (!f) continue;
        const bothEmpty = isEmpty(a[s.field]) || isEmpty(b[s.field]);
        const c = cmp(f, a[s.field], b[s.field]);
        if (c) return s.desc && !bothEmpty ? -c : c;
      }
      return 0;
    });
  }
  return out;
}
