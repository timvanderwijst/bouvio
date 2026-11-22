import { useEffect, useRef, useState } from "react";
import { AREAS } from "../../ext/areas";
import type { Artifact } from "../../protocol/Artifact";
import type { SearchHit } from "../../protocol/SearchHit";
import { rpc, useStore } from "../../store";

export interface SearchOpts {
  /** Limit to these kinds: `thread`, `issue`, `file`, `artifact`, `doc`, … */
  kinds?: string[];
  limit?: number;
  /** Every local workspace instead of the current one. */
  all?: boolean;
  /** Debounce in ms (default 120). */
  delay?: number;
}

export interface SearchState {
  results: SearchHit[];
  loading: boolean;
  error: string | null;
  /** The query the results belong to. */
  query: string;
}

/** Live search over everything the runner indexed; debounced, newest answer wins. */
export function useSearch(query: string, opts: SearchOpts = {}): SearchState {
  const workspaceId = useStore((s) => s.workspaceId);
  const remote = useStore((s) => !!s.workspaces.find((w) => w.id === s.workspaceId)?.role);
  const [state, setState] = useState<SearchState>({ results: [], loading: false, error: null, query: "" });
  const seq = useRef(0);
  const kinds = (opts.kinds ?? []).join(",");
  const all = !!opts.all && !remote;
  const limit = opts.limit ?? 40;
  const delay = opts.delay ?? 120;

  useEffect(() => {
    const q = query.trim();
    const my = ++seq.current;
    if (!q || (!workspaceId && !all)) {
      setState({ results: [], loading: false, error: null, query: q });
      return;
    }
    setState((s) => ({ ...s, loading: true }));
    const timer = window.setTimeout(async () => {
      try {
        const params: Record<string, unknown> = { query: q, limit, kinds: kinds ? kinds.split(",") : [] };
        if (!all) params.workspace_id = workspaceId;
        const results = await rpc<SearchHit[]>("search", params, all ? null : workspaceId);
        if (my === seq.current) setState({ results, loading: false, error: null, query: q });
      } catch (e) {
        if (my === seq.current) setState({ results: [], loading: false, error: String(e), query: q });
      }
    }, delay);
    return () => window.clearTimeout(timer);
  }, [query, workspaceId, kinds, all, limit, delay]);

  return state;
}

/** Kinds in the order results are grouped. */
export const KIND_ORDER = ["thread", "issue", "doc", "note", "sheet", "artifact", "file"];

export function kindLabel(kind: string) {
  return KIND_ORDER.includes(kind) ? `knowledge.kind.${kind}` : "knowledge.kind.other";
}

/** Group results by kind, keeping the best result's group first within known kinds. */
export function groupHits(hits: SearchHit[]): { kind: string; hits: SearchHit[] }[] {
  const map = new Map<string, SearchHit[]>();
  for (const h of hits) {
    const k = h.kind;
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(h);
  }
  const rank = (k: string) => (KIND_ORDER.indexOf(k) === -1 ? 99 : KIND_ORDER.indexOf(k));
  return [...map.entries()].sort((a, b) => rank(a[0]) - rank(b[0])).map(([kind, hits]) => ({ kind, hits }));
}

/** Open a result where it lives. Artifacts open in the thread panel preview. */
export async function openHit(hit: SearchHit) {
  const s = useStore.getState();
  if (s.workspaceId !== hit.workspace_id) await s.selectWorkspace(hit.workspace_id);
  const go = useStore.getState().go;
  const loc = hit.location;
  switch (loc.type) {
    case "thread":
      await useStore.getState().openThread(loc.thread_id);
      break;
    case "issue":
      go({ kind: "page", page: "issues", sub: loc.issue_id });
      break;
    case "file":
      go({ kind: "page", page: "files", sub: loc.path });
      break;
    case "artifact": {
      const a = await findArtifact(hit.workspace_id, loc.artifact_id);
      if (!a) return;
      const st = useStore.getState();
      st.openArtifact(a);
      if (st.view.kind !== "thread" && st.view.kind !== "draft") go({ kind: "draft", leadId: null });
      break;
    }
    case "doc":
      go({ kind: "ext", id: docPage(loc.kind), sub: loc.id });
      break;
  }
}

async function findArtifact(ws: string, id: string): Promise<Artifact | undefined> {
  const cached = useStore.getState().data[ws]?.artifacts?.find((a) => a.id === id);
  if (cached) return cached;
  const list = await rpc<Artifact[]>("list_artifacts", { workspace_id: ws }, ws).catch(() => []);
  return list.find((a) => a.id === id);
}

/** The page another area registered for a kind of doc (`office.sheet`), else the doc editor. */
function docPage(kind: string) {
  const pages = AREAS.flatMap((a) => a.pages ?? []);
  return pages.find((p) => p.id.endsWith(`.${kind}`))?.id ?? "office.doc";
}

/** Split a snippet into plain and marked parts. */
export function snippetParts(text: string, ranges: [number, number][]) {
  const out: { text: string; mark: boolean }[] = [];
  let at = 0;
  for (const [a, b] of ranges) {
    if (a > at) out.push({ text: text.slice(at, a), mark: false });
    out.push({ text: text.slice(a, b), mark: true });
    at = b;
  }
  if (at < text.length) out.push({ text: text.slice(at), mark: false });
  return out;
}
