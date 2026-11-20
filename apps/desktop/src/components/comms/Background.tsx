import { useEffect, useState } from "react";
import { useT } from "../../i18n";
import { useStore } from "../../store";
import { ensurePermission, setNotifyPref, startInbox, useNotifyPrefs, type NotifyPrefs } from "./inbox";
import { loadHuddle, startComms } from "./state";

/** Always mounted: hub listeners for chat, huddles, the inbox and notifications. */
export function CommsBackground() {
  const workspaceId = useStore((s) => s.workspaceId);
  const shared = useStore((s) => s.workspaces.find((w) => w.id === s.workspaceId)?.kind === "shared");
  const connected = useStore((s) => s.hub.connected && !!s.hub.user);
  useEffect(() => {
    startComms();
    startInbox();
  }, []);
  // Know whether a huddle is going on in the workspace on screen.
  useEffect(() => {
    if (workspaceId && shared && connected) loadHuddle(workspaceId).catch(() => {});
  }, [workspaceId, shared, connected]);
  return null;
}

const KEYS: (keyof NotifyPrefs)[] = ["approvals", "mentions", "longRuns", "huddles"];

export function NotificationSettings() {
  const t = useT();
  const prefs = useNotifyPrefs();
  const [allowed, setAllowed] = useState<boolean | null>(null);
  useEffect(() => {
    if (typeof Notification !== "undefined" && Notification.permission !== "default") setAllowed(Notification.permission === "granted");
  }, []);
  return (
    <section className="set-group">
      <h2>{t("comms.notify.title")}</h2>
      {KEYS.map((k) => (
        <label key={k} className="set-row cm-set">
          <span>
            {t(`comms.notify.${k}`)}
            <span className="cm-set-hint">{t(`comms.notify.${k}Hint`)}</span>
          </span>
          <input type="checkbox" className="cm-switch" checked={prefs[k]} onChange={(e) => setNotifyPref({ [k]: e.target.checked })} />
        </label>
      ))}
      <div className="set-row">
        <span className="cm-set-hint">{allowed === false ? t("comms.notify.denied") : t("comms.notify.whenAway")}</span>
        {allowed !== true && (
          <button className="btn small" onClick={async () => setAllowed(await ensurePermission())}>
            {t("comms.notify.allow")}
          </button>
        )}
      </div>
    </section>
  );
}
