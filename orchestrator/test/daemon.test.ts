import assert from "node:assert/strict";
import { test } from "node:test";
import type { Board, Column, Task } from "../src/board/index.ts";
import { FleetDaemon, selectCandidates, type Candidate, type DaemonDeps, type TaskStateStore } from "../src/daemon/index.ts";
import type { AttemptOutcome } from "../src/loop/index.ts";
import type { HostConfig, RuntimeConfig } from "../src/runtime-config.ts";

function host(name: string): HostConfig {
  return { name, ssh: { host: name }, maxContainers: 10 };
}

function makeConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    board: {
      url: "http://b",
      id: "b1",
      queues: { author: ["Todo", "Changes Requested"], reviewer: ["Code Review"] },
      done: "Done",
      blocked: ["Need Help"],
    },
    hosts: [host("h1"), host("h2")],
    repos: { default: { url: "u", dir: "d" } },
    container: { modulePath: "m", dns: [], port: 4096 },
    model: { provider: "router", id: "basic" },
    agents: { default: "build" },
    limits: { maxContainers: 2, providerConcurrency: 4, mcpConcurrency: 5 },
    review: { maxRounds: 2 },
    observability: { eventsPath: "e", statusPort: 4000 },
    ...overrides,
  };
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 1,
    columnId: 10,
    name: "t",
    description: null,
    position: 0,
    claimedBy: null,
    priority: null,
    estimate: null,
    assignee: null,
    dueAt: null,
    createdAt: "",
    updatedAt: "",
    tags: [],
    dependsOn: [],
    dependents: [],
    ...overrides,
  };
}

function column(name: string, tasks: Task[], id = 10): Column {
  return { id, name, position: 0, isQueue: true, pushDescription: null, pullDescription: null, tasks };
}

function board(columns: Column[]): Board {
  return { id: "b1", name: "B", tags: [], columns };
}

function memState(): TaskStateStore {
  const map = new Map<number, { round: number; attempts: number }>();
  return {
    get: (id) => map.get(id) ?? { round: 0, attempts: 0 },
    save: (id, state) => map.set(id, state),
  };
}

interface Rec {
  claims: number[];
  releases: number[];
  moves: Array<{ taskId: number; column: string }>;
  notes: Array<{ taskId: number; note: string }>;
}

function harness(overrides: Partial<DaemonDeps> = {}): { daemon: FleetDaemon; rec: Rec } {
  const rec: Rec = { claims: [], releases: [], moves: [], notes: [] };
  const deps: DaemonDeps = {
    config: makeConfig(),
    snapshot: async () => board([]),
    claim: async (candidate) => {
      rec.claims.push(candidate.task.id);
    },
    release: async (candidate) => {
      rec.releases.push(candidate.task.id);
    },
    moveTo: async (taskId, col) => {
      rec.moves.push({ taskId, column: col });
    },
    note: async (taskId, note) => {
      rec.notes.push({ taskId, note });
    },
    admit: async () => () => {},
    runAttempt: async () => ({ status: "completed", action: "code-review" }),
    state: memState(),
    log: () => {},
    ...overrides,
  };
  return { daemon: new FleetDaemon(deps), rec };
}

const candidate = (id: number, role: "author" | "reviewer"): Candidate => ({
  task: task({ id }),
  column: column("Todo", []),
  role,
});

test("selects author and reviewer queues, skipping claimed, running and unmet deps", () => {
  const config = makeConfig();
  const b = board([
    column("Todo", [
      task({ id: 1, priority: "urgent" }), // running -> skipped
      task({ id: 2, claimedBy: "someone" }), // claimed -> skipped
      task({ id: 3, dependsOn: [99] }), // dep 99 is Done -> eligible
      task({ id: 6, dependsOn: [98] }), // dep 98 absent -> excluded
    ]),
    column("Code Review", [task({ id: 4 })], 11),
    column("Done", [task({ id: 99 })], 12),
    column("Need Help", [task({ id: 5 })], 13),
  ]);
  const candidates = selectCandidates(b, config, new Set([1]));
  assert.deepEqual(
    candidates.map((entry) => [entry.task.id, entry.role]),
    [
      [3, "author"],
      [4, "reviewer"],
    ],
  );
});

test("runs a candidate: claims, runs, releases", async () => {
  const { daemon, rec } = harness();
  await daemon.runCandidate(candidate(1, "author"), host("h1"));
  assert.deepEqual(rec.claims, [1]);
  assert.deepEqual(rec.releases, [1]);
  assert.deepEqual(rec.moves, []);
});

test("failed attempts requeue, then escalate to the blocked column", async () => {
  const { daemon, rec } = harness({
    runAttempt: async (): Promise<AttemptOutcome> => ({ status: "failed", reason: "boom", escalate: false }),
  });
  await daemon.runCandidate(candidate(1, "author"), host("h1"));
  await daemon.runCandidate(candidate(1, "author"), host("h1"));
  await daemon.runCandidate(candidate(1, "author"), host("h1"));
  assert.deepEqual(
    rec.moves,
    [
      { taskId: 1, column: "Todo" },
      { taskId: 1, column: "Todo" },
      { taskId: 1, column: "Need Help" },
    ],
  );
});

test("an escalating failure goes straight to the blocked column", async () => {
  const { daemon, rec } = harness({
    runAttempt: async (): Promise<AttemptOutcome> => ({ status: "failed", reason: "capability", escalate: true }),
  });
  await daemon.runCandidate(candidate(1, "author"), host("h1"));
  assert.deepEqual(rec.moves, [{ taskId: 1, column: "Need Help" }]);
});

test("review rounds are bounded by review.maxRounds", async () => {
  const { daemon, rec } = harness({
    runAttempt: async (): Promise<AttemptOutcome> => ({ status: "completed", action: "changes-requested" }),
  });
  await daemon.runCandidate(candidate(1, "reviewer"), host("h1"));
  await daemon.runCandidate(candidate(1, "reviewer"), host("h1"));
  assert.deepEqual(rec.moves, [{ taskId: 1, column: "Need Help" }]);
  assert.ok(rec.notes.some((entry) => /round 1\/2/.test(entry.note)));
});

test("tick starts eligible tasks and respects the concurrency cap", async () => {
  const { daemon, rec } = harness({
    config: makeConfig({ limits: { maxContainers: 1, providerConcurrency: 4, mcpConcurrency: 5 } }),
    snapshot: async () => board([column("Todo", [task({ id: 1 }), task({ id: 2 })])]),
  });
  await daemon.tick();
  await daemon.waitIdle();
  assert.equal(rec.claims.length, 1);
});
