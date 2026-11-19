import { Check, ChevronDown } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

export interface MenuItem<T> {
  value: T;
  label: string;
  hint?: string;
  icon?: ReactNode;
  disabled?: boolean;
}

/** A compact dropdown: a quiet trigger, a floating list, a check on the current one. */
export function Menu<T extends string | null>({
  value,
  items,
  onChange,
  icon,
  label,
  up = false,
  disabled = false,
  title,
}: {
  value: T;
  items: MenuItem<T>[];
  onChange: (v: T) => void;
  icon?: ReactNode;
  label?: string;
  up?: boolean;
  disabled?: boolean;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = items.find((i) => i.value === value);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  return (
    <div className="menu" ref={ref}>
      <button type="button" className="menu-trigger" disabled={disabled} onClick={() => setOpen((o) => !o)} title={title} aria-expanded={open}>
        {icon ?? current?.icon}
        <span>{label ?? current?.label}</span>
        {!disabled && <ChevronDown size={13} className="menu-chev" />}
      </button>
      {open && (
        <div className={`menu-list ${up ? "up" : ""}`} role="listbox">
          {items.map((it) => (
            <button
              type="button"
              key={String(it.value)}
              role="option"
              aria-selected={it.value === value}
              className="menu-item"
              disabled={it.disabled}
              onClick={() => {
                onChange(it.value);
                setOpen(false);
              }}
            >
              <span className="menu-icon">{it.icon}</span>
              <span className="menu-label">{it.label}</span>
              {it.hint && <span className="menu-hint">{it.hint}</span>}
              <span className="menu-check">{it.value === value && <Check size={14} />}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
