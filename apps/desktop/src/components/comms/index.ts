import { Headphones, Inbox, MessagesSquare } from "lucide-react";
import type { ExtArea } from "../../ext/types";
import { t } from "../../i18n";
import { useStore } from "../../store";
import { CommsBackground, NotificationSettings } from "./Background";
import { ChatPage } from "./ChatPage";
import { joinHuddle, leaveHuddle, useHuddle } from "./huddle";
import { HuddleBar } from "./HuddleBar";
import { useInboxBadge } from "./inbox";
import { InboxPage } from "./InboxPage";
import { useUnread } from "./state";
import "./comms.css";

export { HuddleSidebarRow } from "./HuddleBar";

function useChatBadge() {
  const ws = useStore((s) => s.workspaceId);
  return useUnread(ws) || undefined;
}

export const area: ExtArea = {
  id: "comms",
  pages: [
    { id: "comms.chat", place: "workspace", label: "comms.chat", icon: MessagesSquare, component: ChatPage, order: 7, flush: true, useBadge: useChatBadge },
    { id: "comms.inbox", place: "rail", label: "comms.inbox", icon: Inbox, component: InboxPage, useBadge: useInboxBadge },
  ],
  settings: [{ id: "comms.notifications", component: NotificationSettings }],
  overlays: [
    { id: "comms.background", component: CommsBackground },
    { id: "comms.huddle", component: HuddleBar },
  ],
  commands: [
    {
      id: "comms.huddle",
      label: "comms.huddle.toggle",
      icon: Headphones,
      run: () => {
        const s = useStore.getState();
        const ws = s.workspaces.find((w) => w.id === s.workspaceId);
        if (useHuddle.getState().status !== "idle") leaveHuddle();
        else if (ws?.kind === "shared") joinHuddle(ws.id);
        else s.notify(t("comms.huddle.notShared"));
      },
    },
  ],
};
