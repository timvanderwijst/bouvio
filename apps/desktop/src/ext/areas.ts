import { area as comms } from "../components/comms";
import { area as dev } from "../components/dev";
import { area as knowledge } from "../components/knowledge";
import { area as local } from "../components/local";
import { area as office } from "../components/office";
import { area as personal } from "../components/personal";
import { area as platform } from "../components/platform";
import { useSyncExternalStore } from "react";
import type { ExtArea, ExtPage } from "./types";

// Order matters for Home blocks: the brief comes first.
const BUILT_IN: ExtArea[] = [personal, local, knowledge, office, comms, dev, platform];

/** Built-in areas plus whatever plugins registered at runtime. */
export let AREAS: ExtArea[] = [...BUILT_IN];
const subs = new Set<() => void>();
let version = 0;

/** Plugins register (or replace, by id) an area while the app runs. */
export function registerArea(area: ExtArea) {
  AREAS = [...AREAS.filter((a) => a.id !== area.id), area];
  version++;
  subs.forEach((f) => f());
}

export function unregisterArea(id: string) {
  if (BUILT_IN.some((a) => a.id === id)) return;
  AREAS = AREAS.filter((a) => a.id !== id);
  version++;
  subs.forEach((f) => f());
}

/** Re-render when plugins change what is registered. */
export function useExtVersion() {
  return useSyncExternalStore(
    (cb) => (subs.add(cb), () => void subs.delete(cb)),
    () => version,
  );
}

export const extPages = (place: ExtPage["place"]) =>
  AREAS.flatMap((a) => a.pages ?? [])
    .filter((p) => p.place === place && !p.hidden)
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100));

export const findPage = (id: string) => AREAS.flatMap((a) => a.pages ?? []).find((p) => p.id === id);
export const extPanels = () => AREAS.flatMap((a) => a.panels ?? []);
export const extHome = () => AREAS.flatMap((a) => a.home ?? []);
export const extSettings = () => AREAS.flatMap((a) => a.settings ?? []);
export const extCommands = () => AREAS.flatMap((a) => a.commands ?? []);
export const extOverlays = () => AREAS.flatMap((a) => a.overlays ?? []);
