// Reading and changing a database's Yjs doc. Shared by the database editor,
// forms and the calendar.

import * as Y from "yjs";
import type { Field, Row, Schema, View } from "./dbview";
import { shortId } from "./sync";

export const dbParts = (ydoc: Y.Doc) => ({
  schema: ydoc.getMap<Field>("schema"),
  rows: ydoc.getArray<Y.Map<unknown>>("rows"),
  views: ydoc.getArray<Y.Map<unknown>>("views"),
});

export function readDb(ydoc: Y.Doc): { schema: Schema; rows: Row[]; views: View[] } {
  const p = dbParts(ydoc);
  return {
    schema: p.schema.toJSON() as Schema,
    rows: p.rows.toArray().map((m) => m.toJSON() as Row),
    views: p.views.toArray().map((m) => {
      const v = m.toJSON() as View;
      return { ...v, filters: v.filters ?? [], sorts: v.sorts ?? [] };
    }),
  };
}

export function addRow(ydoc: Y.Doc, values: Record<string, unknown> = {}, at?: number): string {
  const rows = dbParts(ydoc).rows;
  const m = new Y.Map<unknown>();
  const id = shortId();
  m.set("id", id);
  m.set("created", new Date().toISOString());
  for (const [k, v] of Object.entries(values)) if (v !== undefined && v !== null && v !== "") m.set(k, v);
  rows.insert(at ?? rows.length, [m]);
  return id;
}

const rowMap = (ydoc: Y.Doc, id: string) => dbParts(ydoc).rows.toArray().find((m) => m.get("id") === id);

export function setCell(ydoc: Y.Doc, rowId: string, field: string, value: unknown) {
  const m = rowMap(ydoc, rowId);
  if (!m) return;
  if (value === undefined || value === null || value === "" || (Array.isArray(value) && !value.length)) m.delete(field);
  else m.set(field, value);
}

export function deleteRow(ydoc: Y.Doc, rowId: string) {
  const rows = dbParts(ydoc).rows;
  const i = rows.toArray().findIndex((m) => m.get("id") === rowId);
  if (i >= 0) rows.delete(i, 1);
}

export function putField(ydoc: Y.Doc, f: Field) {
  dbParts(ydoc).schema.set(f.id, f);
}

export function deleteField(ydoc: Y.Doc, id: string) {
  const p = dbParts(ydoc);
  ydoc.transact(() => {
    p.schema.delete(id);
    for (const r of p.rows.toArray()) r.delete(id);
  });
}

export function addView(ydoc: Y.Doc, v: Omit<View, "id">): string {
  const m = new Y.Map<unknown>();
  const id = shortId();
  for (const [k, val] of Object.entries({ ...v, id })) if (val !== undefined) m.set(k, val);
  dbParts(ydoc).views.push([m]);
  return id;
}

export function patchView(ydoc: Y.Doc, id: string, patch: Partial<View>) {
  const m = dbParts(ydoc).views.toArray().find((x) => x.get("id") === id);
  if (!m) return;
  ydoc.transact(() => {
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) m.delete(k);
      else m.set(k, v);
    }
  });
}

export function deleteView(ydoc: Y.Doc, id: string) {
  const views = dbParts(ydoc).views;
  const i = views.toArray().findIndex((x) => x.get("id") === id);
  if (i >= 0) views.delete(i, 1);
}
