import { AppWindow, BookOpen, ChartLine, LayoutTemplate, Megaphone, Sparkles, Square, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useT } from "../../i18n";
import type { WorkspaceTemplate } from "../../protocol/WorkspaceTemplate";
import { rpc } from "../../store";

const ICONS: Record<string, LucideIcon> = {
  "app-window": AppWindow,
  megaphone: Megaphone,
  "chart-line": ChartLine,
  "book-open": BookOpen,
  sparkles: Sparkles,
};
export const templateIcon = (name: string): LucideIcon => ICONS[name] ?? LayoutTemplate;

let cache: WorkspaceTemplate[] | null = null;

/** The built-in templates, loaded once from the runner. */
export function useTemplates() {
  const [list, setList] = useState<WorkspaceTemplate[] | null>(cache);
  useEffect(() => {
    if (cache) return;
    rpc<WorkspaceTemplate[]>("list_templates", {}, null)
      .then((l) => setList((cache = l)))
      .catch(() => setList([]));
  }, []);
  return list;
}

/**
 * Cards to choose a workspace template: arrow keys move, the choice follows
 * focus like a radio group. `null` is the blank workspace.
 */
export function TemplatePicker({
  value,
  onChange,
  blank = true,
  templates,
}: {
  value: string | null;
  onChange: (id: string | null, template: WorkspaceTemplate | null) => void;
  /** Offer "Blank" as the first card. */
  blank?: boolean;
  templates?: WorkspaceTemplate[];
}) {
  const t = useT();
  const loaded = useTemplates();
  const list = templates ?? loaded ?? [];
  const items: (WorkspaceTemplate | null)[] = blank ? [null, ...list] : list;
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const current = Math.max(
    0,
    items.findIndex((x) => (x?.id ?? null) === value),
  );

  const key = (e: KeyboardEvent, i: number) => {
    const cols = 2;
    const step = { ArrowRight: 1, ArrowDown: cols, ArrowLeft: -1, ArrowUp: -cols, Home: -i, End: items.length - 1 - i }[e.key];
    if (step === undefined) return;
    e.preventDefault();
    const j = Math.min(items.length - 1, Math.max(0, i + step));
    onChange(items[j]?.id ?? null, items[j]);
    refs.current[j]?.focus();
  };

  if (!blank && loaded !== null && list.length === 0) return <p className="page-note">{t("platform.templates.none")}</p>;

  return (
    <div className="pf-templates" role="radiogroup" aria-label={t("platform.templates.pick")}>
      {items.map((tpl, i) => {
        const Icon = tpl ? templateIcon(tpl.icon) : Square;
        const on = i === current;
        return (
          <button
            type="button"
            key={tpl?.id ?? "blank"}
            ref={(el) => {
              refs.current[i] = el;
            }}
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            className={`pf-template ${on ? "on" : ""}`}
            onClick={() => onChange(tpl?.id ?? null, tpl)}
            onKeyDown={(e) => key(e, i)}
          >
            <span className="pf-template-icon">
              <Icon size={16} />
            </span>
            <span className="pf-template-text">
              <span className="pf-template-name">
                {tpl ? tpl.name : t("platform.templates.blank")}
                {tpl && tpl.leads.length > 0 && <span className="pf-template-meta">{t("platform.templates.leads", { count: tpl.leads.length })}</span>}
              </span>
              <span className="pf-template-desc">{tpl ? tpl.description : t("platform.templates.blankHint")}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
