import assert from "node:assert/strict";
import { test } from "node:test";
import { SqliteStateStore } from "../src/daemon/index.ts";

test("round/attempt counters roundtrip", () => {
  const store = new SqliteStateStore(":memory:");
  assert.deepEqual(store.get("b1", 1), { round: 0, attempts: 0 });
  store.save("b1", 1, { round: 2, attempts: 1 });
  assert.deepEqual(store.get("b1", 1), { round: 2, attempts: 1 });
  store.save("b1", 1, { round: 3, attempts: 1 });
  assert.deepEqual(store.get("b1", 1), { round: 3, attempts: 1 });
  store.close();
});

test("counters are keyed per board", () => {
  const store = new SqliteStateStore(":memory:");
  store.save("b1", 1, { round: 1, attempts: 0 });
  store.save("b2", 1, { round: 2, attempts: 0 });
  assert.deepEqual(store.get("b1", 1), { round: 1, attempts: 0 });
  assert.deepEqual(store.get("b2", 1), { round: 2, attempts: 0 });
  store.close();
});

test("running index records and clears in-flight attempts", () => {
  const store = new SqliteStateStore(":memory:");
  store.startRunning({
    boardId: "b1",
    taskId: 5,
    role: "author",
    host: "h1",
    containerId: "c5",
    capabilityHash: "abc",
    sessionId: "ses_1",
  });
  assert.deepEqual(store.running(), [
    { boardId: "b1", taskId: 5, role: "author", host: "h1", containerId: "c5", capabilityHash: "abc", sessionId: "ses_1" },
  ]);
  store.stopRunning("b1", 5);
  assert.deepEqual(store.running(), []);
  store.close();
});
