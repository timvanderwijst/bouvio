import { area as comms } from "../components/comms";
import { area as dev } from "../components/dev";
import { area as knowledge } from "../components/knowledge";
import { area as local } from "../components/local";
import { area as office } from "../components/office";
import { area as personal } from "../components/personal";
import { area as platform } from "../components/platform";
import type { ExtArea, ExtPage } from "./types";

export const AREAS: ExtArea[] = [local, knowledge, office, comms, dev, platform, personal];

export const extPages = (place: ExtPage["place"]) =>
  AREAS.flatMap((a) => a.pages ?? [])
    .filter((p) => p.place === place)
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100));

export const findPage = (id: string) => AREAS.flatMap((a) => a.pages ?? []).find((p) => p.id === id);
export const extPanels = () => AREAS.flatMap((a) => a.panels ?? []);
export const extHome = () => AREAS.flatMap((a) => a.home ?? []);
export const extSettings = () => AREAS.flatMap((a) => a.settings ?? []);
export const extCommands = () => AREAS.flatMap((a) => a.commands ?? []);
export const extOverlays = () => AREAS.flatMap((a) => a.overlays ?? []);
