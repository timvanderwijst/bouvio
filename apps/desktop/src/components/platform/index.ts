import { Archive, LayoutTemplate } from "lucide-react";
import type { ExtArea } from "../../ext/types";
import { BackupSettings, exportWorkspace } from "./Backup";
import { PlatformOverlay } from "./Overlay";
import { PluginsSettings } from "./PluginsSettings";
import { usePlatform } from "./state";
import { UpdatesSettings } from "./Updates";
import { WebAccount } from "./WebSignIn";
import { target } from "../../backend";
import "./platform.css";

export { TemplatePicker } from "./TemplatePicker";

const desktop = target !== "web";

export const area: ExtArea = {
  id: "platform",
  settings: desktop
    ? [
        { id: "platform.updates", component: UpdatesSettings },
        { id: "platform.backup", component: BackupSettings },
        { id: "platform.plugins", component: PluginsSettings },
      ]
    : [{ id: "platform.account", component: WebAccount }],
  commands: desktop
    ? [
        { id: "platform.export", label: "platform.backup.export", icon: Archive, run: () => void exportWorkspace() },
        { id: "platform.template", label: "platform.templates.new", icon: LayoutTemplate, run: () => usePlatform.setState({ dialog: "template" }) },
      ]
    : [],
  overlays: [{ id: "platform.overlay", component: PlatformOverlay }],
};
