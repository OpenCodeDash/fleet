import assert from "node:assert/strict";
import { test } from "node:test";
import { compile, type Catalog } from "../src/capability/index.ts";
import { EventSink, MemoryEventStore } from "../src/observability/index.ts";
import {
  TaskLoop,
  type AttemptOutcome,
  type CompletionResult,
  type LoopDeps,
  type ReviewerResult,
} from "../src/loop/index.ts";

const catalog: Catalog = {
  servers: {
    github: {
      type: "local",
      command: ["gh"],
      toolPrefix: "github",
      credential: { provider: "github", scopes: ["repo:read"] },
      egress: ["api.github.com"],
    },
  },
};

function makeHarness(reviewerVerdicts: Array<ReviewerResult["verdict"]>): {
  deps: LoopDeps;
  moves: string[];
  minted: string[];
  revoked: string[];
  refs: Set<string>;
} {
  const refs = new Set<string>();
  const moves: string[] = [];
  const minted: string[] = [];
  const revoked: string[] = [];
  let verdictIndex = 0;
  let authorSeq = 0;

  const deps: LoopDeps = {
    compile(request) {
      return compile({ ...request, grants: [{ mcp: "github" }] }, catalog);
    },
    async mintCredentials(containerId) {
      if (minted.includes(containerId)) throw new Error(`double mint for ${containerId}`);
      minted.push(containerId);
      return { env: { GITHUB_TOKEN: `tok-${containerId}` } };
    },
    async revokeCredentials(containerId) {
      revoked.push(containerId);
    },
    async provision(spec) {
      return { name: spec.name, spec, address: `http://${spec.name}:4096` };
    },
    async destroy() {},
    async runAgent(input): Promise<CompletionResult> {
      if (input.role === "author") {
        authorSeq += 1;
        const sha = `sha-${authorSeq}`;
        refs.add(`feat/x@${sha}`); // the author pushes
        return {
          kind: "author",
          result: { status: "done", branch: "feat/x", head_sha: sha, base_sha: "base", summary: `work ${sha}` },
        };
      }
      const verdict = reviewerVerdicts[
        Math.min(verdictIndex, reviewerVerdicts.length - 1)
      ] as ReviewerResult["verdict"];
      verdictIndex += 1;
      return verdict === "approve"
        ? { kind: "reviewer", result: { verdict: "approve", note: "ok", merge_sha: "merge-1" } }
        : { kind: "reviewer", result: { verdict: "changes", note: "please fix" } };
    },
    git: {
      async remoteRefExists(branch, sha) {
        return refs.has(`${branch}@${sha}`);
      },
      async isAncestorOfMain() {
        return true;
      },
      async branchDeleted() {
        return true;
      },
    },
    board: {
      async moveTo(_taskId, column) {
        moves.push(column);
      },
      async appendNote() {},
    },
    sinkFor(correlation, secrets) {
      return new EventSink({ store: new MemoryEventStore(), correlation, secrets });
    },
    modulePath: "/etc/nixos/image/fleet-agent.nix",
    port: 4096,
    verifyRetries: 0,
    columns: { review: "Code Review", changes: "Changes Requested", done: "Done", blocked: "Need Help" },
  };

  return { deps, moves, minted, revoked, refs };
}

interface DriveResult {
  result: "done" | "need-help";
  rounds: number;
  authorRefs: number;
}

/** Drives the author↔reviewer cycle, counting review rounds; stops at maxRounds. */
async function drive(loop: TaskLoop, maxRounds: number): Promise<DriveResult> {
  let round = 0;
  let container = 0;
  while (true) {
    container += 1;
    const author = await loop.run({
      taskId: "#1",
      repo: "acme/app",
      role: "author",
      prompt: "implement the task",
      containerId: `c${container}`,
    });
    assert.deepEqual(author, { status: "completed", action: "code-review" });

    container += 1;
    const review: AttemptOutcome = await loop.run({
      taskId: "#1",
      repo: "acme/app",
      role: "reviewer",
      prompt: "review the task",
      containerId: `c${container}`,
      branch: "feat/x",
    });
    if (review.status === "completed" && review.action === "done") {
      return { result: "done", rounds: round, authorRefs: 0 };
    }
    assert.deepEqual(review, { status: "completed", action: "changes-requested" });
    round += 1;
    if (round >= maxRounds) return { result: "need-help", rounds: round, authorRefs: 0 };
  }
}

test("e2e: changes once then approve — board moves, credentials recycled per attempt", async () => {
  const h = makeHarness(["changes", "approve"]);
  const loop = new TaskLoop(h.deps);
  const outcome = await drive(loop, 3);

  assert.equal(outcome.result, "done");
  assert.equal(outcome.rounds, 1);
  assert.deepEqual(h.moves, ["Code Review", "Changes Requested", "Code Review", "Done"]);
  // two author attempts + two reviewer attempts => four containers, each minted and revoked
  assert.equal(h.minted.length, 4);
  assert.equal(new Set(h.minted).size, 4);
  assert.deepEqual(h.revoked.sort(), h.minted.sort());
});

test("e2e: bounded iterations stop at maxRounds and escalate to Need Help", async () => {
  const h = makeHarness(["changes"]);
  const loop = new TaskLoop(h.deps);
  const outcome = await drive(loop, 3);

  assert.equal(outcome.result, "need-help");
  assert.equal(outcome.rounds, 3);
  assert.deepEqual(h.moves, [
    "Code Review",
    "Changes Requested",
    "Code Review",
    "Changes Requested",
    "Code Review",
    "Changes Requested",
  ]);
  assert.equal(h.minted.length, 6);
  assert.deepEqual(h.revoked.sort(), h.minted.sort());
});

test("e2e: no author result is accepted until the push is visible", async () => {
  const h = makeHarness(["approve"]);
  const realRefs = h.refs;
  let verifyCalls = 0;
  const deps: LoopDeps = {
    ...h.deps,
    git: {
      async remoteRefExists(branch, sha) {
        verifyCalls += 1;
        // First attempt's two verification calls fail, then the push becomes visible.
        return realRefs.has(`${branch}@${sha}`) && verifyCalls >= 3;
      },
      async isAncestorOfMain() {
        return true;
      },
      async branchDeleted() {
        return true;
      },
    },
    verifyRetries: 1,
  };
  const loop = new TaskLoop(deps);
  // First run: ref not "visible" -> fails after retries, no board move.
  const first = await loop.run({
    taskId: "#2",
    repo: "acme/app",
    role: "author",
    prompt: "do",
    containerId: "x1",
  });
  assert.equal(first.status, "failed");
  assert.deepEqual(h.moves, []);

  // Once the push is visible, verification succeeds and the task advances.
  const second = await loop.run({
    taskId: "#2",
    repo: "acme/app",
    role: "author",
    prompt: "do",
    containerId: "x2",
  });
  assert.deepEqual(second, { status: "completed", action: "code-review" });
  assert.deepEqual(h.moves, ["Code Review"]);
});
