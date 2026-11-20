// Formula engine tests. Run from apps/desktop:
//   node --experimental-strip-types src/components/office/formula.test.ts
// (Imported by path at runtime so the app's tsconfig, which has no `.ts`
// import extensions, still type-checks this file.)

const F: typeof import("./formula") = await import("./formula" + ".ts");
const C: typeof import("./cron") = await import("./cron" + ".ts");
const D: typeof import("./dbview") = await import("./dbview" + ".ts");

let failed = 0;
let passed = 0;
function eq(actual: unknown, expected: unknown, what: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) passed++;
  else {
    failed++;
    console.error(`FAIL ${what}: got ${a}, want ${e}`);
  }
}

type Cells = Record<string, import("./formula").Cell>;
const sheet = (cells: Record<string, string | number>): Cells => {
  const out: Cells = {};
  for (const [k, v] of Object.entries(cells)) out[k] = typeof v === "string" && v.startsWith("=") ? { v: "", f: v } : { v };
  return out;
};
const val = (cells: Cells, a: string) => {
  const v = F.evaluate(cells).get(a);
  return v instanceof F.FErr ? v.code : v;
};

// arithmetic and precedence
eq(val(sheet({ A1: "=1+2*3" }), "A1"), 7, "precedence");
eq(val(sheet({ A1: "=(1+2)*3" }), "A1"), 9, "parens");
eq(val(sheet({ A1: "=2^3^2" }), "A1"), 512, "power right-assoc");
eq(val(sheet({ A1: "=-2^2" }), "A1"), 4, "unary binds tighter");
eq(val(sheet({ A1: "=10/4" }), "A1"), 2.5, "division");
eq(val(sheet({ A1: "=50%" }), "A1"), 0.5, "percent");
eq(val(sheet({ A1: '="a"&"b"&1' }), "A1"), "ab1", "concat op");

// comparison
eq(val(sheet({ A1: "=1<2" }), "A1"), true, "lt");
eq(val(sheet({ A1: "=2<>2" }), "A1"), false, "neq");
eq(val(sheet({ A1: '="abc"="ABC"' }), "A1"), true, "case-insensitive text eq");
eq(val(sheet({ A1: "=3>=3" }), "A1"), true, "gte");

// references
const s1 = sheet({ A1: 2, A2: 3, A3: "=A1*A2", B1: "=A3+$A$1", B2: "=SUM(A1:A3)" });
eq(val(s1, "A3"), 6, "ref");
eq(val(s1, "B1"), 8, "absolute ref");
eq(val(s1, "B2"), 11, "range sum");
eq(val(sheet({ A1: "=Z99" }), "A1"), 0, "empty ref is 0");

// functions
const s2 = sheet({ A1: 4, A2: 8, A3: "x", A4: "", B1: "=AVERAGE(A1:A4)", B2: "=MIN(A1:A2)", B3: "=MAX(A1:A2,10)", B4: "=COUNT(A1:A4)", B5: "=COUNTA(A1:A4)" });
eq(val(s2, "B1"), 6, "AVERAGE skips text");
eq(val(s2, "B2"), 4, "MIN");
eq(val(s2, "B3"), 10, "MAX with scalar");
eq(val(s2, "B4"), 2, "COUNT");
eq(val(s2, "B5"), 3, "COUNTA");
eq(val(sheet({ A1: '=IF(1>2,"yes","no")' }), "A1"), "no", "IF");
eq(val(sheet({ A1: "=IF(1<2,1/1,1/0)" }), "A1"), 1, "IF is lazy");
eq(val(sheet({ A1: "=AND(TRUE,1>0)", A2: "=OR(FALSE,0)" }), "A1"), true, "AND");
eq(val(sheet({ A2: "=OR(FALSE,0)" }), "A2"), false, "OR");
eq(val(sheet({ A1: "=ROUND(2.345,2)" }), "A1"), 2.35, "ROUND");
eq(val(sheet({ A1: "=ROUND(-2.5)" }), "A1"), -3, "ROUND away from zero");
eq(val(sheet({ A1: "=ABS(-3)" }), "A1"), 3, "ABS");
eq(val(sheet({ A1: 'x', A2: '=CONCAT(A1,"-",2)' }), "A2"), "x-2", "CONCAT");
eq(val(sheet({ A1: '=LEN("hello")' }), "A1"), 5, "LEN");
eq(val(sheet({ A1: '=UPPER("ab")&LOWER("CD")' }), "A1"), "ABcd", "UPPER/LOWER");
eq(typeof val(sheet({ A1: "=TODAY()" }), "A1"), "number", "TODAY is a serial");
eq(F.serialToIso(F.dateSerial(new Date(2026, 10, 20))), "2026-11-20", "date serial roundtrip");

// VLOOKUP
const s3 = sheet({ A1: 1, B1: "one", A2: 2, B2: "two", A3: 5, B3: "five", C1: "=VLOOKUP(2,A1:B3,2,FALSE)", C2: "=VLOOKUP(4,A1:B3,2)", C3: "=VLOOKUP(9,A1:B3,2,FALSE)", C4: "=VLOOKUP(1,A1:B3,3,FALSE)" });
eq(val(s3, "C1"), "two", "VLOOKUP exact");
eq(val(s3, "C2"), "two", "VLOOKUP approximate");
eq(val(s3, "C3"), "#N/A", "VLOOKUP miss");
eq(val(s3, "C4"), "#REF!", "VLOOKUP column out of range");

// errors
eq(val(sheet({ A1: "=1/0" }), "A1"), "#DIV/0!", "div by zero");
eq(val(sheet({ A1: "=FOO(1)" }), "A1"), "#NAME?", "unknown function");
eq(val(sheet({ A1: "=foo" }), "A1"), "#NAME?", "unknown name");
eq(val(sheet({ A1: "=1+" }), "A1"), "#ERROR!", "parse error");
eq(val(sheet({ A1: '="a"+1' }), "A1"), "#VALUE!", "text in arithmetic");
eq(val(sheet({ A1: "=A1+1" }), "A1"), "#REF!", "self cycle");
const cyc = sheet({ A1: "=B1", B1: "=C1", C1: "=A1", D1: "=A1+1" });
eq([val(cyc, "A1"), val(cyc, "B1"), val(cyc, "C1"), val(cyc, "D1")], ["#REF!", "#REF!", "#REF!", "#REF!"], "indirect cycle");
eq(val(sheet({ A1: "=1/0", A2: "=A1+1" }), "A2"), "#DIV/0!", "errors propagate");

// input and display
eq(F.parseInput("12"), { v: 12 }, "input number");
eq(F.parseInput("1.234,5"), { v: 1234.5 }, "input european number");
eq(F.parseInput("15%"), { v: 0.15, fmt: { n: "percent" } }, "input percent");
eq(F.parseInput("€ 20"), { v: 20, fmt: { n: "eur" } }, "input euro");
eq(F.parseInput("$5"), { v: 5, fmt: { n: "usd" } }, "input dollar");
eq(F.parseInput("=A1"), { v: "", f: "=A1" }, "input formula");
eq(F.parseInput("hello"), { v: "hello" }, "input text");
eq(F.parseInput("  "), null, "input empty");
eq(F.formatValue(0.256, { n: "percent" }), "25.6%", "format percent");
eq(F.formatValue(1234.5, { n: "usd" }), "$1,234.50", "format usd");
eq(F.colName(0) + F.colName(25) + F.colName(26) + F.colName(51), "AZAAAZ", "column names");
eq(F.parseAddr("AZ10"), { c: 51, r: 9 }, "parse address");
eq(F.parseDelimited('a,"b,c"\n"q""x",2\n', ","), [["a", "b,c"], ['q"x', "2"]], "csv parse");
eq(F.toDelimited([["a", "b,c"]], ","), 'a,"b,c"', "csv write");

// cron
const from = new Date(2026, 10, 20, 10, 0); // Fri 20 Nov 2026 10:00 local
const next = C.nextRuns("30 9 * * 1-5", from, new Date(2026, 10, 27, 0, 0));
eq(next.map((d) => `${d.getDate()} ${d.getHours()}:${d.getMinutes()}`), ["23 9:30", "24 9:30", "25 9:30", "26 9:30"], "cron weekdays");
eq(C.nextRuns("0 */6 * * *", from, new Date(2026, 10, 21, 0, 0)).map((d) => d.getHours()), [12, 18], "cron steps");
eq(C.nextRuns("bad", from, new Date(2026, 10, 21)).length, 0, "cron invalid");

// database views
const schema = {
  name: { id: "name", name: "Name", type: "text", order: 0 },
  n: { id: "n", name: "N", type: "number", order: 1 },
  s: { id: "s", name: "S", type: "select", order: 2, options: [{ id: "a", name: "A", color: "blue" }] },
} as const;
const rows = [
  { id: "1", name: "Beta", n: 2, s: "a" },
  { id: "2", name: "alpha", n: 10 },
  { id: "3", name: "Gamma", n: 5, s: "a" },
];
const view = { id: "v", name: "T", type: "table" as const, filters: [{ field: "s", op: "is" as const, value: "a" }], sorts: [{ field: "n", desc: true }] };
eq(D.applyView(rows, schema as never, view).map((r) => r.id), ["3", "1"], "filter and sort");
eq(D.applyView(rows, schema as never, { ...view, filters: [], sorts: [{ field: "name", desc: false }] }).map((r) => r.id), ["2", "1", "3"], "sort text");
eq(D.applyView(rows, schema as never, { ...view, filters: [{ field: "name", op: "contains", value: "MM" }], sorts: [] }).map((r) => r.id), ["3"], "contains");

console.log(`${passed} passed, ${failed} failed`);
if (failed) throw new Error(`${failed} failed`);
export {};
