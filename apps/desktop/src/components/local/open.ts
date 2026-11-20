import { useStore } from "../../store";

export const SECTION_ID = "local-models";

/** Go to Settings and bring the Local models section into view. */
export function openLocalSettings() {
  useStore.getState().go({ kind: "settings" });
  let tries = 0;
  const scroll = () => {
    const el = document.getElementById(SECTION_ID);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    else if (++tries < 20) requestAnimationFrame(scroll);
  };
  requestAnimationFrame(scroll);
}
