//! Data: a small database viewer for SQLite, Postgres and MySQL.
//!
//! Queries go through the text protocol (`raw_sql`), so every column type
//! arrives as text we can turn into JSON without per-type decoders.

use super::{dev_dir, root};
use crate::{store, Runner};
use anyhow::{bail, Context, Result};
use bouvio_protocol::dev::*;
use futures::{StreamExt, TryStreamExt};
use serde_json::{json, Value};
use sqlx::{Column, ColumnIndex, Connection, Decode, Executor, Row, TypeInfo, ValueRef};
use std::path::{Path, PathBuf};
use std::time::Instant;
use uuid::Uuid;

pub const ROW_CAP: usize = 1000;
const MASK: &str = "****";

fn file(r: &Runner, ws: Uuid) -> PathBuf {
    dev_dir(r, ws).join("db.json")
}

fn load(r: &Runner, ws: Uuid) -> Vec<DbConnection> {
    store::load(&file(r, ws)).unwrap_or_default()
}

/// `postgres://me:secret@host/db` → `postgres://me:****@host/db`.
pub fn redact(url: &str) -> String {
    let Some((scheme, rest)) = url.split_once("://") else { return url.to_string() };
    let (auth, host) = match rest.rsplit_once('@') {
        Some(x) => x,
        None => return url.to_string(),
    };
    match auth.split_once(':') {
        Some((user, pw)) if !pw.is_empty() => format!("{scheme}://{user}:{MASK}@{host}"),
        _ => url.to_string(),
    }
}

pub fn list(r: &Runner, ws: Uuid) -> DbConnections {
    let mut connections = load(r, ws);
    for c in &mut connections {
        c.url = redact(&c.url);
    }
    let mut suggestions = vec![];
    if let Ok(root) = root(r, ws) {
        if let Ok(dir) = std::fs::read_dir(&root) {
            for e in dir.flatten() {
                let name = e.file_name().to_string_lossy().into_owned();
                let ext = Path::new(&name).extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase());
                if matches!(ext.as_deref(), Some("db" | "sqlite" | "sqlite3")) && e.path().is_file() && !connections.iter().any(|c| c.kind == DbKind::Sqlite && c.url == name) {
                    suggestions.push(name);
                }
            }
        }
    }
    suggestions.sort();
    DbConnections { connections, suggestions }
}

pub fn save(r: &Runner, ws: Uuid, mut c: DbConnection) -> Result<DbConnection> {
    if c.name.trim().is_empty() {
        bail!("give the connection a name");
    }
    let mut v = load(r, ws);
    if c.id.is_nil() {
        c.id = Uuid::new_v4();
    } else if let Some(old) = v.iter().find(|x| x.id == c.id) {
        // The list hides passwords; saving it back unchanged keeps the real one.
        if c.url == redact(&old.url) {
            c.url = old.url.clone();
        }
    }
    match c.kind {
        DbKind::Postgres if !(c.url.starts_with("postgres://") || c.url.starts_with("postgresql://")) => bail!("a Postgres URL starts with postgres://"),
        DbKind::Mysql if !c.url.starts_with("mysql://") => bail!("a MySQL URL starts with mysql://"),
        _ => {}
    }
    match v.iter_mut().find(|x| x.id == c.id) {
        Some(slot) => *slot = c.clone(),
        None => v.push(c.clone()),
    }
    store::save(&file(r, ws), &v)?;
    r.notice(ws, "dev-db", json!({}));
    c.url = redact(&c.url);
    Ok(c)
}

pub fn delete(r: &Runner, ws: Uuid, id: Uuid) -> Result<()> {
    let mut v = load(r, ws);
    v.retain(|c| c.id != id);
    store::save(&file(r, ws), &v)?;
    r.notice(ws, "dev-db", json!({}));
    Ok(())
}

/// The workspace a connection belongs to, for calls that only name the connection.
pub fn workspace_of(r: &Runner, id: Uuid) -> Option<Uuid> {
    r.workspaces().into_iter().map(|w| w.id).find(|w| load(r, *w).iter().any(|c| c.id == id))
}

fn find(r: &Runner, ws: Uuid, id: Uuid) -> Result<DbConnection> {
    load(r, ws).into_iter().find(|c| c.id == id).context("unknown connection")
}

// ---- the read-only guard -------------------------------------------------------------------

/// SQL with comments and quoted text blanked out, so keywords inside strings do not count.
fn strip(sql: &str) -> String {
    let b: Vec<char> = sql.chars().collect();
    let mut out = String::with_capacity(sql.len());
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        if c == '-' && b.get(i + 1) == Some(&'-') {
            while i < b.len() && b[i] != '\n' {
                i += 1;
            }
            out.push(' ');
        } else if c == '/' && b.get(i + 1) == Some(&'*') {
            i += 2;
            while i < b.len() && !(b[i] == '*' && b.get(i + 1) == Some(&'/')) {
                i += 1;
            }
            i += 2;
            out.push(' ');
        } else if c == '\'' || c == '"' || c == '`' {
            i += 1;
            while i < b.len() {
                if b[i] == c {
                    // Doubled quote = escaped quote.
                    if b.get(i + 1) == Some(&c) {
                        i += 2;
                        continue;
                    }
                    break;
                }
                if b[i] == '\\' && c == '\'' {
                    i += 1;
                }
                i += 1;
            }
            i += 1;
            out.push_str(" x ");
        } else if c == '$' && b.get(i + 1) == Some(&'$') {
            // Postgres dollar quoting.
            i += 2;
            while i < b.len() && !(b[i] == '$' && b.get(i + 1) == Some(&'$')) {
                i += 1;
            }
            i += 2;
            out.push_str(" x ");
        } else {
            out.push(c);
            i += 1;
        }
    }
    out
}

const WRITES: &[&str] = &[
    "INSERT", "UPDATE", "DELETE", "MERGE", "REPLACE", "UPSERT", "CREATE", "DROP", "ALTER", "TRUNCATE", "GRANT", "REVOKE", "ATTACH", "DETACH", "VACUUM",
    "REINDEX", "ANALYZE", "COPY", "CALL", "DO", "LOCK", "SET", "INTO", "COMMIT", "ROLLBACK", "BEGIN", "SAVEPOINT", "RELEASE", "LOAD", "IMPORT", "HANDLER",
    "RENAME", "COMMENT", "CLUSTER", "REFRESH", "NOTIFY", "LISTEN", "UNLISTEN", "DISCARD", "RESET", "SECURITY", "PREPARE", "EXECUTE", "DEALLOCATE",
];
const READS: &[&str] = &["SELECT", "WITH", "EXPLAIN", "PRAGMA", "SHOW", "DESCRIBE", "DESC", "VALUES", "TABLE"];

/// Allow only a single read statement. Returns why not, if not.
pub fn check_read_only(sql: &str) -> Result<(), String> {
    let s = strip(sql);
    let stmts: Vec<&str> = s.split(';').map(str::trim).filter(|x| !x.is_empty()).collect();
    match stmts.len() {
        0 => return Err("nothing to run".into()),
        1 => {}
        _ => return Err("read-only connections run one statement at a time".into()),
    }
    let st = stmts[0];
    let words: Vec<String> = st.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_')).filter(|w| !w.is_empty()).map(|w| w.to_ascii_uppercase()).collect();
    let first = words.first().map(String::as_str).unwrap_or("");
    if !READS.contains(&first) {
        return Err(format!("this connection is read-only; {first} is not a read"));
    }
    if first == "PRAGMA" && st.contains('=') {
        return Err("this connection is read-only; PRAGMA can only read here".into());
    }
    // `EXPLAIN ANALYZE` runs the statement, so it gets the same check as everything else.
    if let Some(w) = words.iter().skip(1).find(|w| WRITES.contains(&w.as_str()) && !(first == "EXPLAIN" && *w == "ANALYZE")) {
        return Err(format!("this connection is read-only; {w} can change data"));
    }
    Ok(())
}

// ---- running queries -------------------------------------------------------------------------

fn cell<'r, R>(row: &'r R, i: usize) -> Value
where
    R: Row,
    usize: ColumnIndex<R>,
    String: Decode<'r, R::Database>,
    Vec<u8>: Decode<'r, R::Database>,
    i64: Decode<'r, R::Database>,
    f64: Decode<'r, R::Database>,
{
    let Ok(raw) = row.try_get_raw(i) else { return Value::Null };
    if raw.is_null() {
        return Value::Null;
    }
    let ty = raw.type_info().name().to_ascii_uppercase();
    drop(raw);
    // SQLite hands over typed values; the others text.
    match ty.as_str() {
        "INTEGER" => return row.try_get_unchecked::<i64, _>(i).map(Value::from).unwrap_or(Value::Null),
        "REAL" => return row.try_get_unchecked::<f64, _>(i).map(Value::from).unwrap_or(Value::Null),
        "BLOB" => {
            let b = row.try_get_unchecked::<Vec<u8>, _>(i).unwrap_or_default();
            return Value::String(match String::from_utf8(b) {
                Ok(s) => s,
                Err(e) => format!("<{} bytes>", e.as_bytes().len()),
            });
        }
        _ => {}
    }
    let s = match row.try_get_unchecked::<String, _>(i) {
        Ok(s) => s,
        Err(_) => return Value::String(format!("<{ty}>")),
    };
    text_value(&ty, s)
}

/// A text-protocol value as JSON, by its column type.
pub fn text_value(ty: &str, s: String) -> Value {
    let base = ty.trim_end_matches(" UNSIGNED");
    match base {
        "INT2" | "INT4" | "INT8" | "TINYINT" | "SMALLINT" | "MEDIUMINT" | "INT" | "BIGINT" | "YEAR" => s.parse::<i64>().map(Value::from).or_else(|_| s.parse::<u64>().map(Value::from)).unwrap_or(Value::String(s)),
        "FLOAT4" | "FLOAT8" | "FLOAT" | "DOUBLE" => s.parse::<f64>().ok().and_then(|f| serde_json::Number::from_f64(f).map(Value::Number)).unwrap_or(Value::String(s)),
        "BOOL" | "BOOLEAN" => match s.as_str() {
            "t" | "true" | "1" => Value::Bool(true),
            "f" | "false" | "0" => Value::Bool(false),
            _ => Value::String(s),
        },
        "JSON" | "JSONB" => serde_json::from_str(&s).unwrap_or(Value::String(s)),
        _ => Value::String(s),
    }
}

/// Rows (fetched up to one past the cap) as columns plus JSON values.
fn table<R>(rows: &[R]) -> (Vec<String>, Vec<Vec<Value>>, bool)
where
    R: Row,
    usize: ColumnIndex<R>,
    for<'r> String: Decode<'r, R::Database>,
    for<'r> Vec<u8>: Decode<'r, R::Database>,
    for<'r> i64: Decode<'r, R::Database>,
    for<'r> f64: Decode<'r, R::Database>,
{
    let columns = rows.first().map(|r| r.columns().iter().map(|c| c.name().to_string()).collect()).unwrap_or_default();
    let truncated = rows.len() > ROW_CAP;
    let out = rows.iter().take(ROW_CAP).map(|row| (0..row.len()).map(|i| cell(row, i)).collect()).collect();
    (columns, out, truncated)
}

fn sqlite_path(r: &Runner, ws: Uuid, url: &str) -> Result<PathBuf> {
    let p = PathBuf::from(url.strip_prefix("sqlite://").or_else(|| url.strip_prefix("sqlite:")).unwrap_or(url));
    let p = if p.is_absolute() { p } else { root(r, ws)?.join(p) };
    if !p.exists() {
        bail!("{} does not exist", p.display());
    }
    Ok(p)
}

/// Run SQL on a connection, honouring its read-only flag.
pub async fn query(r: &Runner, ws: Uuid, conn: Uuid, sql: &str) -> Result<DbRows> {
    let c = find(r, ws, conn)?;
    if c.read_only {
        check_read_only(sql).map_err(anyhow::Error::msg)?;
    }
    let started = Instant::now();
    let mut out = run_on(r, ws, &c, sql).await?;
    out.time_ms = started.elapsed().as_millis() as u64;
    Ok(out)
}

async fn run_on(r: &Runner, ws: Uuid, c: &DbConnection, sql: &str) -> Result<DbRows> {
    let reads = check_read_only(sql).is_ok();
    match c.kind {
        DbKind::Sqlite => {
            let opts = sqlx::sqlite::SqliteConnectOptions::new().filename(sqlite_path(r, ws, &c.url)?).read_only(c.read_only);
            let mut db = sqlx::SqliteConnection::connect_with(&opts).await.context("open the database")?;
            let out = if reads {
                let fetched: Vec<_> = db.fetch(sqlx::raw_sql(sql)).take(ROW_CAP + 1).try_collect().await?;
                let (columns, rows, truncated) = table(&fetched);
                DbRows { columns, rows, truncated, ..Default::default() }
            } else {
                let res = db.execute(sqlx::raw_sql(sql)).await?;
                DbRows { affected: Some(res.rows_affected()), ..Default::default() }
            };
            db.close().await.ok();
            Ok(out)
        }
        DbKind::Postgres => {
            let mut db = sqlx::PgConnection::connect(&c.url).await.context("connect to Postgres")?;
            if c.read_only {
                db.execute(sqlx::raw_sql("BEGIN READ ONLY")).await?;
            }
            let out = if reads {
                let fetched: Vec<_> = db.fetch(sqlx::raw_sql(sql)).take(ROW_CAP + 1).try_collect().await?;
                let (columns, rows, truncated) = table(&fetched);
                DbRows { columns, rows, truncated, ..Default::default() }
            } else {
                let res = db.execute(sqlx::raw_sql(sql)).await?;
                DbRows { affected: Some(res.rows_affected()), ..Default::default() }
            };
            if c.read_only {
                db.execute(sqlx::raw_sql("ROLLBACK")).await.ok();
            }
            db.close().await.ok();
            Ok(out)
        }
        DbKind::Mysql => {
            let mut db = sqlx::MySqlConnection::connect(&c.url).await.context("connect to MySQL")?;
            if c.read_only {
                db.execute(sqlx::raw_sql("START TRANSACTION READ ONLY")).await?;
            }
            let out = if reads {
                let fetched: Vec<_> = db.fetch(sqlx::raw_sql(sql)).take(ROW_CAP + 1).try_collect().await?;
                let (columns, rows, truncated) = table(&fetched);
                DbRows { columns, rows, truncated, ..Default::default() }
            } else {
                let res = db.execute(sqlx::raw_sql(sql)).await?;
                DbRows { affected: Some(res.rows_affected()), ..Default::default() }
            };
            if c.read_only {
                db.execute(sqlx::raw_sql("ROLLBACK")).await.ok();
            }
            db.close().await.ok();
            Ok(out)
        }
    }
}

/// Run SQL the viewer itself writes (listing tables, paging rows): always a read.
async fn internal(r: &Runner, ws: Uuid, c: &DbConnection, sql: &str) -> Result<DbRows> {
    let mut c = c.clone();
    c.read_only = true;
    run_on(r, ws, &c, sql).await
}

pub async fn tables(r: &Runner, ws: Uuid, conn: Uuid) -> Result<Vec<DbTable>> {
    let c = find(r, ws, conn)?;
    let sql = match c.kind {
        DbKind::Sqlite => "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
        DbKind::Postgres => "SELECT CASE WHEN table_schema = 'public' THEN table_name ELSE table_schema || '.' || table_name END, CASE WHEN table_type = 'VIEW' THEN 'view' ELSE 'table' END FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY table_schema <> 'public', 1",
        DbKind::Mysql => "SELECT table_name, CASE WHEN table_type = 'VIEW' THEN 'view' ELSE 'table' END FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY 1",
    };
    let rows = internal(r, ws, &c, sql).await?;
    Ok(rows
        .rows
        .into_iter()
        .filter_map(|row| {
            let name = row.first()?.as_str()?.to_string();
            let kind = row.get(1).and_then(|k| k.as_str()).unwrap_or("table").to_ascii_lowercase();
            Some(DbTable { name, kind })
        })
        .collect())
}

/// `schema.table` quoted for the connection's dialect.
pub fn quote_ident(kind: DbKind, name: &str) -> String {
    let q = if kind == DbKind::Mysql { '`' } else { '"' };
    name.split('.').map(|p| format!("{q}{}{q}", p.replace(q, &format!("{q}{q}")))).collect::<Vec<_>>().join(".")
}

pub async fn rows(r: &Runner, ws: Uuid, conn: Uuid, table: &str, limit: usize, offset: usize, order: Option<DbOrder>) -> Result<DbRows> {
    let c = find(r, ws, conn)?;
    // Only tables the database lists, so the name never carries SQL of its own.
    if !tables(r, ws, conn).await?.iter().any(|t| t.name == table) {
        bail!("unknown table {table}");
    }
    let t = quote_ident(c.kind, table);
    let limit = limit.clamp(1, ROW_CAP);
    let mut sql = format!("SELECT * FROM {t}");
    if let Some(o) = order.filter(|o| !o.column.is_empty()) {
        // Column names are quoted, never spliced raw.
        let col = if c.kind == DbKind::Mysql { format!("`{}`", o.column.replace('`', "``")) } else { format!("\"{}\"", o.column.replace('"', "\"\"")) };
        sql.push_str(&format!(" ORDER BY {col} {}", if o.desc { "DESC" } else { "ASC" }));
    }
    sql.push_str(&format!(" LIMIT {limit} OFFSET {offset}"));
    let started = Instant::now();
    let mut out = internal(r, ws, &c, &sql).await?;
    if out.columns.is_empty() {
        // An empty table still has columns.
        let probe = match c.kind {
            DbKind::Sqlite => format!("SELECT name FROM pragma_table_info('{}')", table.replace('\'', "''")),
            _ => {
                let (schema, name) = table.split_once('.').map(|(s, n)| (format!("'{}'", s.replace('\'', "''")), n)).unwrap_or_else(|| {
                    (if c.kind == DbKind::Mysql { "DATABASE()".into() } else { "'public'".into() }, table)
                });
                format!("SELECT column_name FROM information_schema.columns WHERE table_schema = {schema} AND table_name = '{}' ORDER BY ordinal_position", name.replace('\'', "''"))
            }
        };
        if let Ok(p) = internal(r, ws, &c, &probe).await {
            out.columns = p.rows.into_iter().filter_map(|r| r.first().and_then(|v| v.as_str().map(String::from))).collect();
        }
    }
    let count = internal(r, ws, &c, &format!("SELECT COUNT(*) FROM {t}")).await?;
    out.total = count.rows.first().and_then(|r| r.first()).and_then(|v| v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse().ok())));
    out.time_ms = started.elapsed().as_millis() as u64;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_only_guard_allows_reads() {
        for ok in [
            "SELECT * FROM users",
            "  select id from t where name = 'DROP TABLE x';",
            "WITH a AS (SELECT 1) SELECT * FROM a",
            "EXPLAIN QUERY PLAN SELECT * FROM t",
            "EXPLAIN ANALYZE SELECT * FROM t",
            "PRAGMA table_info(users)",
            "-- a comment\nSELECT 1 /* update */",
            "SELECT \"update\" FROM t",
            "SHOW TABLES",
        ] {
            assert!(check_read_only(ok).is_ok(), "{ok}: {:?}", check_read_only(ok));
        }
    }

    #[test]
    fn read_only_guard_refuses_writes() {
        for bad in [
            "DELETE FROM users",
            "update users set a = 1",
            "INSERT INTO t VALUES (1)",
            "DROP TABLE t",
            "SELECT 1; DELETE FROM t",
            "WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x",
            "SELECT * INTO backup FROM users",
            "PRAGMA journal_mode = WAL",
            "EXPLAIN ANALYZE DELETE FROM t",
            "SELECT * FROM t FOR UPDATE",
            "ATTACH DATABASE 'x.db' AS x",
            "",
            "-- only a comment",
        ] {
            assert!(check_read_only(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn redacts_passwords() {
        assert_eq!(redact("postgres://me:secret@db:5432/app"), "postgres://me:****@db:5432/app");
        assert_eq!(redact("postgres://me@db/app"), "postgres://me@db/app");
        assert_eq!(redact("app.db"), "app.db");
    }

    #[test]
    fn quotes_identifiers() {
        assert_eq!(quote_ident(DbKind::Postgres, "audit.log"), "\"audit\".\"log\"");
        assert_eq!(quote_ident(DbKind::Sqlite, "we\"ird"), "\"we\"\"ird\"");
        assert_eq!(quote_ident(DbKind::Mysql, "users"), "`users`");
    }

    #[test]
    fn text_values_by_type() {
        assert_eq!(text_value("INT4", "42".into()), json!(42));
        assert_eq!(text_value("BIGINT UNSIGNED", "18446744073709551615".into()), json!(18446744073709551615u64));
        assert_eq!(text_value("BOOL", "t".into()), json!(true));
        assert_eq!(text_value("JSONB", "{\"a\":1}".into()), json!({"a": 1}));
        assert_eq!(text_value("NUMERIC", "1.10".into()), json!("1.10"));
    }

    #[tokio::test]
    async fn sqlite_end_to_end() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("app");
        std::fs::create_dir_all(&root).unwrap();
        {
            let opts = sqlx::sqlite::SqliteConnectOptions::new().filename(root.join("app.db")).create_if_missing(true);
            let mut db = sqlx::SqliteConnection::connect_with(&opts).await.unwrap();
            sqlx::raw_sql("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, score REAL, avatar BLOB); INSERT INTO users (name, score) VALUES ('Maya', 9.5), ('Jonas', NULL);")
                .execute(&mut db)
                .await
                .unwrap();
            for i in 0..1005 {
                sqlx::raw_sql(&format!("INSERT INTO users (name) VALUES ('u{i}')")).execute(&mut db).await.unwrap();
            }
        }
        let r = Runner::open(dir.path().join("data")).unwrap();
        let ws = r.create_workspace("App".into(), Some(root.to_string_lossy().into())).unwrap();
        let l = list(&r, ws.id);
        assert_eq!(l.suggestions, ["app.db"]);
        let c = save(&r, ws.id, DbConnection { id: Uuid::nil(), name: "App".into(), kind: DbKind::Sqlite, url: "app.db".into(), read_only: true }).unwrap();
        assert!(list(&r, ws.id).suggestions.is_empty());
        assert_eq!(workspace_of(&r, c.id), Some(ws.id));

        let t = tables(&r, ws.id, c.id).await.unwrap();
        assert_eq!(t.len(), 1);
        assert_eq!(t[0].name, "users");

        let page = rows(&r, ws.id, c.id, "users", 2, 0, Some(DbOrder { column: "id".into(), desc: false })).await.unwrap();
        assert_eq!(page.columns, ["id", "name", "score", "avatar"]);
        assert_eq!(page.rows[0], vec![json!(1), json!("Maya"), json!(9.5), Value::Null]);
        assert_eq!(page.total, Some(1007));

        let all = query(&r, ws.id, c.id, "SELECT * FROM users").await.unwrap();
        assert_eq!(all.rows.len(), ROW_CAP);
        assert!(all.truncated);

        assert!(query(&r, ws.id, c.id, "DELETE FROM users").await.is_err());
        assert!(rows(&r, ws.id, c.id, "users; DROP TABLE users", 10, 0, None).await.is_err());

        let mut w = c.clone();
        w.read_only = false;
        save(&r, ws.id, w).unwrap();
        let res = query(&r, ws.id, c.id, "DELETE FROM users WHERE name = 'Jonas'").await.unwrap();
        assert_eq!(res.affected, Some(1));
    }
}
