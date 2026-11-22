import { Plus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { backend } from "../../backend";
import { useT } from "../../i18n";
import type { BudgetScope } from "../../protocol/BudgetScope";
import type { BudgetStatus } from "../../protocol/BudgetStatus";
import type { CostRow } from "../../protocol/CostRow";
import type { CostSummary } from "../../protocol/CostSummary";
import { rpc, useStore, useWorkspace, useWorkspaceLeads, useWorkspaceThreads } from "../../store";
import { cost } from "../../lib/format";
import { Dialog } from "../Dialog";
import { Empty } from "../Panel";
import { Menu } from "../Menu";
import { PixelAvatar } from "../PixelAvatar";
import { DailyBars, InlineBar } from "./Chart";

const PERIODS = [7, 30, 90] as const;

/** Workspace page: what agents cost, where it went, and monthly budgets. */
export function CostsPage() {
  const t = useT();
  const ws = useWorkspace();
  const threads = useWorkspaceThreads();
  const [days, setDays] = useState<number>(30);
  const [data, setData] = useState<CostSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [budget, setBudget] = useState<BudgetStatus | "new" | null>(null);
  // Re-read when a turn finishes somewhere in this workspace.
  const spent = threads.reduce((a, x) => a + x.cost_usd, 0);

  const load = useCallback(async () => {
    if (!ws) return;
    try {
      setData(await rpc<CostSummary>("cost_summary", { workspace_id: ws.id, days }, ws.id));
      setError(null);
    } catch (e) {
      setError(String(e).replace(/^Error: /, ""));
    }
  }, [ws, days]);
  useEffect(() => {
    load();
  }, [load, spent]);
  useEffect(
    () =>
      backend.on<{ workspace_id: string; kind: string }>("workspace-notice", (n) => {
        if (n.kind === "personal-budgets" && n.workspace_id === ws?.id) load();
      }),
    [load, ws?.id],
  );

  if (!ws) return null;
  return (
    <div className="page wide p-costs">
      <div className="page-head">
        <h1 className="page-title">{t("personal.costs")}</h1>
        <div className="choice small" role="group" aria-label={t("personal.costs.period")}>
          {PERIODS.map((d) => (
            <button key={d} type="button" className={days === d ? "on" : ""} onClick={() => setDays(d)}>
              {t("personal.costs.days", { count: d })}
            </button>
          ))}
        </div>
      </div>

      {error && !data ? (
        <Empty text={error} />
      ) : !data ? (
        <div className="p-costs-skel">
          <div className="shimmer p-skel-total" />
          <div className="shimmer p-skel-chart" />
        </div>
      ) : (
        <>
          <section className="p-total">
            <span className="p-total-num num">{cost(data.total_usd)}</span>
            <span className="p-total-sub">
              {t("personal.costs.totalSub", { turns: data.turns, days: data.days })}
              {data.unknown_turns > 0 && <span className="p-unknown"> · {t("personal.costs.unknown", { count: data.unknown_turns })}</span>}
            </span>
          </section>
          <DailyBars days={data.per_day} />

          <section className="p-section">
            <div className="p-section-head">
              <h2 className="p-h">{t("personal.costs.budgets")}</h2>
              <button type="button" className="btn ghost small" onClick={() => setBudget("new")}>
                <Plus size={13} />
                {t("personal.costs.setBudget")}
              </button>
            </div>
            {data.budgets.length === 0 ? (
              <p className="p-quiet">{t("personal.costs.noBudgets")}</p>
            ) : (
              <div className="p-budgets">
                {data.budgets.map((b) => (
                  <BudgetRow key={`${b.budget.scope}${b.budget.id ?? ""}`} b={b} onEdit={() => setBudget(b)} />
                ))}
              </div>
            )}
          </section>

          <div className="p-breakdowns">
            <Breakdown title={t("personal.costs.byLead")} rows={data.per_lead} kind="lead" />
            <Breakdown title={t("personal.costs.byModel")} rows={data.per_model} kind="model" />
            <Breakdown title={t("personal.costs.byPerson")} rows={data.per_person} kind="person" />
            <ThreadBreakdown data={data} />
          </div>
        </>
      )}
      {budget && <BudgetDialog current={budget === "new" ? null : budget} onClose={() => setBudget(null)} onSaved={load} />}
    </div>
  );
}

function BudgetRow({ b, onEdit }: { b: BudgetStatus; onEdit: () => void }) {
  const t = useT();
  const leads = useWorkspaceLeads();
  const c = b.budget.scope === "lead" ? leads.find((x) => x.id === b.budget.id) : null;
  const pct = b.budget.monthly_usd > 0 ? b.spent_usd / b.budget.monthly_usd : 0;
  const level = pct >= 1 ? "over" : pct >= 0.8 ? "near" : "";
  return (
    <button type="button" className={`p-budget ${level}`} onClick={onEdit} title={t("personal.costs.editBudget")}>
      <span className="p-budget-name">
        {c ? <PixelAvatar seed={c.avatar_seed} size={14} /> : <span className="ws-initial">{b.label.slice(0, 1).toUpperCase()}</span>}
        <span className="truncate">{b.label}</span>
      </span>
      <span
        className="p-meter"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={b.budget.monthly_usd}
        aria-valuenow={Math.round(b.spent_usd * 100) / 100}
        aria-label={b.label}
      >
        <i style={{ width: `${Math.min(100, pct * 100)}%` }} />
      </span>
      <span className="p-budget-num num">{t("personal.costs.ofBudget", { spent: cost(b.spent_usd), budget: cost(b.budget.monthly_usd) })}</span>
    </button>
  );
}

function Breakdown({ title, rows, kind }: { title: string; rows: CostRow[]; kind: "lead" | "model" | "person" }) {
  const t = useT();
  const leads = useWorkspaceLeads();
  const max = Math.max(0, ...rows.map((r) => r.cost_usd));
  return (
    <section className="p-break">
      <h2 className="p-h">{title}</h2>
      {rows.length === 0 && <p className="p-quiet">{t("personal.costs.nothing")}</p>}
      {rows.slice(0, 8).map((r) => {
        const c = kind === "lead" ? leads.find((x) => x.id === r.key) : null;
        const label = r.label || (kind === "lead" ? t("personal.costs.noLead") : kind === "person" ? t("personal.costs.someone") : r.key);
        return (
          <div key={r.key} className="p-brow">
            <span className="p-blabel">
              {c && <PixelAvatar seed={c.avatar_seed} size={14} />}
              <span className="truncate">{label}</span>
            </span>
            <InlineBar value={r.cost_usd} max={max} />
            <span className="p-bnum num">{cost(r.cost_usd)}</span>
            <span className="p-bturns num">{r.turns}</span>
          </div>
        );
      })}
    </section>
  );
}

function ThreadBreakdown({ data }: { data: CostSummary }) {
  const t = useT();
  const openThread = useStore((s) => s.openThread);
  const max = Math.max(0, ...data.top_threads.map((r) => r.cost_usd));
  return (
    <section className="p-break">
      <h2 className="p-h">{t("personal.costs.topThreads")}</h2>
      {data.top_threads.length === 0 && <p className="p-quiet">{t("personal.costs.nothing")}</p>}
      {data.top_threads.map((r) => (
        <button type="button" key={r.thread_id} className="p-brow link" onClick={() => openThread(r.thread_id)}>
          <span className="p-blabel">
            <span className="truncate">{r.title}</span>
          </span>
          <InlineBar value={r.cost_usd} max={max} />
          <span className="p-bnum num">{cost(r.cost_usd)}</span>
          <span className="p-bturns num">{r.turns}</span>
        </button>
      ))}
    </section>
  );
}

function BudgetDialog({ current, onClose, onSaved }: { current: BudgetStatus | null; onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const ws = useWorkspace()!;
  const leads = useWorkspaceLeads();
  const notify = useStore((s) => s.notify);
  const [scope, setScope] = useState<BudgetScope>(current?.budget.scope ?? "workspace");
  const [lead, setLead] = useState<string | null>(current?.budget.id ?? leads[0]?.id ?? null);
  const [amount, setAmount] = useState(current ? String(current.budget.monthly_usd) : "");
  const [shake, setShake] = useState(false);

  const save = async (monthly: number) => {
    try {
      await rpc("set_budget", { workspace_id: ws.id, scope, id: scope === "lead" ? lead : null, monthly_usd: monthly }, ws.id);
      onSaved();
      onClose();
    } catch (e) {
      notify(String(e));
    }
  };

  return (
    <Dialog title={current ? t("personal.costs.editBudget") : t("personal.costs.setBudget")} onClose={onClose}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          const v = Number(amount.replace(",", "."));
          if (!(v > 0) || (scope === "lead" && !lead)) {
            setShake(true);
            setTimeout(() => setShake(false), 400);
            return;
          }
          save(v);
        }}
      >
        {!current && (
          <div className="field">
            <span>{t("personal.costs.scope")}</span>
            <div className="choice small">
              {(["workspace", "lead"] as const).map((s) => (
                <button key={s} type="button" className={scope === s ? "on" : ""} onClick={() => setScope(s)} disabled={s === "lead" && !leads.length}>
                  {t(`personal.costs.scope.${s}`)}
                </button>
              ))}
            </div>
          </div>
        )}
        {scope === "lead" && !current && (
          <div className="field">
            <span>{t("personal.costs.lead")}</span>
            <Menu value={lead} items={leads.map((c) => ({ value: c.id as string | null, label: c.name, icon: <PixelAvatar seed={c.avatar_seed} size={14} /> }))} onChange={setLead} />
          </div>
        )}
        <label className="field">
          <span>{t("personal.costs.monthly")}</span>
          <input className={`input ${shake ? "nudge" : ""}`} inputMode="decimal" autoFocus value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="25" />
          <span className="field-hint">{t("personal.costs.budgetHint")}</span>
        </label>
        <div className="form-actions spread">
          {current ? (
            <button type="button" className="btn ghost" onClick={() => save(0)}>
              {t("personal.costs.removeBudget")}
            </button>
          ) : (
            <span />
          )}
          <span className="p-actions">
            <button type="button" className="btn ghost" onClick={onClose}>
              {t("common.cancel")}
            </button>
            <button type="submit" className="btn primary">
              {t("common.save")}
            </button>
          </span>
        </div>
      </form>
    </Dialog>
  );
}
