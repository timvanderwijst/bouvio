// Browser-preview stand-ins for this area's runner methods (`handlers`) and
// desktop-only app methods (`app`). See ../mock-bus.ts to fire live events.
//
// Office keeps real Yjs docs in memory here, seeded with sample content, so the
// editors behave as they do against the runner. A colleague shows up in one doc.

import * as Y from "yjs";
import { Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";
import type { Doc } from "../../protocol/Doc";
import type { DocKind } from "../../protocol/DocKind";
import type { PublicForm } from "../../protocol/PublicForm";
import { mockFire } from "../mock-bus";

const uid = () => crypto.randomUUID();
const sid = () => Math.random().toString(36).slice(2, 12);
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const day = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const b64 = (u: Uint8Array) => {
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

const docs: Doc[] = [];
const ydocs = new Map<string, Y.Doc>();
const seeded = new Set<string>();

const notice = (workspace_id: string, kind: string, payload: unknown) => mockFire("workspace-notice", { workspace_id, kind, payload });

// ---- seeding ----------------------------------------------------------------------------------

function block(frag: Y.XmlFragment, kind: string, text = "", extra?: Record<string, unknown>) {
  const el = (tag: string, attrs?: Record<string, unknown>) => {
    const e = new Y.XmlElement(tag);
    for (const [k, v] of Object.entries(attrs ?? {})) e.setAttribute(k, v as string);
    return e;
  };
  const para = (s: string) => {
    const p = el("paragraph");
    if (s) p.insert(0, [new Y.XmlText(s)]);
    return p;
  };
  if (kind === "h1" || kind === "h2" || kind === "h3") {
    const h = el("heading", { level: Number(kind[1]) });
    if (text) h.insert(0, [new Y.XmlText(text)]);
    frag.push([h]);
  } else if (kind === "li" || kind === "todo") {
    const list = el(kind === "li" ? "bulletList" : "taskList");
    const items = text.split("\n").map((line) => {
      const item = el(kind === "li" ? "listItem" : "taskItem", kind === "todo" ? { checked: !!extra?.checked && line.startsWith("✓") } : undefined);
      item.insert(0, [para(line.replace(/^✓ ?/, ""))]);
      return item;
    });
    list.insert(0, items);
    frag.push([list]);
  } else if (kind === "quote") {
    const q = el("blockquote");
    q.insert(0, [para(text)]);
    frag.push([q]);
  } else frag.push([para(text)]);
}

type FieldSeed = { id: string; name: string; type: string; order: number; options?: { id: string; name: string; color: string }[] };
const field = (id: string, name: string, type: string, order: number, opts: [string, string][] = []): FieldSeed => ({
  id,
  name,
  type,
  order,
  ...(opts.length ? { options: opts.map(([n, c], i) => ({ id: `${id}-${i}`, name: n, color: c })) } : {}),
});
const ymap = (o: Record<string, unknown>) => {
  const m = new Y.Map<unknown>();
  for (const [k, v] of Object.entries(o)) if (v !== undefined) m.set(k, v);
  return m;
};

function seed(y: Y.Doc, kind: DocKind, template: string | null, formFields: FieldSeed[] = []) {
  if (kind === "doc") {
    const f = y.getXmlFragment("content");
    if (template === "meeting-notes") {
      block(f, "p", "Date · Attendees");
      block(f, "h2", "Agenda");
      block(f, "li", "");
      block(f, "h2", "Notes");
      block(f, "p");
      block(f, "h2", "Decisions");
      block(f, "li", "");
      block(f, "h2", "Action items");
      block(f, "todo", "");
    } else if (template === "project-brief") {
      for (const [h, p] of [
        ["Goal", "What changes for whom, and how we will know."],
        ["Context", ""],
        ["Scope", ""],
        ["Milestones", ""],
        ["Risks and open questions", ""],
      ]) {
        block(f, "h2", h);
        block(f, "p", p);
      }
    } else if (template === "sample") {
      block(f, "p", "Weekly sync for the desktop and runner crews. Decisions land here first, issues follow.");
      block(f, "h2", "Agenda");
      block(f, "li", "Office area: docs, sheets and databases on Yjs\nHub relay for public forms\nRelease 0.4 checklist");
      block(f, "h2", "Notes");
      block(f, "p", "The runner keeps every document as a yrs doc and snapshots it after a quiet second. Edits from the hub merge the same way as local ones, so there is no lock and no last-writer-wins.");
      block(f, "quote", "Ship the editors behind the Docs page first; the calendar can follow a week later.");
      block(f, "h2", "Action items");
      block(f, "todo", "✓ Draft the formula engine tests\nWire public form submissions through the hub\nWrite the release notes", { checked: true });
    }
  } else if (kind === "sheet") {
    const cells = y.getMap<unknown>("cells");
    if (template === "budget" || template === "sample") {
      const rows: [string, number, number][] = [
        ["Hosting", 40, 36],
        ["Domains", 15, 15],
        ["Design", 600, 720],
        ["Ads", 300, 180],
        ["Tools", 120, 95],
      ];
      for (const [a, v] of [
        ["A1", "Category"],
        ["B1", "Planned"],
        ["C1", "Actual"],
        ["D1", "Difference"],
        ["E1", "Used"],
      ])
        cells.set(a, { v, fmt: { b: true, ...(a === "A1" ? {} : { a: "right" }) } });
      rows.forEach(([name, p, act], i) => {
        const n = i + 2;
        cells.set(`A${n}`, { v: name });
        cells.set(`B${n}`, { v: p, fmt: { n: "eur" } });
        cells.set(`C${n}`, { v: act, fmt: { n: "eur" } });
        cells.set(`D${n}`, { v: "", f: `=B${n}-C${n}`, fmt: { n: "eur" } });
        cells.set(`E${n}`, { v: "", f: `=IF(B${n}=0,0,C${n}/B${n})`, fmt: { n: "percent" } });
      });
      const t = rows.length + 2;
      cells.set(`A${t}`, { v: "Total", fmt: { b: true } });
      for (const c of ["B", "C", "D"]) cells.set(`${c}${t}`, { v: "", f: `=SUM(${c}2:${c}${t - 1})`, fmt: { n: "eur", b: true } });
      cells.set(`E${t}`, { v: "", f: `=ROUND(C${t}/B${t},4)`, fmt: { n: "percent", b: true } });
      y.getMap("cols").set("A", 160);
    }
  } else if (kind === "slides") {
    const slides = y.getArray<Y.Map<unknown>>("slides");
    const slide = (layout: string, blocks: Record<string, unknown>[]) => {
      const m = ymap({ id: sid(), layout });
      const arr = new Y.Array<Y.Map<unknown>>();
      arr.push(blocks.map((b) => ymap({ id: sid(), ...b })));
      m.set("blocks", arr);
      return m;
    };
    if (template === "sample") {
      slides.push([
        slide("title", [
          { type: "title", x: 8, y: 34, w: 84, h: 18, text: "Roadmap review", size: 9 },
          { type: "text", x: 8, y: 54, w: 84, h: 12, text: "Q4 · desktop, runner and hub", size: 4.5 },
          { type: "shape", shape: "rect", x: 8, y: 30, w: 6, h: 1.2, fill: "accent" },
        ]),
        slide("content", [
          { type: "title", x: 7, y: 8, w: 86, h: 14, text: "What shipped", size: 7 },
          { type: "text", x: 7, y: 26, w: 52, h: 64, text: "Office area with live docs, sheets and databases\nPublic forms through the hub\nCalendar across every database", size: 4.2 },
          { type: "shape", shape: "ellipse", x: 66, y: 30, w: 24, h: 42, fill: "ok" },
        ]),
        slide("content", [
          { type: "title", x: 7, y: 8, w: 86, h: 14, text: "Next", size: 7 },
          { type: "text", x: 7, y: 26, w: 86, h: 64, text: "Comments in docs\nCharts from sheets\nOffline edits that merge on reconnect", size: 4.2 },
        ]),
      ]);
    } else
      slides.push([
        slide("title", [
          { type: "title", x: 8, y: 34, w: 84, h: 18, text: "", size: 9 },
          { type: "text", x: 8, y: 54, w: 84, h: 12, text: "", size: 4.5 },
        ]),
      ]);
  } else if (kind === "database") {
    const schema = y.getMap<unknown>("schema");
    const rows = y.getArray<Y.Map<unknown>>("rows");
    const views = y.getArray<Y.Map<unknown>>("views");
    const view = (name: string, type: string, extra: Record<string, unknown> = {}) => ymap({ id: sid(), name, type, filters: [], sorts: [], ...extra });
    const row = (o: Record<string, unknown>) => ymap({ id: sid(), created: new Date().toISOString(), ...o });
    if (template === "content-calendar") {
      for (const f of [
        field("title", "Title", "text", 0),
        field("status", "Status", "select", 1, [
          ["Idea", "gray"],
          ["Drafting", "yellow"],
          ["Review", "blue"],
          ["Published", "green"],
        ]),
        field("channel", "Channel", "select", 2, [
          ["Blog", "purple"],
          ["Newsletter", "orange"],
          ["Social", "pink"],
        ]),
        field("date", "Publish date", "date", 3),
        field("owner", "Owner", "person", 4),
      ])
        schema.set(f.id, f);
      rows.push([
        row({ title: "Launch announcement", status: "status-2", channel: "channel-0", date: day(2), owner: "Maya" }),
        row({ title: "Monthly update", status: "status-1", channel: "channel-1", date: day(6), owner: "Sanne" }),
        row({ title: "Behind the scenes: the formula engine", status: "status-0", channel: "channel-2", date: day(9) }),
        row({ title: "Customer story: a studio of three", status: "status-0", channel: "channel-0", date: day(14) }),
        row({ title: "Release notes 0.4", status: "status-3", channel: "channel-0", date: day(-3), owner: "Maya" }),
      ]);
      views.push([view("All posts", "table"), view("Board", "kanban", { group_by: "status" }), view("Calendar", "calendar", { date_field: "date" }), view("Gallery", "gallery")]);
    } else if (template === "calendar") {
      for (const f of [field("title", "Title", "text", 0), field("date", "Date", "date", 1), field("notes", "Notes", "text", 2)]) schema.set(f.id, f);
      views.push([view("Table", "table"), view("Calendar", "calendar", { date_field: "date" })]);
    } else if (template === "responses") {
      for (const f of [
        field("name", "Name", "text", 0),
        field("email", "Email", "text", 1),
        field("role", "Role", "select", 2, [
          ["Developer", "blue"],
          ["Designer", "purple"],
          ["Founder", "green"],
        ]),
        field("message", "What would you use it for?", "text", 3),
      ])
        schema.set(f.id, f);
      rows.push([
        row({ name: "Noor de Vries", email: "noor@example.com", role: "role-1", message: "Design reviews with agents in the loop" }),
        row({ name: "Daan Bakker", email: "daan@example.com", role: "role-0", message: "Running Claude Code overnight on our VPS" }),
      ]);
      views.push([view("Table", "table")]);
    } else {
      for (const f of [
        field("name", "Name", "text", 0),
        field("status", "Status", "select", 1, [
          ["To do", "gray"],
          ["Doing", "blue"],
          ["Done", "green"],
        ]),
        field("date", "Date", "date", 2),
      ])
        schema.set(f.id, f);
      rows.push([row({}), row({}), row({})]);
      views.push([view("Table", "table"), view("Board", "kanban", { group_by: "status" })]);
    }
  } else if (kind === "form") {
    y.getMap("form").set("description", template === "sample" ? "Tell us a little about yourself and we will send an invite when the beta opens." : "");
    const qs = y.getArray<Y.Map<unknown>>("questions");
    qs.push(formFields.filter((f) => f.type !== "person").map((f, i) => ymap({ field: f.id, label: f.name, required: template === "sample" && i < 2, help: "" })));
  }
}

function make(ws: string, kind: DocKind, title: string, template: string | null, opts: { by?: string; min?: number; parent?: string } = {}): Doc {
  const d: Doc = { id: uid(), workspace_id: ws, kind, title, icon: null, created_at: ago((opts.min ?? 0) + 60), updated_at: ago(opts.min ?? 0), created_by: opts.by ?? "Maya", parent_id: opts.parent ?? null };
  const y = new Y.Doc();
  const fields = opts.parent ? (Object.values(ydocs.get(opts.parent)?.getMap("schema").toJSON() ?? {}) as FieldSeed[]).sort((a, b) => a.order - b.order) : [];
  seed(y, kind, template, fields);
  ydocs.set(d.id, y);
  docs.push(d);
  return d;
}

function seedWorkspace(ws: string) {
  if (seeded.has(ws)) return;
  seeded.add(ws);
  make(ws, "doc", "Weekly sync", "sample", { min: 12 });
  make(ws, "sheet", "Launch budget", "sample", { min: 95, by: "Sanne" });
  make(ws, "slides", "Roadmap review", "sample", { min: 300 });
  make(ws, "database", "Content calendar", "content-calendar", { min: 60 * 26, by: "Sanne" });
  const db = make(ws, "database", "Beta signups", "responses", { min: 60 * 50 });
  make(ws, "form", "Beta signup", "sample", { min: 60 * 49, parent: db.id });
  make(ws, "doc", "Project brief: hub v2", "project-brief", { min: 60 * 72, by: "Daan" });
}

// A colleague who opens the weekly sync a moment after you do.
function visitor(id: string, ws: string) {
  const y = ydocs.get(id);
  if (!y) return;
  const peer = new Awareness(new Y.Doc());
  peer.setLocalStateField("user", { name: "Sanne", color: "hsl(145 62% 52%)" });
  window.setTimeout(() => notice(ws, "office-awareness", { id, by: "Sanne", state: { u: b64(encodeAwarenessUpdate(peer, [peer.clientID])), client: "mock-sanne" } }), 1200);
}

const find = (id: string) => {
  const d = docs.find((x) => x.id === id);
  if (!d) throw new Error("unknown document");
  return d;
};

function publicForm(form: Doc): PublicForm {
  const y = ydocs.get(form.id)!;
  const schema = (form.parent_id ? ydocs.get(form.parent_id)?.getMap("schema").toJSON() : {}) as Record<string, FieldSeed>;
  const questions = y
    .getArray<Y.Map<unknown>>("questions")
    .toArray()
    .map((m) => m.toJSON() as { field: string; label: string; required: boolean; help: string })
    .filter((q) => schema[q.field])
    .map((q) => {
      const f = schema[q.field];
      return { id: q.field, label: q.label || f.name, kind: f.type, required: q.required, help: q.help || null, options: (f.options ?? []).map((o) => o.name) };
    });
  return { id: form.id, title: form.title, description: String(y.getMap("form").get("description") ?? ""), questions };
}

export const handlers: Record<string, (p: Record<string, any>) => unknown> = {
  list_docs: ({ workspace_id }) => {
    seedWorkspace(workspace_id);
    return docs.filter((d) => d.workspace_id === workspace_id).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  },
  create_doc: ({ workspace_id, kind, title, template, parent_id }) => {
    let parent = parent_id as string | null;
    if (kind === "form" && !parent) parent = make(workspace_id, "database", `${title} responses`, "responses").id;
    const d = make(workspace_id, kind, title || "Untitled", template ?? null, { parent: parent ?? undefined });
    notice(workspace_id, "office-doc", d);
    return d;
  },
  rename_doc: ({ id, title }) => {
    const d = find(id);
    d.title = String(title).trim();
    d.updated_at = new Date().toISOString();
    notice(d.workspace_id, "office-doc", d);
    return d;
  },
  delete_doc: ({ id }) => {
    const d = find(id);
    docs.splice(docs.indexOf(d), 1);
    ydocs.delete(id);
    notice(d.workspace_id, "office-doc-deleted", { id });
    return null;
  },
  get_doc_state: ({ id }) => {
    const d = find(id);
    if (d.title === "Weekly sync") visitor(id, d.workspace_id);
    return b64(Y.encodeStateAsUpdate(ydocs.get(id)!));
  },
  doc_update: ({ id, update, client }) => {
    const d = find(id);
    Y.applyUpdate(ydocs.get(id)!, unb64(update));
    notice(d.workspace_id, "office-update", { id, update, by: "Maya", client: client ?? null });
    return null;
  },
  doc_awareness: ({ id, state }) => {
    const d = find(id);
    notice(d.workspace_id, "office-awareness", { id, state, by: "Maya" });
    return null;
  },
  get_form_public: ({ workspace_id, form_id }) => {
    const f = find(form_id);
    if (f.workspace_id !== workspace_id || f.kind !== "form") throw new Error("no such form");
    return publicForm(f);
  },
  form_submit: ({ workspace_id, form_id, answers }) => {
    const f = find(form_id);
    if (f.workspace_id !== workspace_id || !f.parent_id) throw new Error("no such form");
    const form = publicForm(f);
    const db = ydocs.get(f.parent_id)!;
    const schema = db.getMap("schema").toJSON() as Record<string, FieldSeed>;
    const row: Record<string, unknown> = { id: sid(), created: new Date().toISOString() };
    for (const q of form.questions) {
      const a = answers?.[q.id];
      const empty = a === undefined || a === null || a === "" || (Array.isArray(a) && !a.length);
      if (empty) {
        if (q.required) throw new Error(`${q.label} is required`);
        continue;
      }
      const opts = schema[q.id]?.options ?? [];
      if (q.kind === "select") row[q.id] = opts.find((o) => o.name === a)?.id ?? a;
      else if (q.kind === "multi_select") row[q.id] = (a as string[]).map((n) => opts.find((o) => o.name === n)?.id ?? n);
      else if (q.kind === "number") row[q.id] = Number(a);
      else row[q.id] = a;
    }
    const before = Y.encodeStateVector(db);
    db.getArray<Y.Map<unknown>>("rows").push([ymap(row)]);
    notice(workspace_id, "office-update", { id: f.parent_id, update: b64(Y.encodeStateAsUpdate(db, before)), by: f.title, client: null });
    return { row_id: row.id };
  },
};

export const app: Record<string, (p: Record<string, any>) => unknown> = {};
