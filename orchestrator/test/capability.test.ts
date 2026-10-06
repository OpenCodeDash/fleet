import assert from "node:assert/strict";
import { test } from "node:test";
import { CapabilityError, compile, type Catalog } from "../src/capability/index.ts";

const catalog: Catalog = {
  servers: {
    kanban: {
      type: "remote",
      url: "http://orch.internal/mcp",
      toolPrefix: "kanban",
      tools: ["kanban_get_board", "kanban_list_boards", "kanban_move_task", "kanban_update_task"],
      denyTools: ["kanban_move_task", "kanban_update_task"],
      credential: { provider: "kanban", scopes: ["boards:read"] },
      egress: ["orch.internal"],
    },
    github: {
      type: "local",
      command: ["gh-mcp"],
      toolPrefix: "github",
      tools: ["github_get_pr", "github_create_pr"],
      credential: { provider: "github", scopes: ["repo:read"] },
      egress: ["api.github.com"],
    },
  },
};

const request = (overrides: Partial<Parameters<typeof compile>[0]> = {}) => ({
  taskId: "#1",
  repo: "acme/app",
  role: "author" as const,
  grants: [{ mcp: "kanban" }],
  ...overrides,
});

test("grants a server and allows its tools while denying its write tools", () => {
  const compiled = compile(request(), catalog);
  assert.ok(compiled.config.mcp.kanban);
  assert.equal(compiled.config.permission["kanban_*"], "allow");
  assert.equal(compiled.config.permission.kanban_move_task, "deny");
  assert.equal(compiled.config.permission.kanban_update_task, "deny");
});

test("default-deny: unrequested MCP servers are absent", () => {
  const compiled = compile(request(), catalog);
  assert.equal(compiled.config.mcp.github, undefined);
  assert.equal(compiled.config.permission["*"], "deny");
});

test("role base policies: author edits, reviewer does not", () => {
  const author = compile(request({ role: "author" }), catalog);
  const reviewer = compile(request({ role: "reviewer" }), catalog);
  assert.equal(author.config.permission.edit, "allow");
  assert.equal(reviewer.config.permission.edit, "deny");
});

test("hard denials are present regardless of role", () => {
  for (const role of ["author", "reviewer"] as const) {
    const { config } = compile(request({ role }), catalog);
    assert.equal(config.permission.task, "deny");
    assert.equal(config.permission.webfetch, "deny");
    assert.equal(config.permission.external_directory, "deny");
  }
});

test("compiler marks bash-bearing sets as soft", () => {
  assert.equal(compile(request(), catalog).soft, true);
});

test("aggregates credentials and egress across granted servers", () => {
  const compiled = compile(request({ grants: [{ mcp: "github" }, { mcp: "kanban" }] }), catalog);
  assert.deepEqual(
    compiled.credentials.map((entry) => entry.provider),
    ["github", "kanban"],
  );
  assert.deepEqual(compiled.egress, ["api.github.com", "orch.internal"]);
});

test("is deterministic and order-independent", () => {
  const a = compile(request({ grants: [{ mcp: "github" }, { mcp: "kanban" }] }), catalog);
  const b = compile(request({ grants: [{ mcp: "github" }, { mcp: "kanban" }] }), catalog);
  const c = compile(request({ grants: [{ mcp: "kanban" }, { mcp: "github" }] }), catalog);
  assert.equal(a.capabilityHash, b.capabilityHash);
  assert.equal(a.capabilityHash, c.capabilityHash);
  assert.equal(a.audit.capabilityHash, a.capabilityHash);
});

test("a different capability hash when policy version changes", () => {
  const a = compile(request(), catalog);
  const b = compile(request(), catalog, { policyVersion: "2" });
  assert.notEqual(a.capabilityHash, b.capabilityHash);
});

test("fails closed on an unknown MCP server", () => {
  assert.throws(
    () => compile(request({ grants: [{ mcp: "nope" }] }), catalog),
    (error: unknown) => error instanceof CapabilityError && /unknown MCP/.test((error as Error).message),
  );
});

test("fails closed when a catalog entry has no tool prefix", () => {
  const broken: Catalog = { servers: { broken: { type: "remote", url: "x", toolPrefix: "" } } };
  assert.throws(
    () => compile(request({ grants: [{ mcp: "broken" }] }), broken),
    (error: unknown) => error instanceof CapabilityError && /toolPrefix/.test((error as Error).message),
  );
});

test("fails closed on an explicit unknown tool", () => {
  assert.throws(
    () => compile(request({ grants: [{ mcp: "github", tools: ["github_delete_repo"] }] }), catalog),
    (error: unknown) => error instanceof CapabilityError && /unknown tool/.test((error as Error).message),
  );
});

test("fails closed when a grant requests a denied tool", () => {
  assert.throws(
    () => compile(request({ grants: [{ mcp: "kanban", tools: ["kanban_move_task"] }] }), catalog),
    (error: unknown) => error instanceof CapabilityError && /cannot be granted/.test((error as Error).message),
  );
});

test("fails closed on duplicate grants", () => {
  assert.throws(
    () => compile(request({ grants: [{ mcp: "kanban" }, { mcp: "kanban" }] }), catalog),
    (error: unknown) => error instanceof CapabilityError && /duplicate/.test((error as Error).message),
  );
});

test("explicit tool subset allows only the named tools", () => {
  const compiled = compile(request({ grants: [{ mcp: "github", tools: ["github_get_pr"] }] }), catalog);
  assert.equal(compiled.config.permission.github_get_pr, "allow");
  assert.equal(compiled.config.permission["github_*"], undefined);
  assert.equal(compiled.config.permission.github_create_pr, undefined);
});
