import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Database, Eye, Lock, Pencil, Play, Plus, RotateCw, Search, Table2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../../i18n";
import type { DbConnection } from "../../protocol/DbConnection";
import type { DbConnections } from "../../protocol/DbConnections";
import type { DbKind } from "../../protocol/DbKind";
import type { DbOrder } from "../../protocol/DbOrder";
import type { DbRows } from "../../protocol/DbRows";
import type { DbTable } from "../../protocol/DbTable";
import { rpc, useStore } from "../../store";
import { Dialog } from "../Dialog";
import { Menu } from "../Menu";
import { Empty } from "../Panel";
import { errText, prefs, useDev, useDevNotice } from "./state";

const PAGE = 100;
const KINDS: DbKind[] = ["sqlite", "postgres", "mysql"];

export function DataTab() {
  const t = useT();
  const ws = useStore((s) => s.workspaceId);
  const [conns, setConns] = useState<DbConnections | null>(null);
  const [connId, setConnId] = useState<string | null>(() => prefs.get(`bouvio.dev.conn.${ws}`));
  const [tables, setTables] = useState<DbTable[] | null>(null);
  const [tablesError, setTablesError] = useState<string | null>(null);
  const [table, setTable] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<DbConnection | "new" | null>(null);
  const [suggest, setSuggest] = useState<string | null>(null);
  const mode = useDev((s) => s.dataMode);
  const setMode = useDev((s) => s.setDataMode);

  const loadConns = useCallback(() => rpc<DbConnections>("list_db_connections", { workspace_id: ws }).then(setConns, () => setConns({ connections: [], suggestions: [] })), [ws]);
  useEffect(() => {
    loadConns();
  }, [loadConns]);
  useDevNotice("dev-db", loadConns);

  const conn = conns?.connections.find((c) => c.id === connId) ?? conns?.connections[0] ?? null;
  useEffect(() => {
    if (conn) prefs.set(`bouvio.dev.conn.${ws}`, conn.id);
  }, [conn, ws]);

  const loadTables = useCallback(async () => {
    if (!conn) return;
    setTables(null);
    setTablesError(null);
    try {
      const list = await rpc<DbTable[]>("list_db_tables", { workspace_id: ws, conn: conn.id });
      setTables(list);
      setTable((cur) => (cur && list.some((x) => x.name === cur) ? cur : list[0]?.name ?? null));
    } catch (e) {
      setTablesError(errText(e));
    }
  }, [ws, conn?.id]);
  useEffect(() => {
    loadTables();
  }, [loadTables]);

  const shownTables = (tables ?? []).filter((x) => x.name.toLowerCase().includes(q.trim().toLowerCase()));

  return (
    <div className="dv-data">
      <aside className="dv-nav">
        <div className="dv-nav-head">
          {conns && conns.connections.length > 0 ? (
            <Menu
              value={conn?.id ?? null}
              icon={<Database size={14} />}
              items={conns.connections.map((c) => ({ value: c.id as string | null, label: c.name, hint: c.kind }))}
              onChange={(id) => {
                setConnId(id);
                setTable(null);
              }}
            />
          ) : (
            <span className="dv-nav-title">{t("dev.data.connections")}</span>
          )}
          <div className="composer-spacer" />
          {conn && (
            <button className="icon-btn" title={t("dev.data.edit")} aria-label={t("dev.data.edit")} onClick={() => setEditing(conn)}>
              <Pencil size={13} />
            </button>
          )}
          <button className="icon-btn" title={t("dev.data.new")} aria-label={t("dev.data.new")} onClick={() => setEditing("new")}>
            <Plus size={15} />
          </button>
        </div>
        {conn && (
          <label className="dv-search">
            <Search size={13} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("dev.data.filter")} />
          </label>
        )}
        <div className="dv-nav-list">
          {tablesError && <div className="dv-empty small">{tablesError}</div>}
          {shownTables.map((x) => (
            <button
              key={x.name}
              className={`dv-nav-row ${table === x.name && mode === "rows" ? "on" : ""}`}
              onClick={() => {
                setTable(x.name);
                setMode("rows");
              }}
            >
              {x.kind === "view" ? <Eye size={13} /> : <Table2 size={13} />}
              <span className="truncate">{x.name}</span>
            </button>
          ))}
          {conns?.suggestions.map((s) => (
            <button key={s} className="dv-suggest" onClick={() => setSuggest(s)}>
              <Plus size={13} />
              <span className="truncate">{t("dev.data.add", { file: s })}</span>
            </button>
          ))}
        </div>
      </aside>
      <div className="dv-main">
        {!conn ? (
          <div className="dv-empty">
            <Database size={20} />
            <p>{t("dev.data.none")}</p>
            <button className="btn primary small" onClick={() => setEditing("new")}>
              <Plus size={14} />
              {t("dev.data.new")}
            </button>
          </div>
        ) : (
          <>
            <div className="dv-toolbar">
              <div className="choice small">
                <button className={mode === "rows" ? "on" : ""} onClick={() => setMode("rows")}>
                  {t("dev.data.rows")}
                </button>
                <button className={mode === "sql" ? "on" : ""} onClick={() => setMode("sql")}>
                  SQL
                </button>
              </div>
              <span className={`dv-badge ${conn.read_only ? "" : "warn"}`} title={t(conn.read_only ? "dev.data.readOnlyHint" : "dev.data.writableHint")}>
                {conn.read_only ? <Lock size={11} /> : <Pencil size={11} />}
                {t(conn.read_only ? "dev.data.readOnly" : "dev.data.writable")}
              </span>
              <div className="composer-spacer" />
              <button className="icon-btn" onClick={loadTables} title={t("dev.refresh")} aria-label={t("dev.refresh")}>
                <RotateCw size={14} />
              </button>
            </div>
            {mode === "rows" ? (
              table ? <TableView key={`${conn.id}:${table}`} conn={conn} table={table} /> : <Empty text={tables && tables.length === 0 ? t("dev.data.noTables") : t("dev.loading")} />
            ) : (
              <SqlView key={conn.id} conn={conn} table={table} />
            )}
          </>
        )}
      </div>
      {editing && (
        <ConnectionDialog
          conn={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(c) => {
            setConnId(c.id);
            loadConns();
          }}
        />
      )}
      {suggest && (
        <ConnectionDialog
          conn={{ id: "00000000-0000-0000-0000-000000000000", name: suggest.replace(/\.\w+$/, ""), kind: "sqlite", url: suggest, read_only: true }}
          onClose={() => setSuggest(null)}
          onSaved={(c) => {
            setConnId(c.id);
            loadConns();
          }}
        />
      )}
    </div>
  );
}

function fmt(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** Rows in a grid: sticky header, sortable columns, NULL in grey, numbers to the right. */
export function Grid({ data, order, onSort }: { data: DbRows; order?: DbOrder | null; onSort?: (col: string) => void }) {
  const t = useT();
  const [sel, setSel] = useState<[number, number] | null>(null);
  if (data.columns.length === 0) return <Empty text={data.affected !== null ? t("dev.data.affected", { count: data.affected }) : t("dev.data.noRows")} />;
  return (
    <div className="dv-grid-wrap">
      <table className="dv-grid">
        <thead>
          <tr>
            <th className="dv-rownum" />
            {data.columns.map((c) => (
              <th key={c} onClick={onSort ? () => onSort(c) : undefined} className={onSort ? "sortable" : undefined}>
                <span className="dv-th">
                  <span className="truncate">{c}</span>
                  {order?.column === c && (order.desc ? <ArrowDown size={11} /> : <ArrowUp size={11} />)}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row, i) => (
            <tr key={i}>
              <td className="dv-rownum">{i + 1}</td>
              {row.map((v, j) => (
                <td
                  key={j}
                  className={`${v === null ? "null" : typeof v === "number" ? "num" : typeof v === "boolean" ? "bool" : ""} ${sel?.[0] === i && sel?.[1] === j ? "sel" : ""}`}
                  title={typeof v === "string" && v.length > 40 ? v.slice(0, 2000) : undefined}
                  onClick={() => setSel([i, j])}
                  onDoubleClick={() => navigator.clipboard?.writeText(v === null ? "" : fmt(v))}
                >
                  {fmt(v).slice(0, 300)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {data.rows.length === 0 && <div className="dv-empty small">{t("dev.data.noRows")}</div>}
    </div>
  );
}

function TableView({ conn, table }: { conn: DbConnection; table: string }) {
  const t = useT();
  const ws = useStore((s) => s.workspaceId);
  const [data, setData] = useState<DbRows | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [order, setOrder] = useState<DbOrder | null>(null);

  useEffect(() => {
    let live = true;
    rpc<DbRows>("get_db_rows", { workspace_id: ws, conn: conn.id, table, limit: PAGE, offset, order }).then(
      (d) => live && (setData(d), setError(null)),
      (e) => live && setError(errText(e)),
    );
    return () => {
      live = false;
    };
  }, [ws, conn.id, table, offset, order]);

  const sort = (col: string) => {
    setOffset(0);
    setOrder((o) => (o?.column !== col ? { column: col, desc: false } : o.desc ? null : { column: col, desc: true }));
  };
  if (error) return <Empty text={error} />;
  if (!data) return <Empty text={t("dev.loading")} />;
  const total = data.total ?? data.rows.length;
  return (
    <>
      <Grid data={data} order={order} onSort={sort} />
      <div className="dv-foot">
        <span>{total === 0 ? t("dev.data.noRows") : t("dev.data.range", { from: offset + 1, to: offset + data.rows.length, total })}</span>
        <span className="dv-foot-time">{data.time_ms} ms</span>
        <div className="composer-spacer" />
        <button className="icon-btn" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))} aria-label={t("dev.data.prev")} title={t("dev.data.prev")}>
          <ChevronLeft size={15} />
        </button>
        <button className="icon-btn" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)} aria-label={t("dev.data.next")} title={t("dev.data.next")}>
          <ChevronRight size={15} />
        </button>
      </div>
    </>
  );
}

function SqlView({ conn, table }: { conn: DbConnection; table: string | null }) {
  const t = useT();
  const ws = useStore((s) => s.workspaceId);
  const key = `bouvio.dev.sql.${conn.id}`;
  const [sql, setSql] = useState(() => prefs.get(key) ?? (table ? `SELECT * FROM ${/^[a-z_][a-z0-9_.]*$/i.test(table) ? table : `"${table}"`} LIMIT 50;` : "SELECT 1;"));
  const [data, setData] = useState<DbRows | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const focus = useDev((s) => s.sqlFocus);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, [focus]);

  const run = async () => {
    if (!sql.trim() || busy) return;
    setBusy(true);
    prefs.set(key, sql);
    try {
      setData(await rpc<DbRows>("run_db_query", { workspace_id: ws, conn: conn.id, sql }));
      setError(null);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="dv-sql">
      <div className="dv-sql-editor">
        <textarea
          ref={ref}
          className="dv-code"
          spellCheck={false}
          value={sql}
          onChange={(e) => setSql(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              run();
            }
          }}
        />
        <div className="dv-sql-bar">
          <span className="dv-hint">{t("dev.data.runHint")}</span>
          <div className="composer-spacer" />
          <button className={`btn small primary ${busy ? "is-busy" : ""}`} onClick={run} disabled={busy}>
            <Play size={12} fill="currentColor" />
            {t("dev.data.run")}
          </button>
        </div>
      </div>
      {error ? (
        <div className="dv-error">{error}</div>
      ) : data ? (
        <>
          <Grid data={data} />
          <div className="dv-foot">
            <span>{data.columns.length ? t("dev.data.count", { count: data.rows.length }) : ""}</span>
            {data.truncated && <span className="dv-badge warn">{t("dev.data.capped")}</span>}
            <span className="dv-foot-time">{data.time_ms} ms</span>
          </div>
        </>
      ) : (
        <Empty text={t("dev.data.sqlEmpty")} />
      )}
    </div>
  );
}

function ConnectionDialog({ conn, onClose, onSaved }: { conn: DbConnection | null; onClose: () => void; onSaved: (c: DbConnection) => void }) {
  const t = useT();
  const ws = useStore((s) => s.workspaceId);
  const notify = useStore((s) => s.notify);
  const [name, setName] = useState(conn?.name ?? "");
  const [kind, setKind] = useState<DbKind>(conn?.kind ?? "sqlite");
  const [url, setUrl] = useState(conn?.url ?? "");
  const [readOnly, setReadOnly] = useState(conn?.read_only ?? true);
  const [error, setError] = useState<string | null>(null);
  const existing = conn && conn.id !== "00000000-0000-0000-0000-000000000000";
  const placeholder = useMemo(() => (kind === "sqlite" ? "data/app.db" : kind === "postgres" ? "postgres://user:password@localhost:5432/app" : "mysql://user:password@localhost:3306/app"), [kind]);

  const save = async () => {
    try {
      const c = await rpc<DbConnection>("save_db_connection", {
        workspace_id: ws,
        connection: { id: conn?.id ?? "00000000-0000-0000-0000-000000000000", name: name.trim(), kind, url: url.trim(), read_only: readOnly },
      });
      onSaved(c);
      onClose();
    } catch (e) {
      setError(errText(e));
    }
  };
  return (
    <Dialog title={t(existing ? "dev.data.editTitle" : "dev.data.newTitle")} onClose={onClose}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <label className="field">
          <span>{t("dev.data.name")}</span>
          <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="App" />
        </label>
        <div className="field">
          <span>{t("dev.data.kind")}</span>
          <div className="choice small">
            {KINDS.map((k) => (
              <button type="button" key={k} className={kind === k ? "on" : ""} onClick={() => setKind(k)}>
                {k === "sqlite" ? "SQLite" : k === "postgres" ? "Postgres" : "MySQL"}
              </button>
            ))}
          </div>
        </div>
        <label className="field">
          <span>{t(kind === "sqlite" ? "dev.data.path" : "dev.data.url")}</span>
          <input className="input mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder={placeholder} spellCheck={false} />
        </label>
        <label className="dv-check">
          <input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} />
          <span>
            {t("dev.data.readOnly")}
            <small>{t("dev.data.readOnlyHint")}</small>
          </span>
        </label>
        {error && <div className="dv-error inline">{error}</div>}
        <div className="dv-dialog-actions">
          {existing && (
            <button
              type="button"
              className="btn ghost dv-danger"
              onClick={async () => {
                await rpc("delete_db_connection", { workspace_id: ws, id: conn!.id }).catch((e) => notify(errText(e)));
                onClose();
              }}
            >
              {t("dev.delete")}
            </button>
          )}
          <div className="composer-spacer" />
          <button type="button" className="btn ghost" onClick={onClose}>
            {t("dev.cancel")}
          </button>
          <button type="submit" className="btn primary" disabled={!name.trim() || !url.trim()}>
            {t("dev.save")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
