import { Cpu } from "lucide-react";
import type { ExtArea } from "../../ext/types";
import { LocalHome } from "./LocalHome";
import { LocalSettings } from "./LocalSettings";
import { openLocalSettings } from "./open";

export { toWav16k } from "./audio";

export const area: ExtArea = {
  id: "local",
  settings: [{ id: "local-models", component: LocalSettings }],
  home: [{ id: "local-start", component: LocalHome }],
  commands: [{ id: "local-models", label: "local.command", icon: Cpu, run: openLocalSettings }],
};
