import assert from "node:assert/strict";
import { test } from "node:test";
import { SqliteStateStore } from "../src/daemon/index.ts";

test("round/attempt counters roundtrip", () => {
  const store = new SqliteStateStore(":memory:");
  assert.deepEqual(store.get(1), { round: 0, attempts: 0 });
  store.save(1, { round: 2, attempts: 1 });
  assert.deepEqual(store.get(1), { round: 2, attempts: 1 });
  store.save(1, { round: 3, attempts: 1 });
  assert.deepEqual(store.get(1), { round: 3, attempts: 1 });
  store.close();
});

test("running index records and clears in-flight attempts", () => {
  const store = new SqliteStateStore(":memory:");
  store.startRunning({
    taskId: 5,
    role: "author",
    host: "h1",
    containerId: "c5",
    capabilityHash: "abc",
    sessionId: "ses_1",
  });
  assert.deepEqual(store.running(), [
    { taskId: 5, role: "author", host: "h1", containerId: "c5", capabilityHash: "abc", sessionId: "ses_1" },
  ]);
  store.stopRunning(5);
  assert.deepEqual(store.running(), []);
  store.close();
});
