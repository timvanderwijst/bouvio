import { ChevronDown, Clock, Globe, Plus, Save, Send, Settings2, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useT } from "../../i18n";
import { ago } from "../../lib/format";
import type { ApiCollection } from "../../protocol/ApiCollection";
import type { ApiEnvironment } from "../../protocol/ApiEnvironment";
import type { ApiRequest } from "../../protocol/ApiRequest";
import type { HttpHeader } from "../../protocol/HttpHeader";
import type { HttpResponse } from "../../protocol/HttpResponse";
import { rpc, useStore } from "../../store";
import { Dialog } from "../Dialog";
import { Menu } from "../Menu";
import { Empty } from "../Panel";
import { bytes, errText, useDevNotice } from "./state";

const NIL = "00000000-0000-0000-0000-000000000000";
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

const blank = (): ApiRequest => ({ id: NIL, name: "", method: "GET", url: "{{base_url}}/", headers: [{ name: "Accept", value: "application/json", enabled: true }], body: "" });

export function MethodTag({ method }: { method: string }) {
  return <span className={`dv-method m-${method.toLowerCase()}`}>{method === "DELETE" ? "DEL" : method === "OPTIONS" ? "OPT" : method}</span>;
}

export function ApiTab() {
  const t = useT();
  const ws = useStore((s) => s.workspaceId);
  const notify = useStore((s) => s.notify);
  const [col, setCol] = useState<ApiCollection | null>(null);
  const [req, setReq] = useState<ApiRequest>(blank);
  const [dirty, setDirty] = useState(false);
  const [res, setRes] = useState<HttpResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [envOpen, setEnvOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(true);

  const load = useCallback(() => rpc<ApiCollection>("list_api_requests", { workspace_id: ws }).then(setCol, () => setCol({ requests: [], environments: [], active_env: null, history: [] })), [ws]);
  useEffect(() => {
    load();
  }, [load]);
  useDevNotice("dev-api", load);

  const edit = (p: Partial<ApiRequest>) => {
    setReq((r) => ({ ...r, ...p }));
    setDirty(true);
  };
  const open = (r: ApiRequest) => {
    setReq(structuredClone(r));
    setDirty(false);
    setRes(null);
    setError(null);
  };

  const send = async () => {
    if (!req.url.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      setRes(await rpc<HttpResponse>("http_request", { workspace_id: ws, method: req.method, url: req.url, headers: req.headers, body: req.body, timeout_ms: 30000, name: req.name || null }));
    } catch (e) {
      setRes(null);
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    try {
      const saved = await rpc<ApiRequest>("save_api_request", { workspace_id: ws, request: req });
      setReq(saved);
      setDirty(false);
      notify(t("dev.api.saved"));
    } catch (e) {
      notify(errText(e));
    }
  };

  const env = col?.environments.find((e) => e.id === col.active_env) ?? null;
  const setActive = async (id: string | null) => {
    if (!col) return;
    setCol(await rpc<ApiCollection>("save_api_environments", { workspace_id: ws, environments: col.environments, active_env: id }));
  };

  return (
    <div className="dv-api">
      <aside className="dv-nav">
        <div className="dv-nav-head">
          <span className="dv-nav-title">{t("dev.api.requests")}</span>
          <div className="composer-spacer" />
          <button className="icon-btn" title={t("dev.api.new")} aria-label={t("dev.api.new")} onClick={() => open(blank())}>
            <Plus size={15} />
          </button>
        </div>
        <div className="dv-nav-list">
          {col?.requests.length === 0 && <div className="dv-empty small">{t("dev.api.noSaved")}</div>}
          {col?.requests.map((r) => (
            <div key={r.id} className={`dv-nav-row ${req.id === r.id ? "on" : ""}`} role="button" tabIndex={0} onClick={() => open(r)} onKeyDown={(e) => e.key === "Enter" && open(r)}>
              <MethodTag method={r.method} />
              <span className="truncate">{r.name}</span>
              <button
                className="icon-btn dv-row-x"
                title={t("dev.delete")}
                aria-label={t("dev.delete")}
                onClick={(e) => {
                  e.stopPropagation();
                  rpc("delete_api_request", { workspace_id: ws, id: r.id }).then(load, (err) => notify(errText(err)));
                }}
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
          {col && col.history.length > 0 && (
            <>
              <button className="group-head dv-nav-group" onClick={() => setHistoryOpen((o) => !o)}>
                <span>{t("dev.api.history")}</span>
                <span className="group-count">{col.history.length}</span>
                <ChevronDown size={12} className={historyOpen ? "" : "rot"} />
              </button>
              {historyOpen &&
                col.history.map((h) => (
                  <button key={h.id} className="dv-nav-row dv-hist" onClick={() => open({ ...h.request, id: NIL, name: h.request.name })} title={h.request.url}>
                    <MethodTag method={h.request.method} />
                    <span className="truncate mono">{h.request.url.replace(/^\{\{base_url\}\}/, "").replace(/^https?:\/\//, "") || "/"}</span>
                    <span className={`dv-status-dot ${statusClass(h.status)}`}>{h.status ?? "—"}</span>
                    <span className="dv-hist-when">{ago(h.at)}</span>
                  </button>
                ))}
            </>
          )}
        </div>
      </aside>
      <div className="dv-main">
        <div className="dv-api-bar">
          <Menu value={req.method} items={METHODS.map((m) => ({ value: m, label: m }))} onChange={(m) => edit({ method: m })} icon={<MethodTag method={req.method} />} label="" />
          <input
            className="input mono dv-url"
            value={req.url}
            spellCheck={false}
            placeholder="https://api.example.com/users"
            onChange={(e) => edit({ url: e.target.value })}
            onKeyDown={(e) => e.key === "Enter" && send()}
          />
          <button className={`btn primary ${busy ? "is-busy" : ""}`} onClick={send} disabled={busy || !req.url.trim()}>
            <Send size={13} />
            {t("dev.api.send")}
          </button>
          <button className="btn" onClick={save} title={t("dev.save")}>
            <Save size={13} />
            {req.id === NIL ? t("dev.save") : dirty ? t("dev.save") + " •" : t("dev.save")}
          </button>
        </div>
        <div className="dv-api-sub">
          <input className="dv-name" value={req.name} placeholder={t("dev.api.untitled")} onChange={(e) => edit({ name: e.target.value })} />
          <div className="composer-spacer" />
          <Menu
            value={col?.active_env ?? null}
            icon={<Globe size={13} />}
            label={env?.name ?? t("dev.api.noEnv")}
            items={[{ value: null, label: t("dev.api.noEnv") }, ...(col?.environments ?? []).map((e) => ({ value: e.id as string | null, label: e.name, hint: `${e.variables.length}` }))]}
            onChange={setActive}
          />
          <button className="icon-btn" title={t("dev.api.environments")} aria-label={t("dev.api.environments")} onClick={() => setEnvOpen(true)}>
            <Settings2 size={14} />
          </button>
        </div>
        <RequestEditor req={req} onChange={edit} />
        <ResponseView res={res} error={error} busy={busy} />
      </div>
      {envOpen && col && (
        <EnvDialog
          col={col}
          onClose={() => setEnvOpen(false)}
          onSave={async (envs, active) => {
            setCol(await rpc<ApiCollection>("save_api_environments", { workspace_id: ws, environments: envs, active_env: active }));
            setEnvOpen(false);
          }}
        />
      )}
    </div>
  );
}

const statusClass = (s: number | null) => (s === null ? "fail" : s < 300 ? "ok" : s < 400 ? "info" : s < 500 ? "warn" : "fail");

function KeyValues<T extends { enabled?: boolean }>({
  rows,
  keyOf,
  valueOf,
  make,
  onChange,
  keyHint,
  valueHint,
}: {
  rows: T[];
  keyOf: (r: T) => string;
  valueOf: (r: T) => string;
  make: (k: string, v: string, r?: T) => T;
  onChange: (rows: T[]) => void;
  keyHint: string;
  valueHint: string;
}) {
  const t = useT();
  const all = [...rows, make("", "")];
  return (
    <div className="dv-kv">
      {all.map((r, i) => {
        const last = i === rows.length;
        const set = (k: string, v: string) => {
          const next = make(k, v, r);
          onChange(last ? [...rows, next] : rows.map((x, j) => (j === i ? next : x)));
        };
        return (
          <div key={i} className={`dv-kv-row ${r.enabled === false ? "off" : ""}`}>
            {"enabled" in r ? (
              <input
                type="checkbox"
                aria-label={t("dev.api.enabled")}
                disabled={last}
                checked={r.enabled !== false}
                onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, enabled: e.target.checked } : x)))}
              />
            ) : (
              <span />
            )}
            <input className="mono" value={keyOf(r)} placeholder={keyHint} spellCheck={false} onChange={(e) => set(e.target.value, valueOf(r))} />
            <input className="mono" value={valueOf(r)} placeholder={valueHint} spellCheck={false} onChange={(e) => set(keyOf(r), e.target.value)} />
            {!last ? (
              <button className="icon-btn" aria-label={t("dev.delete")} title={t("dev.delete")} onClick={() => onChange(rows.filter((_, j) => j !== i))}>
                <X size={12} />
              </button>
            ) : (
              <span />
            )}
          </div>
        );
      })}
    </div>
  );
}

function RequestEditor({ req, onChange }: { req: ApiRequest; onChange: (p: Partial<ApiRequest>) => void }) {
  const t = useT();
  const [tab, setTab] = useState<"headers" | "body">("headers");
  const active = req.headers.filter((h) => h.enabled && h.name).length;
  const formatJson = () => {
    try {
      onChange({ body: JSON.stringify(JSON.parse(req.body), null, 2) });
    } catch {}
  };
  return (
    <div className="dv-req">
      <div className="dv-subtabs">
        <button className={tab === "headers" ? "on" : ""} onClick={() => setTab("headers")}>
          {t("dev.api.headers")}
          {active > 0 && <span className="dv-count">{active}</span>}
        </button>
        <button className={tab === "body" ? "on" : ""} onClick={() => setTab("body")}>
          {t("dev.api.body")}
          {req.body && <span className="dv-dot" />}
        </button>
        <div className="composer-spacer" />
        {tab === "body" && req.body.trim().startsWith("{") && (
          <button className="btn ghost small" onClick={formatJson}>
            {t("dev.api.format")}
          </button>
        )}
      </div>
      {tab === "headers" ? (
        <KeyValues<HttpHeader>
          rows={req.headers}
          keyOf={(h) => h.name}
          valueOf={(h) => h.value}
          make={(name, value, r) => ({ name, value, enabled: r?.enabled ?? true })}
          onChange={(headers) => onChange({ headers })}
          keyHint={t("dev.api.header")}
          valueHint={t("dev.api.value")}
        />
      ) : (
        <textarea className="dv-code dv-body-edit" spellCheck={false} value={req.body} placeholder={'{\n  "name": "Ada"\n}'} onChange={(e) => onChange({ body: e.target.value })} />
      )}
    </div>
  );
}

function ResponseView({ res, error, busy }: { res: HttpResponse | null; error: string | null; busy: boolean }) {
  const t = useT();
  const [tab, setTab] = useState<"body" | "headers">("body");
  const contentType = res?.headers.find((h) => h.name.toLowerCase() === "content-type")?.value ?? "";
  const pretty = useMemo(() => {
    if (!res || res.base64) return null;
    if (contentType.includes("json") || /^\s*[[{]/.test(res.body)) {
      try {
        return JSON.stringify(JSON.parse(res.body), null, 2);
      } catch {}
    }
    return res.body;
  }, [res, contentType]);

  return (
    <div className="dv-res">
      <div className="dv-subtabs">
        <button className={tab === "body" ? "on" : ""} onClick={() => setTab("body")}>
          {t("dev.api.response")}
        </button>
        <button className={tab === "headers" ? "on" : ""} onClick={() => setTab("headers")}>
          {t("dev.api.headers")}
          {res && <span className="dv-count">{res.headers.length}</span>}
        </button>
        <div className="composer-spacer" />
        {res && (
          <span className="dv-res-meta">
            <span className={`dv-status ${statusClass(res.status)}`}>
              {res.status} {res.status_text}
            </span>
            <span>
              <Clock size={11} /> {res.time_ms} ms
            </span>
            <span>{bytes(res.size)}</span>
          </span>
        )}
      </div>
      <div className="dv-res-body">
        {error ? (
          <div className="dv-error">{error}</div>
        ) : busy && !res ? (
          <Empty text={t("dev.api.sending")} />
        ) : !res ? (
          <Empty text={t("dev.api.empty")} />
        ) : tab === "headers" ? (
          <table className="dv-headers">
            <tbody>
              {res.headers.map((h, i) => (
                <tr key={i}>
                  <td className="mono">{h.name}</td>
                  <td className="mono">{h.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : res.base64 && contentType.startsWith("image/") ? (
          <div className="dv-res-img">
            <img alt="" src={`data:${contentType};base64,${res.body}`} />
          </div>
        ) : res.base64 ? (
          <Empty text={t("dev.api.binary", { size: bytes(res.size), type: contentType || "?" })} />
        ) : (
          <pre className="dv-code dv-res-text">{pretty || " "}</pre>
        )}
      </div>
    </div>
  );
}

function EnvDialog({ col, onClose, onSave }: { col: ApiCollection; onClose: () => void; onSave: (envs: ApiEnvironment[], active: string | null) => void }) {
  const t = useT();
  const [envs, setEnvs] = useState<ApiEnvironment[]>(() => structuredClone(col.environments));
  const [sel, setSel] = useState<number>(Math.max(0, col.environments.findIndex((e) => e.id === col.active_env)));
  const [active, setActive] = useState(col.active_env);
  const env = envs[sel];
  const add = () => {
    const id = crypto.randomUUID();
    setEnvs([...envs, { id, name: envs.length ? t("dev.api.envName", { n: envs.length + 1 }) : "Local", variables: [{ key: "base_url", value: "http://localhost:3000" }] }]);
    setSel(envs.length);
    if (!active) setActive(id);
  };
  const patch = (p: Partial<ApiEnvironment>) => setEnvs(envs.map((e, i) => (i === sel ? { ...e, ...p } : e)));
  return (
    <Dialog title={t("dev.api.environments")} onClose={onClose}>
      <div className="dv-envs">
        <div className="dv-env-list">
          {envs.map((e, i) => (
            <button key={e.id} className={`dv-nav-row ${i === sel ? "on" : ""}`} onClick={() => setSel(i)}>
              <span className="truncate">{e.name || t("dev.api.untitled")}</span>
              {e.id === active && <span className="dv-badge">{t("dev.api.active")}</span>}
            </button>
          ))}
          <button className="dv-suggest" onClick={add}>
            <Plus size={13} />
            {t("dev.api.addEnv")}
          </button>
        </div>
        {env ? (
          <div className="dv-env-edit">
            <div className="dv-env-row">
              <input className="input" value={env.name} onChange={(e) => patch({ name: e.target.value })} />
              <button className="btn small" disabled={env.id === active} onClick={() => setActive(env.id)}>
                {t("dev.api.use")}
              </button>
              <button
                className="icon-btn"
                title={t("dev.delete")}
                aria-label={t("dev.delete")}
                onClick={() => {
                  if (env.id === active) setActive(null);
                  setEnvs(envs.filter((_, i) => i !== sel));
                  setSel(0);
                }}
              >
                <Trash2 size={13} />
              </button>
            </div>
            <KeyValues
              rows={env.variables}
              keyOf={(v) => v.key}
              valueOf={(v) => v.value}
              make={(key, value) => ({ key, value })}
              onChange={(variables) => patch({ variables })}
              keyHint={t("dev.api.variable")}
              valueHint={t("dev.api.value")}
            />
            <p className="dv-hint">{t("dev.api.varHint")}</p>
          </div>
        ) : (
          <Empty text={t("dev.api.noEnvs")} />
        )}
      </div>
      <div className="dv-dialog-actions">
        <div className="composer-spacer" />
        <button className="btn ghost" onClick={onClose}>
          {t("dev.cancel")}
        </button>
        <button className="btn primary" onClick={() => onSave(envs.map((e) => ({ ...e, variables: e.variables.filter((v) => v.key.trim()) })), active)}>
          {t("dev.save")}
        </button>
      </div>
    </Dialog>
  );
}
