import assert from "node:assert/strict";
import { test } from "node:test";
import type { Board, Column, Task } from "../src/board/index.ts";
import {
  FleetDaemon,
  branchForTask,
  containerName,
  promptForTask,
  repoForTask,
  selectCandidates,
  type Candidate,
  type DaemonDeps,
  type TaskStateStore,
} from "../src/daemon/index.ts";
import type { AttemptOutcome } from "../src/loop/index.ts";
import type { BoardConfig, HostConfig, RuntimeConfig } from "../src/runtime-config.ts";

function host(name: string): HostConfig {
  return { name, ssh: { host: name }, maxContainers: 10 };
}

const boardConfig: BoardConfig = {
  url: "http://b",
  id: "b1",
  queues: { author: ["Todo", "Changes Requested"], reviewer: ["Code Review"] },
  done: "Done",
  blocked: ["Need Help"],
};

function makeConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    boards: [boardConfig],
    hosts: [host("h1"), host("h2")],
    catalog: "/c.json",
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
  const map = new Map<string, { round: number; attempts: number }>();
  return {
    get: (boardId, taskId) => map.get(`${boardId}:${taskId}`) ?? { round: 0, attempts: 0 },
    save: (boardId, taskId, state) => map.set(`${boardId}:${taskId}`, state),
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
    moveTo: async (_board, taskId, col) => {
      rec.moves.push({ taskId, column: col });
    },
    note: async (_board, taskId, note) => {
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

const candidate = (id: number, role: "author" | "reviewer", board = boardConfig): Candidate => ({
  task: task({ id }),
  column: column("Todo", []),
  role,
  board,
});

test("selects author and reviewer queues, skipping claimed, running and unmet deps", () => {
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
  const candidates = selectCandidates(b, boardConfig, new Set(["b1:1"]));
  assert.deepEqual(
    candidates.map((entry) => [entry.task.id, entry.role]),
    [
      [3, "author"],
      [4, "reviewer"],
    ],
  );
  assert.ok(candidates.every((entry) => entry.board.id === "b1"));
});

test("selectCandidates distinguishes the same task id on different boards", () => {
  const other: BoardConfig = { ...boardConfig, id: "b2", url: "http://b2" };
  const snapshot = (id: string) => ({ ...board([column("Todo", [task({ id: 5 })])]), id });
  const first = selectCandidates(snapshot("b1"), boardConfig, new Set(["b1:5"]));
  const second = selectCandidates(snapshot("b2"), other, new Set(["b1:5"]));
  assert.equal(first.length, 0); // b1:5 is running
  assert.equal(second.length, 1); // b2:5 is independent
});

test("container names include the board and fit the 11-char limit", () => {
  const a = containerName("esayzg", 157, "author");
  const b = containerName("gczhzo", 157, "author");
  assert.notEqual(a, b);
  assert.ok(a.length <= 11 && b.length <= 11);
  assert.equal(containerName("esayzg", 157, "reviewer"), `${containerName("esayzg", 157, "author").slice(0, -1)}r`);
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

test("tick works every board", async () => {
  const b1: BoardConfig = { ...boardConfig, id: "b1" };
  const b2: BoardConfig = { ...boardConfig, id: "b2", url: "http://b2" };
  const { daemon, rec } = harness({
    config: makeConfig({ boards: [b1, b2] }),
    snapshot: async (b) => ({ ...board([column("Todo", [task({ id: 7 })])]), id: b.id }),
  });
  await daemon.tick();
  await daemon.waitIdle();
  assert.equal(rec.claims.length, 2); // task 7 on each board
});

test("repoForTask picks the repo:<name> tag, else default", () => {
  const config = makeConfig({
    repos: { default: { url: "d", dir: "dd" }, acme: { url: "a", dir: "aa" } },
  });
  assert.equal(repoForTask(task({ id: 1 }), config).url, "d");
  const tagged = task({
    id: 1,
    tags: [{ id: 1, name: "repo:acme", description: null, prompt: null, color: null }],
  });
  assert.equal(repoForTask(tagged, config).url, "a");
});

test("branchForTask is deterministic and promptForTask frames the role", () => {
  const t = task({ id: 42, name: "Add hello", description: "make it so" });
  assert.equal(branchForTask(t), "feat/task-42");
  const repo = "https://github.com/acme/app.git";
  assert.match(promptForTask(t, "author", repo), /feat\/task-42/);
  assert.match(promptForTask(t, "author", repo), /Clone/);
  assert.match(promptForTask(t, "author", repo), new RegExp(repo));
  assert.match(promptForTask(t, "reviewer", repo), /Review/);
  assert.match(promptForTask(t, "reviewer", repo), /feat\/task-42/);
  assert.match(promptForTask(t, "reviewer", repo), new RegExp(repo));
});
