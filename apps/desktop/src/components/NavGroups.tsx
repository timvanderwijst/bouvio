import { BarChart3, BookOpen, CircleDashed, Code2, Inbox, MessagesSquare, Palette, Users, type LucideIcon } from "lucide-react";
import { useT } from "../i18n";
import { useStore, useWsData, type View } from "../store";
import { findPage, useExtVersion } from "../ext/areas";

/**
 * The app keeps its navigation short by bundling related pages into groups.
 * A group is one row in the sidebar or rail; inside it, tabs switch between its pages.
 */
export interface NavMember {
  key: string;
  view: View;
  /** i18n key */
  label: string;
  /** Views that count as "inside" this member, such as one open doc under Docs. */
  owns?: (v: View) => boolean;
  /** Pages from an area (ext) only show when that area registered them. */
  ext?: string;
}

export interface NavGroup {
  id: string;
  /** i18n key */
  label: string;
  icon: LucideIcon;
  place: "workspace" | "rail";
  members: NavMember[];
  /** Extra count shown on the group's row, next to its pages' own badges. */
  useCount?: () => number | undefined;
}

const ext = (id: string, label: string, owns?: (v: View) => boolean): NavMember => ({ key: id, view: { kind: "ext", id }, label, ext: id, owns });
const page = (p: Extract<View, { kind: "page" }>["page"], label: string, owns?: (v: View) => boolean): NavMember => ({
  key: p,
  view: { kind: "page", page: p },
  label,
  owns,
});

const useOpenIssues = () => {
  const data = useWsData();
  const n = (data.issues ?? []).filter((i) => i.status === "todo" || i.status === "in_progress").length;
  return n || undefined;
};

export const NAV_GROUPS: NavGroup[] = [
  { id: "inbox", label: "nav.inbox", icon: Inbox, place: "rail", members: [ext("comms.inbox", "comms.inbox"), ext("personal.work", "personal.work")] },
  {
    id: "team",
    label: "nav.team",
    icon: Users,
    place: "rail",
    members: [
      { key: "people", view: { kind: "rail", page: "people" }, label: "nav.people" },
      { key: "runners", view: { kind: "rail", page: "runners" }, label: "nav.runners" },
    ],
  },
  { id: "chat", label: "comms.chat", icon: MessagesSquare, place: "workspace", members: [ext("comms.chat", "comms.chat")] },
  {
    id: "planning",
    label: "ws.planning",
    icon: CircleDashed,
    place: "workspace",
    useCount: useOpenIssues,
    members: [page("issues", "ws.issues"), page("pullRequests", "ws.pullRequests"), ext("office.calendar", "office.calendar")],
  },
  {
    id: "library",
    label: "ws.library",
    icon: BookOpen,
    place: "workspace",
    members: [
      ext("office.docs", "office.docs", (v) => v.kind === "ext" && v.id === "office.doc"),
      page("files", "ws.files"),
      page("knowledge", "ws.knowledge"),
      ext("knowledge.search", "knowledge.search.title"),
    ],
  },
  { id: "studio", label: "ws.studio", icon: Palette, place: "workspace", members: [page("studio", "ws.studio", (v) => v.kind === "board")] },
  {
    id: "build",
    label: "ws.build",
    icon: Code2,
    place: "workspace",
    members: [ext("dev", "dev.page"), page("automations", "ws.automations"), ext("knowledge.integrations", "knowledge.int.title")],
  },
  { id: "insights", label: "ws.insights", icon: BarChart3, place: "workspace", members: [ext("personal.costs", "personal.costs"), ext("personal.evals", "personal.evals")] },
];

const same = (a: View, b: View) => JSON.stringify(a) === JSON.stringify(b);
const bare = (v: View): View => {
  if (v.kind === "page") return { kind: "page", page: v.page };
  if (v.kind === "ext") return { kind: "ext", id: v.id };
  return v;
};

/** Members whose page exists right now (an area can be missing in a slim build). */
export const liveMembers = (g: NavGroup) => g.members.filter((m) => !m.ext || findPage(m.ext));

/** The member that is open exactly (tabs show for these), or that owns the view. */
export function memberOf(v: View): { group: NavGroup; member: NavMember; exact: boolean } | null {
  for (const group of NAV_GROUPS) {
    for (const member of liveMembers(group)) {
      if (same(bare(v), member.view)) return { group, member, exact: true };
      if (member.owns?.(v)) return { group, member, exact: false };
    }
  }
  return null;
}

/** Pages that belong to a group never get a row of their own. */
export const groupedIds = new Set(NAV_GROUPS.flatMap((g) => g.members.map((m) => m.ext).filter(Boolean) as string[]));

// Each group reopens the tab you used last.
const last: Record<string, View> = {};
useStore.subscribe((s) => {
  const hit = memberOf(s.view);
  if (hit?.exact) last[hit.group.id] = s.view;
});

export function openGroup(g: NavGroup) {
  const members = liveMembers(g);
  const remembered = last[g.id];
  const target = remembered && members.some((m) => same(bare(remembered), m.view)) ? remembered : members[0]?.view;
  if (target) useStore.getState().go(target);
}

export const groupActive = (g: NavGroup, v: View) => memberOf(v)?.group.id === g.id;

/** Sum of the badges of a group's pages, plus its own count. Keyed by its members so hook order stays fixed. */
export function useGroupBadge(g: NavGroup): number | undefined {
  useExtVersion();
  const hooks = liveMembers(g)
    .map((m) => (m.ext ? findPage(m.ext)?.useBadge : undefined))
    .filter(Boolean) as (() => number | undefined)[];
  if (g.useCount) hooks.push(g.useCount);
  // The list is fixed for a given set of registered areas; GroupRow remounts when it changes.
  const n = hooks.reduce((sum, use) => sum + (use() ?? 0), 0);
  return n || undefined;
}

export const groupKey = (g: NavGroup) => `${g.id}:${liveMembers(g).map((m) => m.key).join(",")}`;

/** Tabs at the top of a page that is part of a group with more than one page. */
export function GroupTabs() {
  const t = useT();
  const view = useStore((s) => s.view);
  const go = useStore((s) => s.go);
  useExtVersion();
  const hit = memberOf(view);
  if (!hit || !hit.exact) return null;
  const members = liveMembers(hit.group);
  if (members.length < 2) return null;
  return (
    <nav className="group-tabs" aria-label={t(hit.group.label)}>
      {members.map((m) => (
        <button key={m.key} className={`group-tab ${m.key === hit.member.key ? "on" : ""}`} aria-current={m.key === hit.member.key ? "page" : undefined} onClick={() => go(m.view)}>
          {t(m.label)}
        </button>
      ))}
    </nav>
  );
}
