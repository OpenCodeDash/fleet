import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Reconciler,
  type RecoveryDeps,
  type RecoveryTask,
  type RunningContainer,
} from "../src/recovery/index.ts";

function harness(
  tasks: RecoveryTask[],
  containers: RunningContainer[],
): {
  deps: RecoveryDeps;
  destroyed: string[];
  revoked: string[];
  requeued: string[];
} {
  const destroyed: string[] = [];
  const revoked: string[] = [];
  const requeued: string[] = [];
  const deps: RecoveryDeps = {
    async inProgressTasks() {
      return tasks;
    },
    async runningContainers() {
      return containers;
    },
    async destroyContainer(id) {
      destroyed.push(id);
    },
    async revokeCredentials(id) {
      revoked.push(id);
    },
    async requeue(id) {
      requeued.push(id);
    },
  };
  return { deps, destroyed, revoked, requeued };
}

test("keeps a task whose assigned container is running", async () => {
  const h = harness(
    [{ taskId: "#1", containerId: "c1", capabilityHash: "h1" }],
    [{ containerId: "c1", capabilityHash: "h1" }],
  );
  const report = await new Reconciler(h.deps).reconcile();
  assert.deepEqual(report, { destroyed: [], revoked: [], requeued: [], kept: ["#1"] });
});

test("destroys and revokes an orphan container with no owning task", async () => {
  const h = harness([], [{ containerId: "c9", capabilityHash: "h9" }]);
  const report = await new Reconciler(h.deps).reconcile();
  assert.deepEqual(report.destroyed, ["c9"]);
  assert.deepEqual(report.revoked, ["c9"]);
  assert.deepEqual(report.kept, []);
});

test("requeues an in-progress task with no live container", async () => {
  const h = harness([{ taskId: "#3", containerId: "c3", capabilityHash: "h3" }], []);
  const report = await new Reconciler(h.deps).reconcile();
  assert.deepEqual(report.requeued, ["#3"]);
  assert.deepEqual(report.destroyed, []);
});

test("matches by capability hash when the task has no container id", async () => {
  const h = harness(
    [{ taskId: "#4", containerId: null, capabilityHash: "h4" }],
    [{ containerId: "cX", capabilityHash: "h4" }],
  );
  const report = await new Reconciler(h.deps).reconcile();
  assert.deepEqual(report.kept, ["#4"]);
  assert.deepEqual(report.destroyed, []);
  assert.deepEqual(report.requeued, []);
});

test("a consistent state is a no-op", async () => {
  const h = harness(
    [
      { taskId: "#1", containerId: "c1", capabilityHash: "h1" },
      { taskId: "#2", containerId: "c2", capabilityHash: "h2" },
    ],
    [
      { containerId: "c1", capabilityHash: "h1" },
      { containerId: "c2", capabilityHash: "h2" },
    ],
  );
  const report = await new Reconciler(h.deps).reconcile();
  assert.deepEqual(report, { destroyed: [], revoked: [], requeued: [], kept: ["#1", "#2"] });
});
