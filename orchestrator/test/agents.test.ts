import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { compile, type Catalog } from "../src/capability/index.ts";
import { CapabilityError } from "../src/capability/types.ts";
import {
  ROLE_PROMPTS,
  parseRepoManifest,
  promptReference,
  renderConfigFiles,
  roleConfigFiles,
} from "../src/agents/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const examplesDir = join(here, "..", "examples");

test("parseRepoManifest accepts valid grants and a missing grants key", () => {
  assert.deepEqual(parseRepoManifest({}), { grants: [] });
  assert.deepEqual(parseRepoManifest({ grants: [{ mcp: "kanban" }, { mcp: "github", tools: ["github_get_pr"] }] }), {
    grants: [{ mcp: "kanban" }, { mcp: "github", tools: ["github_get_pr"] }],
  });
});

test("parseRepoManifest fails closed on malformed input", () => {
  for (const bad of [
    null,
    [],
    { grants: "nope" },
    { grants: [42] },
    { grants: [{ tools: ["x"] }] },
    { grants: [{ mcp: "" }] },
    { grants: [{ mcp: "x", tools: "y" }] },
  ]) {
    assert.throws(() => parseRepoManifest(bad), CapabilityError);
  }
});

test("compiler emits an agent prompt reference for the role", () => {
  const catalog: Catalog = { servers: { kanban: { type: "remote", url: "http://x", toolPrefix: "kanban" } } };
  const compiled = compile(
    { taskId: "#1", repo: "acme/app", role: "author", grants: [{ mcp: "kanban" }] },
    catalog,
  );
  assert.equal(compiled.config.agent.author?.prompt, promptReference("author"));
  assert.equal(compiled.config.agent.author?.prompt, "{file:./prompts/author.md}");
});

test("roleConfigFiles provides the prompt file to mount", () => {
  const files = roleConfigFiles("reviewer");
  assert.deepEqual(files, [{ path: "prompts/reviewer.md", contents: ROLE_PROMPTS.reviewer }]);
});

test("renderConfigFiles emits the opencode config and role prompts", () => {
  const catalog: Catalog = {
    servers: { kanban: { type: "remote", url: "http://x", toolPrefix: "kanban" } },
  };
  const compiled = compile(
    { taskId: "#1", repo: "acme/app", role: "author", grants: [{ mcp: "kanban" }] },
    catalog,
  );
  const files = renderConfigFiles(compiled, "author");
  assert.deepEqual(
    files.map((file) => file.path),
    ["opencode.json", "prompts/author.md"],
  );
  const opencode = JSON.parse(files[0]?.contents ?? "") as {
    mcp: Record<string, unknown>;
    agent: { author: { prompt: string } };
  };
  assert.ok(opencode.mcp.kanban);
  assert.equal(opencode.agent.author.prompt, "{file:./prompts/author.md}");
});

test("the example manifest compiles against the example catalog", () => {
  const catalog = JSON.parse(
    readFileSync(join(examplesDir, "catalog.json"), "utf8"),
  ) as Catalog;
  const manifest = parseRepoManifest(
    JSON.parse(readFileSync(join(examplesDir, "capabilities.json"), "utf8")),
  );
  const compiled = compile(
    { taskId: "#1", repo: "acme/app", role: "author", grants: manifest.grants },
    catalog,
  );
  assert.deepEqual(compiled.audit.servers, ["github", "kanban"]);
  assert.deepEqual(compiled.egress, ["api.github.com", "orchestrator.internal"]);
});
