// Natural date parsing for quick add. Run from apps/desktop:
//   node src/components/personal/dates.test.mjs
// (Node 22.18+ strips the types from dates.ts by itself.)
import assert from "node:assert/strict";
import { daysUntil, parseQuickAdd } from "./dates.ts";

const fri = new Date(2026, 10, 20); // Friday 20 Nov 2026
const q = (s, today = fri) => parseQuickAdd(s, today);
const cases = [
  ["Call Jordan today", { title: "Call Jordan", due: "2026-11-20", priority: null }],
  ["Call Jordan tomorrow", { title: "Call Jordan", due: "2026-11-21", priority: null }],
  ["Review hub PR tmr !!", { title: "Review hub PR", due: "2026-11-21", priority: "medium" }],
  ["Ship release fri", { title: "Ship release", due: "2026-11-27", priority: null }],
  ["Ship release on mon", { title: "Ship release", due: "2026-11-23", priority: null }],
  ["Pay invoice by wednesday !high", { title: "Pay invoice", due: "2026-11-25", priority: "high" }],
  ["Plan Q1 next week", { title: "Plan Q1", due: "2026-11-23", priority: null }],
  ["Taxes 12 dec", { title: "Taxes", due: "2026-12-12", priority: null }],
  ["Taxes dec 12", { title: "Taxes", due: "2026-12-12", priority: null }],
  ["Renew domain 3 mar", { title: "Renew domain", due: "2027-03-03", priority: null }],
  ["Renew domain 3 mar 2028", { title: "Renew domain", due: "2028-03-03", priority: null }],
  ["Boodschappen morgen", { title: "Boodschappen", due: "2026-11-21", priority: null }],
  ["Factuur 5 okt", { title: "Factuur", due: "2027-10-05", priority: null }],
  ["Buy sun cream", { title: "Buy sun cream", due: null, priority: null }],
  ["Read the may notes", { title: "Read the may notes", due: null, priority: null }],
  ["31 feb party", { title: "31 feb party", due: null, priority: null }],
  ["Water plants !", { title: "Water plants", due: null, priority: "low" }],
  ["today", { title: "", due: "2026-11-20", priority: null }],
];
for (const [input, want] of cases) assert.deepEqual(q(input), want, input);

// Next week from a Monday is the Monday after.
assert.equal(q("x next week", new Date(2026, 10, 23)).due, "2026-11-30");
// Across a year end.
assert.equal(q("x tomorrow", new Date(2026, 11, 31)).due, "2027-01-01");
assert.equal(daysUntil("2026-11-19", fri), -1);
assert.equal(daysUntil("2026-12-20", fri), 30);

console.log(`dates: ${cases.length + 4} checks passed`);
