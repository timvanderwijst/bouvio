// Runtime plugins: each enabled folder in ~/.bouvio/plugins is loaded as an ES
// module from a blob URL and gets a small API to add pages, panels, settings,
// palette commands and overlays. See docs/plugins.md.

import * as React from "react";
import {
  Bell,
  BookOpen,
  Bot,
  Calendar,
  ChartLine,
  Check,
  Clock,
  Code,
  FileText,
  Folder,
  Globe,
  Heart,
  Image,
  LayoutGrid,
  List,
  MessageSquare,
  Puzzle,
  Search,
  Settings,
  Smile,
  Sparkles,
  Star,
  Terminal,
  Zap,
} from "lucide-react";
import { backend, target } from "../../backend";
import type { ExtArea } from "../../ext/types";
import { t } from "../../i18n";
import type { PluginInfo } from "../../protocol/PluginInfo";
import { rpc, useStore } from "../../store";
import { Dialog } from "../Dialog";
import { Menu } from "../Menu";

/** What `activate(api)` receives. Keep in step with docs/plugins.md. */
export interface PluginApi {
  /** The app's own React; plugins must not bundle another. */
  React: typeof React;
  plugin: { id: string; name: string; version: string; path: string };
  /** Add (or replace) this plugin's area. Ids inside are namespaced for you. */
  registerArea(area: Omit<ExtArea, "id"> & { id?: string }): void;
  /** A runner method in the current workspace; needs the `rpc` permission. */
  rpc<T = unknown>(method: string, params?: Record<string, unknown>, workspaceId?: string | null): Promise<T>;
  workspaceId(): string | null;
  /** Open one of this plugin's pages by the id it registered. */
  navigate(pageId: string, sub?: string): void;
  t: typeof t;
  ui: { Menu: typeof Menu; Dialog: typeof Dialog };
  icons: Record<string, unknown>;
  toast(message: string): void;
}

interface Loaded {
  info: PluginInfo;
  module: { activate?: (api: PluginApi) => unknown; deactivate?: () => unknown };
  url: string;
  areaId: string;
}

const ICONS = { Bell, BookOpen, Bot, Calendar, ChartLine, Check, Clock, Code, FileText, Folder, Globe, Heart, Image, LayoutGrid, List, MessageSquare, Puzzle, Search, Settings, Smile, Sparkles, Star, Terminal, Zap };

const loaded = new Map<string, Loaded>();
/** Why a plugin failed to load, by id, for the Settings list. */
export const loadErrors = new Map<string, string>();

const ns = (pluginId: string, id: string) => `plugin.${pluginId}.${id}`;

// The area registry is imported lazily: it imports this area, so a static
// import here would be a cycle that breaks when this file loads first.
type Registry = typeof import("../../ext/areas");
const registry = (): Promise<Registry> => import("../../ext/areas");

function apiFor(info: PluginInfo, reg: Registry): PluginApi {
  const m = info.manifest;
  const areaId = `plugin:${m.id}`;
  return {
    React,
    plugin: { id: m.id, name: m.name, version: m.version, path: info.path },
    registerArea(area) {
      reg.registerArea({
        ...area,
        id: areaId,
        pages: area.pages?.map((p) => ({ ...p, id: ns(m.id, p.id) })),
        panels: area.panels?.map((p) => ({ ...p, id: ns(m.id, p.id) })),
        home: area.home?.map((b) => ({ ...b, id: ns(m.id, b.id) })),
        settings: area.settings?.map((b) => ({ ...b, id: ns(m.id, b.id) })),
        commands: area.commands?.map((c) => ({ ...c, id: ns(m.id, c.id) })),
        overlays: area.overlays?.map((b) => ({ ...b, id: ns(m.id, b.id) })),
      });
    },
    rpc(method, params = {}, workspaceId) {
      if (!m.permissions.includes("rpc")) return Promise.reject(new Error(`${m.name} has no rpc permission`));
      return workspaceId === undefined ? rpc(method, params) : rpc(method, params, workspaceId);
    },
    workspaceId: () => useStore.getState().workspaceId,
    navigate: (pageId, sub) => useStore.getState().go({ kind: "ext", id: ns(m.id, pageId), sub }),
    t,
    ui: { Menu, Dialog },
    icons: ICONS,
    toast: (message) => useStore.getState().notify(String(message)),
  };
}

async function load(info: PluginInfo) {
  const id = info.manifest.id;
  loadErrors.delete(id);
  try {
    const source = await backend.app<string>("plugin_source", { id });
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    const module = await import(/* @vite-ignore */ url).catch((e) => {
      URL.revokeObjectURL(url);
      throw e;
    });
    loaded.set(id, { info, module, url, areaId: `plugin:${id}` });
    await module.activate?.(apiFor(info, await registry()));
  } catch (e) {
    loadErrors.set(id, String(e).replace(/^Error: /, ""));
    await unload(id);
  }
}

async function unload(id: string) {
  const l = loaded.get(id);
  if (!l) return;
  loaded.delete(id);
  try {
    l.module.deactivate?.();
  } catch (e) {
    console.warn(`plugin ${id}:`, e);
  }
  (await registry()).unregisterArea(l.areaId);
  URL.revokeObjectURL(l.url);
}

let queue: Promise<unknown> = Promise.resolve();

/** Bring loaded plugins in line with what is enabled on disk. Returns the list. Calls run one at a time. */
export function syncPlugins(reload = false): Promise<PluginInfo[]> {
  const run = queue.then(() => sync(reload));
  queue = run.catch(() => {});
  return run;
}

async function sync(reload: boolean): Promise<PluginInfo[]> {
  if (target !== "desktop") return target === "preview" ? backend.app<PluginInfo[]>("plugins_list").catch(() => []) : [];
  const list = await backend.app<PluginInfo[]>("plugins_list").catch(() => [] as PluginInfo[]);
  const want = new Map(list.filter((p) => p.enabled && !p.error).map((p) => [p.manifest.id, p]));
  for (const id of [...loaded.keys()]) {
    const l = loaded.get(id)!;
    const next = want.get(id);
    if (!next || reload || next.manifest.version !== l.info.manifest.version) await unload(id);
  }
  for (const [id, info] of want) if (!loaded.has(id)) await load(info);
  return list;
}

export const isLoaded = (id: string) => loaded.has(id);
