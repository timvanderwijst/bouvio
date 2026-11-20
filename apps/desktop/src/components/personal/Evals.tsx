import { Check, CircleDashed, Loader2, Play, Plus, Trash2, X, AlertTriangle } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { backend } from "../../backend";
import { useT } from "../../i18n";
import type { EvalCase } from "../../protocol/EvalCase";
import type { EvalCheck } from "../../protocol/EvalCheck";
import type { EvalResult } from "../../protocol/EvalResult";
import type { EvalRun } from "../../protocol/EvalRun";
import type { EvalStatus } from "../../protocol/EvalStatus";
import type { EvalSuite } from "../../protocol/EvalSuite";
import type { EvalTarget } from "../../protocol/EvalTarget";
import type { HarnessKind } from "../../protocol/HarnessKind";
import { rpc, useStore, useWorkspace } from "../../store";
import { ago, cost, duration } from "../../lib/format";
import { HARNESS_NAMES, MODELS } from "../harness";
import { Empty } from "../Panel";
import { Menu } from "../Menu";

const CHECKS: EvalCheck[] = ["contains", "not_contains", "regex", "command_exit_zero", "judge"];
const NIL = "00000000-0000-0000-0000-000000000000";

const targetKey = (x: EvalTarget) => `${x.harness}:${x.model ?? ""}`;
const targetLabel = (x: EvalTarget) => (x.model ? `${HARNESS_NAMES[x.harness]} · ${x.model}` : HARNESS_NAMES[x.harness]);

/** Workspace page: suites of prompts with checks, run across agents and models. */
export function EvalsPage() {
  const t = useT();
  const ws = useWorkspace();
  const notify = useStore((s) => s.notify);
  const [suites, setSuites] = useState<EvalSuite[] | null>(null);
  const [runs, setRuns] = useState<EvalRun[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [draft, setDraft] = useState<EvalSuite | null>(null);
  const [dirty, setDirty] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const w = ws?.id ?? null;

  const load = useCallback(async () => {
    if (!w) return;
    try {
      const [s, r] = await Promise.all([rpc<EvalSuite[]>("list_evals", { workspace_id: w }, w), rpc<EvalRun[]>("list_eval_runs", { workspace_id: w }, w)]);
      setSuites(s);
      setRuns(r);
      setSel((cur) => cur ?? s[0]?.id ?? null);
    } catch (e) {
      setSuites([]);
      notify(String(e));
    }
  }, [w, notify]);
  useEffect(() => {
    setSel(null);
    load();
  }, [load]);

  // Live progress of running evals.
  useEffect(
    () =>
      backend.on<{ workspace_id: string; kind: string; payload: EvalRun }>("workspace-notice", ({ workspace_id, kind, payload }) => {
        if (kind !== "personal-eval" || workspace_id !== w) return;
        setRuns((list) => [payload, ...list.filter((x) => x.id !== payload.id)].sort((a, b) => b.started_at.localeCompare(a.started_at)));
      }),
    [w],
  );

  const suite = suites?.find((s) => s.id === sel) ?? null;
  useEffect(() => {
    setDraft(suite ? structuredClone(suite) : null);
    setDirty(false);
  }, [suite]);

  const suiteRuns = useMemo(() => runs.filter((r) => r.suite_id === sel), [runs, sel]);
  const run = suiteRuns.find((r) => r.id === runId) ?? suiteRuns[0] ?? null;

  const create = async () => {
    if (!w) return;
    const s = await rpc<EvalSuite>(
      "save_eval",
      { suite: { id: NIL, workspace_id: w, name: t("personal.evals.newName"), cases: [{ prompt: "", check: "contains", expected: "" }], updated_at: new Date().toISOString() } },
      w,
    ).catch((e) => (notify(String(e)), null));
    if (!s) return;
    setSuites((l) => [...(l ?? []), s]);
    setSel(s.id);
  };

  const save = async () => {
    if (!draft || !w) return null;
    try {
      const s = await rpc<EvalSuite>("save_eval", { suite: draft }, w);
      setSuites((l) => (l ?? []).map((x) => (x.id === s.id ? s : x)));
      setDirty(false);
      return s;
    } catch (e) {
      notify(String(e));
      return null;
    }
  };

  const remove = async () => {
    if (!suite || !w) return;
    await rpc("delete_eval", { id: suite.id }, w).catch((e) => notify(String(e)));
    const rest = (suites ?? []).filter((x) => x.id !== suite.id);
    setSuites(rest);
    setSel(rest[0]?.id ?? null);
  };

  const edit = (f: (s: EvalSuite) => void) => {
    setDraft((d) => {
      if (!d) return d;
      const n = structuredClone(d);
      f(n);
      return n;
    });
    setDirty(true);
  };

  if (!ws) return null;
  return (
    <div className="page wide p-evals">
      <div className="page-head">
        <h1 className="page-title">{t("personal.evals")}</h1>
        {suites && suites.length > 0 && (
          <Menu value={sel} items={suites.map((s) => ({ value: s.id as string | null, label: s.name, hint: t("personal.evals.cases", { count: s.cases.length }) }))} onChange={setSel} />
        )}
        <div className="page-actions">
          <button type="button" className="btn" onClick={create}>
            <Plus size={14} />
            {t("personal.evals.new")}
          </button>
        </div>
      </div>

      {suites === null ? (
        <div className="shimmer p-skel-chart" />
      ) : !draft ? (
        <Empty text={t("personal.evals.none")} />
      ) : (
        <>
          <section className="p-section">
            <div className="p-suite-head">
              <input className="p-suite-name" value={draft.name} onChange={(e) => edit((s) => (s.name = e.target.value))} aria-label={t("personal.evals.name")} />
              <div className="composer-spacer" />
              {dirty && (
                <button type="button" className="btn small primary" onClick={save}>
                  {t("common.save")}
                </button>
              )}
              <button type="button" className="icon-btn" onClick={remove} title={t("personal.evals.delete")} aria-label={t("personal.evals.delete")}>
                <Trash2 size={14} />
              </button>
            </div>
            <div className="p-cases">
              {draft.cases.map((c, i) => (
                <CaseEditor
                  key={i}
                  n={i + 1}
                  c={c}
                  onChange={(next) => edit((s) => (s.cases[i] = next))}
                  onRemove={draft.cases.length > 1 ? () => edit((s) => s.cases.splice(i, 1)) : undefined}
                />
              ))}
            </div>
            <button type="button" className="btn ghost small" onClick={() => edit((s) => s.cases.push({ prompt: "", check: "contains", expected: "" }))}>
              <Plus size={13} />
              {t("personal.evals.addCase")}
            </button>
          </section>

          <RunBar
            onRun={async (targets) => {
              const s = dirty ? await save() : suite;
              if (!s || !w) return;
              try {
                const r = await rpc<EvalRun>("run_eval", { suite_id: s.id, targets }, w);
                setRuns((l) => [r, ...l.filter((x) => x.id !== r.id)]);
                setRunId(r.id);
              } catch (e) {
                notify(String(e));
              }
            }}
          />

          {run && (
            <section className="p-section">
              <div className="p-section-head">
                <h2 className="p-h">{t("personal.evals.results")}</h2>
                {suiteRuns.length > 1 && (
                  <Menu
                    value={run.id}
                    items={suiteRuns.map((r) => ({ value: r.id as string | null, label: ago(r.started_at), hint: r.targets.map(targetLabel).join(", ") }))}
                    onChange={(id) => setRunId(id)}
                  />
                )}
                <span className="p-card-meta">{run.finished_at ? ago(run.finished_at) : t("personal.evals.running")}</span>
              </div>
              <Matrix run={run} />
            </section>
          )}
        </>
      )}
    </div>
  );
}

function CaseEditor({ n, c, onChange, onRemove }: { n: number; c: EvalCase; onChange: (c: EvalCase) => void; onRemove?: () => void }) {
  const t = useT();
  return (
    <div className="p-case">
      <span className="p-case-n num">{n}</span>
      <div className="p-case-body">
        <textarea className="input area" rows={2} value={c.prompt} placeholder={t("personal.evals.promptHint")} onChange={(e) => onChange({ ...c, prompt: e.target.value })} aria-label={t("personal.evals.prompt")} />
        <div className="p-case-check">
          <Menu value={c.check} items={CHECKS.map((k) => ({ value: k, label: t(`personal.check.${k}`) }))} onChange={(k) => onChange({ ...c, check: k })} />
          <input
            className={`input grow ${c.check === "command_exit_zero" || c.check === "regex" ? "mono" : ""}`}
            value={c.expected}
            placeholder={t(`personal.check.${c.check}.hint`)}
            onChange={(e) => onChange({ ...c, expected: e.target.value })}
            aria-label={t("personal.evals.expected")}
          />
        </div>
      </div>
      {onRemove && (
        <button type="button" className="icon-btn" onClick={onRemove} title={t("personal.evals.removeCase")} aria-label={t("personal.evals.removeCase")}>
          <X size={14} />
        </button>
      )}
    </div>
  );
}

/** Pick agents and models to compare, then run. */
function RunBar({ onRun }: { onRun: (targets: EvalTarget[]) => void }) {
  const t = useT();
  const harnesses = useStore((s) => s.harnesses);
  const models = useStore((s) => s.models);
  const available = harnesses.filter((h) => h.available).map((h) => h.kind);
  const [harness, setHarness] = useState<HarnessKind | null>(available[0] ?? null);
  const [model, setModel] = useState<string | null>(null);
  const [targets, setTargets] = useState<EvalTarget[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!harness && available[0]) setHarness(available[0]);
  }, [harness, available]);

  const modelItems = (h: HarnessKind | null) =>
    h === "api" ? models.map((m) => ({ value: m.id as string | null, label: m.name, hint: m.provider })) : (MODELS[h ?? "claude_code"] ?? [{ id: null, label: "Default" }]).map((m) => ({ value: m.id, label: m.id ? m.label : t("personal.evals.defaultModel") }));
  const items = modelItems(harness);
  const add = () => {
    if (!harness) return;
    const x: EvalTarget = { harness, model: harness === "api" ? (model ?? items[0]?.value ?? null) : model };
    if (!targets.some((y) => targetKey(y) === targetKey(x))) setTargets([...targets, x]);
  };

  return (
    <section className="p-section p-runbar">
      <h2 className="p-h">{t("personal.evals.targets")}</h2>
      <div className="p-targets">
        {targets.map((x) => (
          <span key={targetKey(x)} className="p-chip">
            {targetLabel(x)}
            <button type="button" onClick={() => setTargets(targets.filter((y) => targetKey(y) !== targetKey(x)))} aria-label={t("common.delete")}>
              <X size={11} />
            </button>
          </span>
        ))}
        <span className="p-target-pick">
          <Menu
            value={harness}
            items={available.map((h) => ({ value: h as HarnessKind | null, label: HARNESS_NAMES[h] }))}
            onChange={(h) => {
              setHarness(h);
              setModel(null);
            }}
            label={harness ? HARNESS_NAMES[harness] : t("personal.evals.noAgents")}
          />
          {items.length > 0 && <Menu value={model ?? items[0].value} items={items} onChange={setModel} />}
          <button type="button" className="btn ghost small" onClick={add} disabled={!harness}>
            <Plus size={13} />
            {t("personal.evals.addTarget")}
          </button>
        </span>
        <div className="composer-spacer" />
        <button
          type="button"
          className={`btn primary ${busy ? "is-busy" : ""}`}
          disabled={!targets.length || busy}
          onClick={async () => {
            setBusy(true);
            await onRun(targets);
            setBusy(false);
          }}
        >
          <Play size={13} />
          {t("personal.evals.run")}
        </button>
      </div>
      <p className="field-hint">{t("personal.evals.runHint")}</p>
    </section>
  );
}

function StatusMark({ status }: { status: EvalStatus }) {
  const t = useT();
  const label = t(`personal.eval.${status}`);
  if (status === "passed") return <Check size={14} className="p-ev pass" aria-label={label} />;
  if (status === "failed") return <X size={14} className="p-ev fail" aria-label={label} />;
  if (status === "running") return <Loader2 size={14} className="p-ev run" aria-label={label} />;
  if (status === "error") return <AlertTriangle size={13} className="p-ev err" aria-label={label} />;
  return <CircleDashed size={13} className="p-ev wait" aria-label={label} />;
}

/** Cases down, targets across; each cell opens its thread. */
function Matrix({ run }: { run: EvalRun }) {
  const t = useT();
  const openThread = useStore((s) => s.openThread);
  const cell = (c: number, x: number) => run.results.find((r) => r.case_index === c && r.target_index === x);
  const totals = run.targets.map((_, x) => {
    const rs = run.results.filter((r) => r.target_index === x);
    return {
      passed: rs.filter((r) => r.status === "passed").length,
      done: rs.filter((r) => r.status !== "pending" && r.status !== "running").length,
      ms: rs.reduce((a, r) => a + (r.duration_ms ?? 0), 0),
      usd: rs.reduce((a, r) => a + (r.cost_usd ?? 0), 0),
      n: rs.length,
    };
  });
  const open = (r?: EvalResult) => r?.thread_id && openThread(r.thread_id);

  return (
    <div className="p-matrix-wrap">
      <table className="p-matrix">
        <thead>
          <tr>
            <th className="p-mcase">{t("personal.evals.case")}</th>
            {run.targets.map((x) => (
              <th key={targetKey(x)}>{targetLabel(x)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {run.cases.map((c, i) => (
            <tr key={i}>
              <th className="p-mcase" scope="row">
                <span className="p-mprompt" title={c.prompt}>
                  {c.prompt || "—"}
                </span>
                <span className="p-mcheck">{t(`personal.check.${c.check}`)}</span>
              </th>
              {run.targets.map((x, j) => {
                const r = cell(i, j);
                return (
                  <td key={targetKey(x)}>
                    <button type="button" className={`p-cell s-${r?.status ?? "pending"}`} onClick={() => open(r)} disabled={!r?.thread_id} title={r?.reason ?? undefined}>
                      <StatusMark status={r?.status ?? "pending"} />
                      <span className="p-cell-meta num">
                        {r?.duration_ms != null && duration(r.duration_ms)}
                        {r?.cost_usd != null && ` · ${cost(r.cost_usd)}`}
                      </span>
                      {r?.reason && (r.status === "failed" || r.status === "error") && <span className="p-cell-reason">{r.reason.split("\n")[0]}</span>}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th className="p-mcase" scope="row">
              {t("personal.evals.total")}
            </th>
            {totals.map((s, j) => (
              <td key={j}>
                <span className="p-total-cell">
                  <span className="p-score num">
                    {s.passed}/{s.n}
                  </span>
                  <span className="p-cell-meta num">
                    {duration(s.ms)} · {cost(s.usd)}
                  </span>
                </span>
              </td>
            ))}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
