import { Blocks, Globe, Search, Upload } from "lucide-react";
import type { ExtArea } from "../../ext/types";
import { useStore } from "../../store";
import { DropImport } from "./DropImport";
import { pickAndImport } from "./imports";
import { IntegrationsPage } from "./Integrations";
import { SearchPage } from "./SearchPage";

export { useSearch, openHit } from "./search";

export const area: ExtArea = {
  id: "knowledge",
  pages: [
    { id: "knowledge.search", place: "workspace", label: "knowledge.search.title", icon: Search, component: SearchPage, order: 4, flush: true },
    { id: "knowledge.integrations", place: "workspace", label: "knowledge.int.title", icon: Blocks, component: IntegrationsPage, order: 60 },
  ],
  commands: [
    { id: "knowledge.import", label: "knowledge.import.files", icon: Upload, run: () => void pickAndImport() },
    { id: "knowledge.clip", label: "knowledge.import.clip", icon: Globe, run: () => useStore.getState().go({ kind: "ext", id: "knowledge.search", sub: "clip" }) },
  ],
  overlays: [{ id: "knowledge.drop", component: DropImport }],
};
