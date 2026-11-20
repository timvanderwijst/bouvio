import { Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { backend } from "../../backend";
import { useT } from "../../i18n";
import { useWorkspace } from "../../store";
import { importFiles, importPaths } from "./imports";
import "./knowledge.css";

const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes("Files");

/** Drop files anywhere on the window to import them into the current workspace. */
export function DropImport() {
  const t = useT();
  const ws = useWorkspace();
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const active = !!ws;

  // Browser drops (the preview, or a webview without native drag and drop).
  useEffect(() => {
    if (!active) return;
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current++;
      setOver(true);
    };
    const overFn = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setOver(false);
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current = 0;
      setOver(false);
      // Something inside (an editor, the composer) already took it.
      if (e.defaultPrevented) return;
      e.preventDefault();
      const files = [...(e.dataTransfer?.files ?? [])];
      if (files.length) importFiles(files);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", overFn);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", overFn);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, [active]);

  // In the app, the native layer reports drops with real paths.
  useEffect(() => {
    if (!active || !backend.live) return;
    let un: (() => void) | null = null;
    let dead = false;
    import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) =>
        getCurrentWebview().onDragDropEvent((ev) => {
          const p = ev.payload;
          if (p.type === "enter") setOver(p.paths.length > 0);
          else if (p.type === "leave") setOver(false);
          else if (p.type === "drop") {
            setOver(false);
            if (p.paths.length) importPaths(p.paths);
          }
        }),
      )
      .then((u) => (dead ? u() : (un = u)))
      .catch(() => {});
    return () => {
      dead = true;
      un?.();
    };
  }, [active]);

  useEffect(() => {
    if (!over) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOver(false);
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [over]);

  if (!over || !ws) return null;
  return (
    <div className="kn-drop" aria-live="polite">
      <div className="kn-drop-card">
        <Upload size={22} />
        <div className="kn-drop-title">{t("knowledge.drop.title")}</div>
        <div className="kn-drop-text">{t("knowledge.drop.text", { workspace: ws.name })}</div>
      </div>
    </div>
  );
}
