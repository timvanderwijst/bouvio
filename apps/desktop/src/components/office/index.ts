import { CalendarDays, Database, FileSpreadsheet, FileText } from "lucide-react";
import type { ExtArea } from "../../ext/types";
import { CalendarPage } from "./CalendarPage";
import { createDoc } from "./common";
import { DocPage } from "./DocPage";
import { DocsPage } from "./DocsPage";

export const area: ExtArea = {
  id: "office",
  pages: [
    { id: "office.docs", place: "workspace", label: "office.docs", icon: FileText, component: DocsPage, order: 3 },
    { id: "office.doc", place: "workspace", label: "office.docs", icon: FileText, component: DocPage, hidden: true, flush: true },
    { id: "office.calendar", place: "workspace", label: "office.calendar", icon: CalendarDays, component: CalendarPage, order: 6, flush: true },
  ],
  commands: [
    { id: "office.newDoc", label: "office.cmd.newDoc", icon: FileText, run: () => void createDoc("doc") },
    { id: "office.newSheet", label: "office.cmd.newSheet", icon: FileSpreadsheet, run: () => void createDoc("sheet") },
    { id: "office.newDatabase", label: "office.cmd.newDatabase", icon: Database, run: () => void createDoc("database") },
  ],
};
