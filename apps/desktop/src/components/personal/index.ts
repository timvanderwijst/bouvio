import { CheckSquare, Coins, FlaskConical, ListPlus } from "lucide-react";
import type { ExtArea } from "../../ext/types";
import { useStore } from "../../store";
import { BriefBlock } from "./Brief";
import { CostsPage } from "./Costs";
import { EvalsPage } from "./Evals";
import { MyWorkPage } from "./MyWork";
import { ReplayPanel } from "./Replay";
import { TodayBlock } from "./Tasks";
import { useDueCount } from "./taskStore";
import "./personal.css";

export const area: ExtArea = {
  id: "personal",
  pages: [
    { id: "personal.work", place: "rail", label: "personal.work", icon: CheckSquare, component: MyWorkPage, useBadge: useDueCount },
    { id: "personal.costs", place: "workspace", label: "personal.costs", icon: Coins, order: 70, component: CostsPage },
    { id: "personal.evals", place: "workspace", label: "personal.evals", icon: FlaskConical, order: 75, component: EvalsPage },
  ],
  panels: [{ id: "personal.replay", label: "personal.replay", component: ReplayPanel }],
  home: [
    { id: "personal.brief", component: BriefBlock },
    { id: "personal.today", component: TodayBlock },
  ],
  commands: [{ id: "personal.addTask", label: "personal.cmd.addTask", icon: ListPlus, run: () => useStore.getState().go({ kind: "ext", id: "personal.work" }) }],
};
