import { Languages, Layers, MessageSquare, PenSquare, SunMoon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getLang, setLang, useT } from "../i18n";
import { useStore } from "../store";
import { PixelAvatar } from "./PixelAvatar";
import { extCommands, extPages } from "../ext/areas";

interface Cmd {
  id: string;
  label: string;
  hint?: string;
  icon: ReactNode;
  run(): void;
}

export function CommandPalette() {
  const t = useT();
  const open = useStore((s) => s.palette);
  const setPalette = useStore((s) => s.setPalette);
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const s = useStore();

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette(!useStore.getState().palette);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [setPalette]);

  useEffect(() => {
    if (open) {
      setQ("");
      setI(0);
      setTimeout(() => input.current?.focus(), 0);
    }
  }, [open]);

  const cmds = useMemo<Cmd[]>(() => {
    const close = () => setPalette(false);
    const ws = (id: string) => s.workspaces.find((w) => w.id === id)?.name ?? "";
    const list: Cmd[] = [
      { id: "new", label: t("ws.newThread"), icon: <PenSquare size={15} />, run: () => (s.go({ kind: "draft", captainId: null }), close()) },
      {
        id: "theme",
        label: t("palette.toggleTheme"),
        icon: <SunMoon size={15} />,
        run: () => (s.setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"), close()),
      },
      { id: "lang", label: t("palette.toggleLanguage"), icon: <Languages size={15} />, run: () => (setLang(getLang() === "en" ? "nl" : "en"), close()) },
      ...(["issues", "pullRequests", "automations", "studio", "files", "knowledge", "chat"] as const).map((page) => ({
        id: `p${page}`,
        label: t(page === "chat" ? "ws.general" : (`ws.${page}` as "ws.issues")),
        icon: <Layers size={15} />,
        run: () => (s.go({ kind: "page", page }), close()),
      })),
    ];
    for (const c of extCommands()) list.push({ id: `x${c.id}`, label: t(c.label), icon: <c.icon size={15} />, run: () => (c.run(), close()) });
    for (const p of [...extPages("workspace"), ...extPages("rail")])
      list.push({ id: `xp${p.id}`, label: t(p.label), icon: <p.icon size={15} />, run: () => (s.go({ kind: "ext", id: p.id }), close()) });
    for (const w of s.workspaces) list.push({ id: `w${w.id}`, label: w.name, hint: t("nav.workspaces"), icon: <Layers size={15} />, run: () => (s.selectWorkspace(w.id), close()) });
    for (const [wid, cs] of Object.entries(s.captains))
      for (const c of cs) list.push({ id: `c${c.id}`, label: c.name, hint: ws(wid), icon: <PixelAvatar seed={c.avatar_seed} size={15} />, run: () => (s.openCaptain(c), close()) });
    for (const th of Object.values(s.threads).flat().sort((a, b) => b.updated_at.localeCompare(a.updated_at)))
      list.push({ id: `t${th.id}`, label: th.title, hint: ws(th.workspace_id), icon: <MessageSquare size={15} />, run: () => (s.openThread(th.id), close()) });
    return list;
  }, [s, t, setPalette]);

  const found = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return cmds.slice(0, 12);
    return cmds.filter((c) => c.label.toLowerCase().includes(needle) || c.hint?.toLowerCase().includes(needle)).slice(0, 30);
  }, [q, cmds]);

  if (!open) return null;
  return (
    <div className="scrim top" onMouseDown={(e) => e.target === e.currentTarget && setPalette(false)}>
      <div className="palette" role="dialog" aria-modal>
        <input
          ref={input}
          className="palette-input"
          value={q}
          placeholder={t("palette.placeholder")}
          onChange={(e) => {
            setQ(e.target.value);
            setI(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") setPalette(false);
            if (e.key === "ArrowDown") (e.preventDefault(), setI((x) => Math.min(x + 1, found.length - 1)));
            if (e.key === "ArrowUp") (e.preventDefault(), setI((x) => Math.max(x - 1, 0)));
            if (e.key === "Enter") found[i]?.run();
          }}
        />
        <div className="palette-list">
          {found.map((c, j) => (
            <button key={c.id} className={`menu-item ${j === i ? "hot" : ""}`} onMouseEnter={() => setI(j)} onClick={c.run}>
              <span className="menu-icon">{c.icon}</span>
              <span className="menu-label truncate">{c.label}</span>
              {c.hint && <span className="menu-hint">{c.hint}</span>}
            </button>
          ))}
          {found.length === 0 && <div className="empty small">{t("palette.noResults")}</div>}
        </div>
      </div>
    </div>
  );
}
