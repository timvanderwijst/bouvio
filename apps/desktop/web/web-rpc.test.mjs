// Tests the web backend's pure parts: `node web/web-rpc.test.mjs` (Node 22.18+
// strips the TypeScript types itself). Run by `pnpm test:web`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { RpcTable, eventFor, toWorkspaces } from "../src/backend/web-rpc.ts";

test("results settle the call with the same id, whatever the order", async () => {
  const t = new RpcTable(0);
  const a = t.open();
  const b = t.open();
  assert.notEqual(a.id, b.id);
  assert.equal(t.size, 2);
  assert.equal(t.settle({ id: b.id, ok: "B", err: null }), true);
  assert.equal(t.settle({ id: a.id, ok: { n: 1 }, err: null }), true);
  assert.equal(await b.promise, "B");
  assert.deepEqual(await a.promise, { n: 1 });
  assert.equal(t.size, 0);
});

test("an error result rejects, and a result settles only once", async () => {
  const t = new RpcTable(0);
  const a = t.open();
  assert.equal(t.settle({ id: a.id, ok: null, err: "needs role operator" }), true);
  await assert.rejects(a.promise, /needs role operator/);
  assert.equal(t.settle({ id: a.id, ok: 1, err: null }), false);
  assert.equal(t.settle({ id: 999, ok: 1, err: null }), false);
});

test("ids arriving as bigint or string-ish numbers still match", async () => {
  const t = new RpcTable(0);
  const a = t.open();
  assert.equal(t.settle({ id: BigInt(a.id), ok: null, err: null }), true);
  assert.equal(await a.promise, null);
});

test("a dropped socket fails everything in flight", async () => {
  const t = new RpcTable(0);
  const a = t.open();
  const b = t.open();
  t.failAll("lost");
  await assert.rejects(a.promise, /lost/);
  await assert.rejects(b.promise, /lost/);
  assert.equal(t.size, 0);
});

test("a call nobody answers times out", async () => {
  const t = new RpcTable(20);
  const a = t.open();
  await assert.rejects(a.promise, /did not answer/);
  assert.equal(t.size, 0);
});

test("hub messages map to the desktop's event names", () => {
  assert.deepEqual(eventFor({ t: "event", workspace_id: "w", kind: "notice", payload: { kind: "issue-changed" } }), { name: "workspace-notice", payload: { kind: "issue-changed" } });
  assert.equal(eventFor({ t: "event", workspace_id: "w", kind: "thread-event", payload: {} }).name, "thread-event");
  assert.equal(eventFor({ t: "event", workspace_id: "w", kind: "thread-changed", payload: {} }).name, "thread-changed");
  assert.equal(eventFor({ t: "chat", message: { id: 1 } }).name, "hub-chat");
  assert.equal(eventFor({ t: "chat_updated", message: {} }).name, "hub-chat-updated");
  assert.deepEqual(eventFor({ t: "presence", presence: { p: 1 }, online: true }), { name: "hub-presence", payload: { presence: { p: 1 }, online: true } });
  assert.deepEqual(eventFor({ t: "host_status", workspace_id: "w", online: false }), { name: "hub-host", payload: { workspace_id: "w", online: false } });
  assert.equal(eventFor({ t: "signal", workspace_id: "w", from: {}, kind: "offer", payload: {} }).name, "hub-signal");
  assert.equal(eventFor({ t: "welcome", user: {} }).name, "hub-status");
  assert.equal(eventFor({ t: "rpc_result", id: 1 }), null);
});

test("hub workspace entries become shared workspaces", () => {
  const host = { id: "h", name: "Tim", email: "t@x", avatar_url: null };
  const [w] = toWorkspaces([{ id: "a", name: "Site", role: "operator", host, host_online: true }]);
  assert.equal(w.kind, "shared");
  assert.equal(w.role, "operator");
  assert.equal(w.root, null);
  assert.deepEqual(w.host, host);
  assert.deepEqual(toWorkspaces(null), []);
});
