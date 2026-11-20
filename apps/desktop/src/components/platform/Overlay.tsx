import { Menu as MenuIcon } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { target } from "../../backend";
import { webAuth } from "../../backend/web";
import { useT } from "../../i18n";
import { useStore } from "../../store";
import { syncPlugins } from "./plugins";
import { usePlatform } from "./state";
import { TemplateDialog } from "./TemplateDialog";
import { startUpdates } from "./updates";
import { WebSignIn } from "./WebSignIn";

/** Always mounted: starts update checks and plugins, hosts this area's dialogs and the web shell. */
export function PlatformOverlay() {
  const dialog = usePlatform((s) => s.dialog);

  useEffect(() => {
    startUpdates();
    if (target === "desktop") syncPlugins().catch(() => {});
  }, []);

  return (
    <>
      {dialog === "template" && <TemplateDialog />}
      {target === "web" && <WebShell />}
    </>
  );
}

/** The web client: sign-in until there is a session, then the phone menu. */
function WebShell() {
  const signedIn = useSyncExternalStore(webAuth.subscribe, webAuth.signedIn);
  return signedIn ? <PhoneNav /> : <WebSignIn />;
}

/** On a phone the sidebar and rail slide over the thread; this opens and closes them. */
function PhoneNav() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const view = useStore((s) => s.view);

  useEffect(() => setOpen(false), [view]);
  useEffect(() => {
    document.documentElement.classList.toggle("pf-nav", open);
    return () => document.documentElement.classList.remove("pf-nav");
  }, [open]);

  return (
    <>
      <button className="icon-btn pf-nav-btn" onClick={() => setOpen((o) => !o)} aria-label={t("platform.web.menu")} aria-expanded={open}>
        <MenuIcon size={17} />
      </button>
      {open && <div className="pf-nav-scrim" onClick={() => setOpen(false)} aria-hidden />}
    </>
  );
}
