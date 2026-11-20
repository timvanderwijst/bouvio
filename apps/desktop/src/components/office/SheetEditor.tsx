import { AlignCenter, AlignLeft, AlignRight, Bold, FileDown, FileUp, Printer } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as Y from "yjs";
import { getLang, t, useT } from "../../i18n";
import { Menu } from "../Menu";
import { download, fileSafe, printOnly } from "./common";
import type { EditorProps } from "./DocPage";
import { FErr, addr, colName, editText, evaluate, formatValue, parseDelimited, parseInput, toDelimited, type Cell, type Fmt, type Value } from "./formula";
import { useYVersion } from "./sync";

const ROWS = 1000;
const COLS = 52;
const ROW_H = 26;
const HEAD_W = 46;
const COL_W = 104;

type Pos = { c: number; r: number };
const clamp = (p: Pos): Pos => ({ c: Math.max(0, Math.min(COLS - 1, p.c)), r: Math.max(0, Math.min(ROWS - 1, p.r)) });

function rect(a: Pos, b: Pos) {
  return { c0: Math.min(a.c, b.c), c1: Math.max(a.c, b.c), r0: Math.min(a.r, b.r), r1: Math.max(a.r, b.r) };
}

export function SheetEditor({ doc, session, setActions }: EditorProps) {
  const tr = useT();
  const cellsMap = useMemo(() => session.ydoc.getMap<Cell>("cells"), [session]);
  const colsMap = useMemo(() => session.ydoc.getMap<number>("cols"), [session]);
  const undo = useMemo(() => new Y.UndoManager([cellsMap, colsMap]), [cellsMap, colsMap]);
  useEffect(() => () => undo.destroy(), [undo]);
  const v1 = useYVersion(cellsMap);
  const v2 = useYVersion(colsMap);
  const cells = useMemo(() => cellsMap.toJSON() as Record<string, Cell>, [cellsMap, v1]);
  const sheet = useMemo(() => evaluate(cells, ROWS, COLS), [cells]);
  const [dragW, setDragW] = useState<{ c: number; w: number } | null>(null);
  const widths = useMemo(() => {
    const w: number[] = [];
    for (let c = 0; c < COLS; c++) w.push(dragW?.c === c ? dragW.w : (colsMap.get(colName(c)) ?? COL_W));
    return w;
  }, [colsMap, v2, dragW]);
  const lefts = useMemo(() => {
    const l = [0];
    for (const w of widths) l.push(l[l.length - 1] + w);
    return l;
  }, [widths]);

  const [sel, setSel] = useState<Pos>({ c: 0, r: 0 });
  const [anchor, setAnchor] = useState<Pos>({ c: 0, r: 0 });
  const [edit, setEdit] = useState<{ text: string; inBar: boolean } | null>(null);
  const [scroll, setScroll] = useState({ x: 0, y: 0, w: 800, h: 600 });
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const lang = getLang();

  const range = rect(sel, anchor);
  const activeAddr = addr(sel.c, sel.r);
  const active = cells[activeAddr];

  // Keep the visible window in sync with the scroll box.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setScroll({ x: el.scrollLeft, y: el.scrollTop, w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const r0 = Math.max(0, Math.floor(scroll.y / ROW_H) - 4);
  const r1 = Math.min(ROWS - 1, Math.ceil((scroll.y + scroll.h) / ROW_H) + 4);
  let c0 = 0;
  while (c0 < COLS - 1 && lefts[c0 + 1] < scroll.x) c0++;
  let c1 = c0;
  while (c1 < COLS - 1 && lefts[c1] < scroll.x + scroll.w) c1++;

  const write = useCallback(
    (f: () => void) => {
      session.ydoc.transact(f);
    },
    [session],
  );

  const commit = (text: string, move?: Pos) => {
    const next = parseInput(text, active?.fmt);
    write(() => {
      if (next) cellsMap.set(activeAddr, next);
      else if (active?.fmt) cellsMap.set(activeAddr, { v: null, fmt: active.fmt });
      else cellsMap.delete(activeAddr);
    });
    setEdit(null);
    if (move) go(move, false);
    scrollRef.current?.focus();
  };

  const go = (p: Pos, extend: boolean) => {
    const n = clamp(p);
    setSel(n);
    if (!extend) setAnchor(n);
    // Keep the active cell in view.
    const el = scrollRef.current;
    if (!el) return;
    const top = n.r * ROW_H;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight;
    if (lefts[n.c] < el.scrollLeft) el.scrollLeft = lefts[n.c];
    else if (lefts[n.c + 1] > el.scrollLeft + el.clientWidth) el.scrollLeft = lefts[n.c + 1] - el.clientWidth;
  };

  const forRange = (f: (a: string, cell: Cell | undefined) => void) => {
    write(() => {
      for (let r = range.r0; r <= range.r1; r++)
        for (let c = range.c0; c <= range.c1; c++) {
          const a = addr(c, r);
          f(a, cellsMap.get(a));
        }
    });
  };

  const setFmt = (patch: Partial<Fmt>) =>
    forRange((a, cell) => {
      const fmt = { ...cell?.fmt, ...patch };
      for (const k of Object.keys(fmt) as (keyof Fmt)[]) if (fmt[k] === undefined || fmt[k] === false) delete fmt[k];
      cellsMap.set(a, { ...(cell ?? { v: null }), fmt });
    });

  const clear = () => forRange((a, cell) => (cell?.fmt ? cellsMap.set(a, { v: null, fmt: cell.fmt }) : cellsMap.delete(a)));

  const onKey = (e: React.KeyboardEvent) => {
    if (edit) return;
    const mod = e.metaKey || e.ctrlKey;
    const step = (dc: number, dr: number) => {
      e.preventDefault();
      const from = e.shiftKey ? sel : sel;
      const jump = mod ? (dr ? (dr > 0 ? ROWS : -ROWS) : dc > 0 ? COLS : -COLS) : 1;
      go({ c: from.c + dc * jump, r: from.r + dr * jump }, e.shiftKey);
    };
    if (e.key === "ArrowDown") step(0, 1);
    else if (e.key === "ArrowUp") step(0, -1);
    else if (e.key === "ArrowLeft") step(-1, 0);
    else if (e.key === "ArrowRight") step(1, 0);
    else if (e.key === "Tab") {
      e.preventDefault();
      go({ c: sel.c + (e.shiftKey ? -1 : 1), r: sel.r }, false);
    } else if (e.key === "Enter" || e.key === "F2") {
      e.preventDefault();
      setEdit({ text: editText(active), inBar: false });
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      clear();
    } else if (mod && e.key.toLowerCase() === "b") {
      e.preventDefault();
      setFmt({ b: !active?.fmt?.b });
    } else if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) undo.redo();
      else undo.undo();
    } else if (mod && e.key.toLowerCase() === "y") {
      e.preventDefault();
      undo.redo();
    } else if (mod && e.key.toLowerCase() === "a") {
      e.preventDefault();
      setAnchor({ c: 0, r: 0 });
      setSel({ c: COLS - 1, r: ROWS - 1 });
    } else if (e.key.length === 1 && !mod && !e.altKey) {
      e.preventDefault();
      setEdit({ text: e.key, inBar: false });
    }
  };

  const shown = (v: Value) => (v instanceof FErr ? v.code : v === null ? "" : typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : String(v));

  const onCopy = (e: React.ClipboardEvent) => {
    if (edit) return;
    e.preventDefault();
    const rows: string[][] = [];
    for (let r = range.r0; r <= range.r1; r++) {
      const row: string[] = [];
      for (let c = range.c0; c <= range.c1; c++) row.push(shown(sheet.get(addr(c, r))));
      rows.push(row);
    }
    e.clipboardData.setData("text/plain", rows.map((r) => r.join("\t")).join("\n"));
  };

  const onPaste = (e: React.ClipboardEvent) => {
    if (edit) return;
    e.preventDefault();
    const text = e.clipboardData.getData("text/plain").replace(/\n$/, "");
    if (!text) return;
    const grid = parseDelimited(text, text.includes("\t") ? "\t" : ",");
    write(() => {
      grid.forEach((row, dr) =>
        row.forEach((s, dc) => {
          const p = { c: sel.c + dc, r: sel.r + dr };
          if (p.c >= COLS || p.r >= ROWS) return;
          const a = addr(p.c, p.r);
          const next = parseInput(s, cellsMap.get(a)?.fmt);
          if (next) cellsMap.set(a, next);
          else cellsMap.delete(a);
        }),
      );
    });
    setAnchor(sel);
    setSel(clamp({ c: sel.c + (grid[0]?.length ?? 1) - 1, r: sel.r + grid.length - 1 }));
  };

  const exportCsv = useCallback(() => {
    const all = cellsMap.toJSON() as Record<string, Cell>;
    const s = evaluate(all, ROWS, COLS);
    let maxR = -1;
    let maxC = -1;
    for (const k of Object.keys(all)) {
      const m = /^([A-Z]+)(\d+)$/.exec(k);
      if (!m) continue;
      const cc = [...m[1]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
      maxC = Math.max(maxC, cc);
      maxR = Math.max(maxR, Number(m[2]) - 1);
    }
    const rows: string[][] = [];
    for (let r = 0; r <= maxR; r++) {
      const row: string[] = [];
      for (let c = 0; c <= maxC; c++) row.push(shown(s.get(addr(c, r))));
      rows.push(row);
    }
    download(`${fileSafe(doc.title)}.csv`, toDelimited(rows, ","), "text/csv");
  }, [cellsMap, doc.title]);

  const fileRef = useRef<HTMLInputElement>(null);
  const importCsv = async (f: File) => {
    const text = await f.text();
    const first = text.split("\n")[0] ?? "";
    const sep = first.includes("\t") ? "\t" : first.split(";").length > first.split(",").length ? ";" : ",";
    const grid = parseDelimited(text, sep);
    if (cellsMap.size && !window.confirm(t("office.sheet.replace"))) return;
    write(() => {
      cellsMap.clear();
      grid.slice(0, ROWS).forEach((row, r) =>
        row.slice(0, COLS).forEach((s, c) => {
          const next = parseInput(s);
          if (next) cellsMap.set(addr(c, r), next);
        }),
      );
    });
  };

  useEffect(() => {
    setActions([
      { id: "csv", label: t("office.exportCsv"), icon: <FileDown size={14} />, run: exportCsv },
      { id: "import", label: t("office.importCsv"), icon: <FileUp size={14} />, run: () => fileRef.current?.click() },
      { id: "pdf", label: t("office.printPdf"), icon: <Printer size={14} />, run: printOnly },
    ]);
  }, [exportCsv, setActions]);

  const startResize = (c: number, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX;
    const w0 = widths[c];
    let w = w0;
    const move = (m: MouseEvent) => {
      w = Math.max(40, Math.min(600, w0 + m.clientX - x0));
      setDragW({ c, w });
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      if (w !== w0) colsMap.set(colName(c), Math.round(w));
      setDragW(null);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  useEffect(() => {
    const up = () => (dragging.current = false);
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);

  const fmtItems = [
    { value: "general", label: tr("office.sheet.general") },
    { value: "number", label: tr("office.sheet.number"), hint: "1,234.50" },
    { value: "percent", label: tr("office.sheet.percent"), hint: "12%" },
    { value: "eur", label: tr("office.sheet.eur"), hint: "€" },
    { value: "usd", label: tr("office.sheet.usd"), hint: "$" },
    { value: "date", label: tr("office.sheet.date"), hint: "2026-11-20" },
  ];

  const visibleCells = [];
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const a = addr(c, r);
      const cell = cells[a];
      if (!cell) continue;
      const v = sheet.get(a);
      const align = cell.fmt?.a ?? (typeof v === "number" ? "right" : typeof v === "boolean" ? "center" : "left");
      visibleCells.push(
        <div
          key={a}
          className={`sheet-cell ${cell.fmt?.b ? "b" : ""} ${v instanceof FErr ? "err" : ""} a-${align}`}
          style={{ left: lefts[c], top: r * ROW_H, width: widths[c], height: ROW_H }}
          title={v instanceof FErr ? cell.f : undefined}
        >
          {formatValue(v, cell.fmt, lang)}
        </div>,
      );
    }
  }

  const cellAt = (e: React.MouseEvent): Pos => {
    const box = scrollRef.current!.getBoundingClientRect();
    const x = e.clientX - box.left + scrollRef.current!.scrollLeft;
    const y = e.clientY - box.top + scrollRef.current!.scrollTop;
    let c = 0;
    while (c < COLS - 1 && lefts[c + 1] <= x) c++;
    return clamp({ c, r: Math.floor(y / ROW_H) });
  };

  const selBox = { left: lefts[range.c0], top: range.r0 * ROW_H, width: lefts[range.c1 + 1] - lefts[range.c0], height: (range.r1 - range.r0 + 1) * ROW_H };
  const multi = range.c0 !== range.c1 || range.r0 !== range.r1;
  const rangeLabel = multi ? `${addr(range.c0, range.r0)}:${addr(range.c1, range.r1)}` : activeAddr;

  return (
    <div className="sheet-ed">
      <div className="sheet-tools">
        <button className={`icon-btn ${active?.fmt?.b ? "on" : ""}`} title={tr("office.fmt.bold")} onClick={() => setFmt({ b: !active?.fmt?.b })}>
          <Bold size={15} />
        </button>
        <span className="office-tools-sep" />
        {(["left", "center", "right"] as const).map((a) => {
          const I = a === "left" ? AlignLeft : a === "center" ? AlignCenter : AlignRight;
          return (
            <button key={a} className={`icon-btn ${active?.fmt?.a === a ? "on" : ""}`} title={tr(`office.sheet.align.${a}`)} onClick={() => setFmt({ a: active?.fmt?.a === a ? undefined : a })}>
              <I size={15} />
            </button>
          );
        })}
        <span className="office-tools-sep" />
        <Menu value={active?.fmt?.n ?? "general"} items={fmtItems} onChange={(n) => setFmt({ n: n === "general" ? undefined : (n as Fmt["n"]) })} />
        <input ref={fileRef} type="file" accept=".csv,.tsv,text/csv" hidden onChange={(e) => e.target.files?.[0] && importCsv(e.target.files[0]).finally(() => (e.target.value = ""))} />
      </div>
      <div className="sheet-bar">
        <span className="sheet-addr mono">{rangeLabel}</span>
        <span className="sheet-fx">fx</span>
        <input
          className="sheet-formula mono"
          value={edit ? edit.text : editText(active)}
          onFocus={() => !edit && setEdit({ text: editText(active), inBar: true })}
          onChange={(e) => setEdit({ text: e.target.value, inBar: true })}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit(edit?.text ?? "", { c: sel.c, r: sel.r + 1 });
            if (e.key === "Escape") {
              setEdit(null);
              scrollRef.current?.focus();
            }
          }}
          onBlur={() => edit?.inBar && commit(edit.text)}
          spellCheck={false}
        />
      </div>
      <div className="sheet-grid">
        <div className="sheet-corner" style={{ width: HEAD_W, height: ROW_H }} />
        <div className="sheet-colheads" style={{ left: HEAD_W, height: ROW_H }}>
          <div style={{ transform: `translateX(${-scroll.x}px)` }}>
            {Array.from({ length: c1 - c0 + 1 }, (_, i) => c0 + i).map((c) => (
              <div
                key={c}
                className={`sheet-colhead ${c >= range.c0 && c <= range.c1 ? "on" : ""}`}
                style={{ left: lefts[c], width: widths[c], height: ROW_H }}
                onMouseDown={(e) => {
                  setAnchor({ c, r: 0 });
                  setSel({ c: e.shiftKey ? sel.c : c, r: ROWS - 1 });
                  scrollRef.current?.focus();
                }}
              >
                {colName(c)}
                <span className="sheet-resize" onMouseDown={(e) => startResize(c, e)} />
              </div>
            ))}
          </div>
        </div>
        <div className="sheet-rowheads" style={{ top: ROW_H, width: HEAD_W }}>
          <div style={{ transform: `translateY(${-scroll.y}px)` }}>
            {Array.from({ length: r1 - r0 + 1 }, (_, i) => r0 + i).map((r) => (
              <div
                key={r}
                className={`sheet-rowhead ${r >= range.r0 && r <= range.r1 ? "on" : ""}`}
                style={{ top: r * ROW_H, height: ROW_H, width: HEAD_W }}
                onMouseDown={() => {
                  setAnchor({ c: 0, r });
                  setSel({ c: COLS - 1, r });
                  scrollRef.current?.focus();
                }}
              >
                {r + 1}
              </div>
            ))}
          </div>
        </div>
        <div
          ref={scrollRef}
          className="sheet-scroll"
          style={{ left: HEAD_W, top: ROW_H }}
          tabIndex={0}
          onScroll={(e) => {
            const el = e.currentTarget;
            setScroll({ x: el.scrollLeft, y: el.scrollTop, w: el.clientWidth, h: el.clientHeight });
          }}
          onKeyDown={onKey}
          onCopy={onCopy}
          onPaste={onPaste}
          onMouseDown={(e) => {
            if ((e.target as HTMLElement).closest(".sheet-editor")) return;
            if (edit) commit(edit.text);
            const p = cellAt(e);
            dragging.current = true;
            if (e.shiftKey) setSel(p);
            else {
              setSel(p);
              setAnchor(p);
            }
          }}
          onMouseMove={(e) => {
            if (dragging.current && e.buttons === 1) setSel(cellAt(e));
          }}
          onDoubleClick={(e) => {
            if ((e.target as HTMLElement).closest(".sheet-editor")) return;
            setEdit({ text: editText(cells[addr(cellAt(e).c, cellAt(e).r)]), inBar: false });
          }}
        >
          <div className="sheet-inner" style={{ width: lefts[COLS], height: ROWS * ROW_H }}>
            {Array.from({ length: c1 - c0 + 1 }, (_, i) => c0 + i).map((c) => (
              <div key={c} className="sheet-vline" style={{ left: lefts[c + 1] - 1, top: r0 * ROW_H, height: (r1 - r0 + 1) * ROW_H }} />
            ))}
            {visibleCells}
            <div className={`sheet-sel ${multi ? "multi" : ""}`} style={selBox} />
            <div className="sheet-active" style={{ left: lefts[sel.c], top: sel.r * ROW_H, width: widths[sel.c], height: ROW_H }} />
            {edit && !edit.inBar && (
              <input
                className="sheet-editor"
                autoFocus
                style={{ left: lefts[sel.c], top: sel.r * ROW_H, minWidth: widths[sel.c], height: ROW_H }}
                value={edit.text}
                spellCheck={false}
                onChange={(e) => setEdit({ text: e.target.value, inBar: false })}
                onFocus={(e) => e.target.setSelectionRange(e.target.value.length, e.target.value.length)}
                onBlur={() => edit && commit(edit.text)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commit(edit.text, { c: sel.c, r: sel.r + (e.shiftKey ? -1 : 1) });
                  } else if (e.key === "Tab") {
                    e.preventDefault();
                    commit(edit.text, { c: sel.c + (e.shiftKey ? -1 : 1), r: sel.r });
                  } else if (e.key === "Escape") {
                    setEdit(null);
                    scrollRef.current?.focus();
                  }
                }}
              />
            )}
          </div>
        </div>
      </div>
      <SheetPrint cells={cells} sheet={sheet} widths={widths} />
    </div>
  );
}

/** A plain table of the used range, only for printing. */
function SheetPrint({ cells, sheet, widths }: { cells: Record<string, Cell>; sheet: ReturnType<typeof evaluate>; widths: number[] }) {
  const lang = getLang();
  let maxR = -1;
  let maxC = -1;
  for (const k of Object.keys(cells)) {
    const m = /^([A-Z]+)(\d+)$/.exec(k);
    if (!m) continue;
    maxC = Math.max(maxC, [...m[1]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1);
    maxR = Math.max(maxR, Number(m[2]) - 1);
  }
  if (maxR < 0) return null;
  return (
    <table className="sheet-print office-print office-print-only">
      <tbody>
        {Array.from({ length: maxR + 1 }, (_, r) => (
          <tr key={r}>
            {Array.from({ length: maxC + 1 }, (_, c) => {
              const cell = cells[addr(c, r)];
              const v = sheet.get(addr(c, r));
              return (
                <td key={c} style={{ width: widths[c], textAlign: cell?.fmt?.a ?? (typeof v === "number" ? "right" : "left"), fontWeight: cell?.fmt?.b ? 600 : undefined }}>
                  {formatValue(v, cell?.fmt, lang)}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
