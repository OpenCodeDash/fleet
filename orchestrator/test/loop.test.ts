import assert from "node:assert/strict";
import { test } from "node:test";
import { compile, type Catalog } from "../src/capability/index.ts";
import { CapabilityError } from "../src/capability/types.ts";
import { EventSink, MemoryEventStore } from "../src/observability/index.ts";
import { ProvisionError } from "../src/provision/index.ts";
import {
  TaskLoop,
  type AgentRunInput,
  type CompletionResult,
  type GitVerifier,
  type LoopDeps,
  type TaskAttempt,
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

interface HarnessOptions {
  completions?: CompletionResult[];
  remoteRef?: boolean | boolean[];
  ancestor?: boolean;
  branchDeleted?: boolean;
  provisionFails?: boolean;
  compileFails?: boolean;
  verifyRetries?: number;
}

function harness(options: HarnessOptions = {}): {
  deps: LoopDeps;
  agentCalls: AgentRunInput[];
  moves: Array<{ taskId: string; column: string }>;
  notes: Array<{ taskId: string; note: string }>;
  destroyed: string[];
  revoked: string[];
  provisioned: string[];
} {
  const agentCalls: AgentRunInput[] = [];
  const moves: Array<{ taskId: string; column: string }> = [];
  const notes: Array<{ taskId: string; note: string }> = [];
  const destroyed: string[] = [];
  const revoked: string[] = [];
  const provisioned: string[] = [];

  const completions = options.completions ?? [];
  const remoteRefSeq = Array.isArray(options.remoteRef) ? [...options.remoteRef] : null;
  const remoteRefFixed = typeof options.remoteRef === "boolean" ? options.remoteRef : true;
  let completionIndex = 0;

  const git: GitVerifier = {
    async remoteRefExists() {
      if (remoteRefSeq !== null && remoteRefSeq.length > 0) return remoteRefSeq.shift() as boolean;
      return remoteRefFixed;
    },
    async isAncestorOfMain() {
      return options.ancestor ?? true;
    },
    async branchDeleted() {
      return options.branchDeleted ?? true;
    },
  };

  const deps: LoopDeps = {
    compile(request) {
      if (options.compileFails === true) throw new CapabilityError("unknown capability");
      return compile({ ...request, grants: [{ mcp: "github" }] }, catalog);
    },
    async mintCredentials() {
      return { env: { GITHUB_TOKEN: "sekret" } };
    },
    async revokeCredentials(containerId) {
      revoked.push(containerId);
    },
    async provision(spec) {
      if (options.provisionFails === true) throw new ProvisionError("provision failed");
      provisioned.push(spec.name);
      return { name: spec.name, spec, address: `http://${spec.name}:4096` };
    },
    async destroy(handle) {
      destroyed.push(handle.name);
    },
    async runAgent(input) {
      agentCalls.push(input);
      const completion = completions[Math.min(completionIndex, completions.length - 1)];
      completionIndex += 1;
      return completion as CompletionResult;
    },
    git,
    board: {
      async moveTo(taskId, column) {
        moves.push({ taskId, column });
      },
      async appendNote(taskId, note) {
        notes.push({ taskId, note });
      },
    },
    sinkFor(correlation, secrets) {
      return new EventSink({ store: new MemoryEventStore(), correlation, secrets });
    },
    modulePath: "/etc/nixos/image/fleet-agent.nix",
    port: 4096,
    verifyRetries: options.verifyRetries ?? 0,
  };

  return { deps, agentCalls, moves, notes, destroyed, revoked, provisioned };
}

const authorAttempt: TaskAttempt = {
  taskId: "#1",
  repo: "acme/app",
  role: "author",
  prompt: "do it",
  containerId: "c1",
};
const reviewerAttempt: TaskAttempt = { ...authorAttempt, role: "reviewer", containerId: "c2", branch: "feat/x" };

const authorResult: CompletionResult = {
  kind: "author",
  result: { status: "done", branch: "feat/x", head_sha: "abc", base_sha: "def", summary: "done" },
};
const approveResult: CompletionResult = {
  kind: "reviewer",
  result: { verdict: "approve", note: "lgtm", merge_sha: "m1" },
};
const changesResult: CompletionResult = {
  kind: "reviewer",
  result: { verdict: "changes", note: "fix tests" },
};

test("author: verifies the pushed ref, notes and moves to Code Review, tears down", async () => {
  const h = harness({ completions: [authorResult] });
  const outcome = await new TaskLoop(h.deps).run(authorAttempt);
  assert.deepEqual(outcome, { status: "completed", action: "code-review" });
  assert.deepEqual(h.moves, [{ taskId: "#1", column: "Code Review" }]);
  assert.deepEqual(h.notes, [{ taskId: "#1", note: "done" }]);
  assert.deepEqual(h.provisioned, ["c1"]);
  assert.deepEqual(h.destroyed, ["c1"]);
  assert.deepEqual(h.revoked, ["c1"]);
  assert.equal(h.agentCalls[0]?.address, "http://c1:4096");
});

test("author: re-prompts after a failed verification and then succeeds", async () => {
  const h = harness({ completions: [authorResult], remoteRef: [false, true], verifyRetries: 1 });
  const outcome = await new TaskLoop(h.deps).run(authorAttempt);
  assert.deepEqual(outcome, { status: "completed", action: "code-review" });
  assert.equal(h.agentCalls.length, 2);
});

test("author: fails (no escalation) when verification never passes, but cleans up", async () => {
  const h = harness({ completions: [authorResult], remoteRef: false, verifyRetries: 1 });
  const outcome = await new TaskLoop(h.deps).run(authorAttempt);
  assert.equal(outcome.status, "failed");
  assert.equal((outcome as { escalate: boolean }).escalate, false);
  assert.equal(h.agentCalls.length, 2);
  assert.deepEqual(h.moves, []);
  assert.deepEqual(h.destroyed, ["c1"]);
  assert.deepEqual(h.revoked, ["c1"]);
});

test("capability error escalates without provisioning", async () => {
  const h = harness({ compileFails: true });
  const outcome = await new TaskLoop(h.deps).run(authorAttempt);
  assert.deepEqual(outcome, { status: "failed", reason: "unknown capability", escalate: true });
  assert.deepEqual(h.provisioned, []);
  assert.deepEqual(h.revoked, []);
});

test("reviewer: approve verifies the merge and moves to Done", async () => {
  const h = harness({ completions: [approveResult] });
  const outcome = await new TaskLoop(h.deps).run(reviewerAttempt);
  assert.deepEqual(outcome, { status: "completed", action: "done" });
  assert.deepEqual(h.moves, [{ taskId: "#1", column: "Done" }]);
});

test("reviewer: changes moves back to Changes Requested with the note", async () => {
  const h = harness({ completions: [changesResult] });
  const outcome = await new TaskLoop(h.deps).run(reviewerAttempt);
  assert.deepEqual(outcome, { status: "completed", action: "changes-requested" });
  assert.deepEqual(h.moves, [{ taskId: "#1", column: "Changes Requested" }]);
  assert.deepEqual(h.notes, [{ taskId: "#1", note: "fix tests" }]);
});

test("provision failure requeues and revokes minted credentials", async () => {
  const h = harness({ completions: [authorResult], provisionFails: true });
  const outcome = await new TaskLoop(h.deps).run(authorAttempt);
  assert.equal(outcome.status, "failed");
  assert.equal((outcome as { escalate: boolean }).escalate, false);
  assert.deepEqual(h.destroyed, []);
  assert.deepEqual(h.revoked, ["c1"]);
});
