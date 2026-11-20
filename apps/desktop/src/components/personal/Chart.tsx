import { useLayoutEffect, useRef, useState } from "react";
import { getLang, useT } from "../../i18n";
import type { CostDay } from "../../protocol/CostDay";
import { cost } from "../../lib/format";

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/** The smallest 1/2/2.5/5 × 10ⁿ at or above `v`, so ticks land on round numbers. */
export function niceMax(v: number): number {
  if (v <= 0) return 1;
  const e = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * e >= v - 1e-12) return m * e;
  return 10 * e;
}

const parse = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
};

/** Cost per day: one hue, neutral axes, a tooltip on hover or arrow keys. */
export function DailyBars({ days }: { days: CostDay[] }) {
  const t = useT();
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const W = Math.max(width, 280);
  const H = 190;
  const pad = { l: 46, r: 6, t: 12, b: 26 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const max = niceMax(Math.max(0, ...days.map((d) => d.cost_usd)));
  const step = iw / Math.max(1, days.length);
  const bar = Math.max(1.5, Math.min(28, step * 0.68));
  const y = (v: number) => pad.t + ih - (v / max) * ih;
  const ticks = [0, max / 2, max];
  const every = days.length <= 7 ? 1 : days.length <= 31 ? 5 : 15;
  const short = new Intl.DateTimeFormat(getLang(), days.length <= 7 ? { weekday: "short" } : { day: "numeric", month: "short" });
  const long = new Intl.DateTimeFormat(getLang(), { weekday: "short", day: "numeric", month: "short" });
  const total = days.reduce((a, d) => a + d.cost_usd, 0);
  const h = hover !== null ? days[hover] : null;

  const pick = (clientX: number, rect: DOMRect) => {
    const i = Math.floor((clientX - rect.left - pad.l) / step);
    setHover(i >= 0 && i < days.length ? i : null);
  };

  return (
    <div className="p-chart" ref={ref}>
      <svg
        width={W}
        height={H}
        role="img"
        tabIndex={0}
        aria-label={t("personal.costs.chartLabel", { days: days.length, total: cost(total) })}
        onMouseMove={(e) => pick(e.clientX, e.currentTarget.getBoundingClientRect())}
        onMouseLeave={() => setHover(null)}
        onBlur={() => setHover(null)}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight") setHover((v) => Math.min(days.length - 1, (v ?? -1) + 1));
          else if (e.key === "ArrowLeft") setHover((v) => Math.max(0, (v ?? days.length) - 1));
          else return;
          e.preventDefault();
        }}
      >
        {ticks.map((v) => (
          <g key={v}>
            <line className={v === 0 ? "p-axis" : "p-grid"} x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} />
            <text className="p-tick" x={pad.l - 8} y={y(v)} dy="0.32em" textAnchor="end">
              {cost(v)}
            </text>
          </g>
        ))}
        {days.map((d, i) => {
          const x = pad.l + i * step + (step - bar) / 2;
          const bh = d.cost_usd > 0 ? Math.max(2, ih - (y(d.cost_usd) - pad.t)) : 0;
          return (
            <g key={d.date}>
              {bh > 0 && <rect className={`p-bar ${hover !== null && hover !== i ? "dim" : ""}`} x={x} y={pad.t + ih - bh} width={bar} height={bh} rx={Math.min(3, bar / 2)} />}
              {(i % every === 0 || days.length <= 7) && (
                <text className="p-tick" x={pad.l + i * step + step / 2} y={H - 8} textAnchor="middle">
                  {short.format(parse(d.date))}
                </text>
              )}
            </g>
          );
        })}
        {hover !== null && <line className="p-cursor" x1={pad.l + hover * step + step / 2} x2={pad.l + hover * step + step / 2} y1={pad.t} y2={pad.t + ih} />}
      </svg>
      {h && hover !== null && (
        <div className="p-tip" style={{ left: Math.min(W - 150, Math.max(0, pad.l + hover * step + step / 2 - 70)) }} role="status">
          <span className="p-tip-date">{long.format(parse(h.date))}</span>
          <span className="p-tip-val num">{cost(h.cost_usd)}</span>
          <span className="p-tip-sub">{t("personal.costs.turns", { count: h.turns })}</span>
        </div>
      )}
    </div>
  );
}

/** A small inline bar for breakdown tables. */
export function InlineBar({ value, max }: { value: number; max: number }) {
  return (
    <span className="p-ibar" aria-hidden>
      <i style={{ width: `${max > 0 ? Math.max(value > 0 ? 2 : 0, (value / max) * 100) : 0}%` }} />
    </span>
  );
}
