import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULTS } from "../src/config.ts";
import { containerName, createRuntime, runtimeOptionsFromEnv } from "../src/runtime.ts";

const fullEnv: Record<string, string> = {
  FLEET_CATALOG: "ignored",
  FLEET_BOARD_URL: "http://board",
  FLEET_BOARD_ID: "b1",
  FLEET_SSH_HOST: "agents.bigbox",
  FLEET_REPO_DIR: "/srv/repo",
  FLEET_INJECT_ANTHROPIC_API_KEY: "sk-test",
  FLEET_MODEL_PROVIDER: "anthropic",
  FLEET_MODEL_ID: "claude",
};

test("runtimeOptionsFromEnv parses required vars, model and injected env", () => {
  const options = runtimeOptionsFromEnv(DEFAULTS, fullEnv);
  assert.equal(options.boardUrl, "http://board");
  assert.equal(options.sshHost, "agents.bigbox");
  assert.deepEqual(options.model, { providerID: "anthropic", modelID: "claude" });
  assert.deepEqual(options.injectEnv, { ANTHROPIC_API_KEY: "sk-test" });
  assert.equal(options.modulePath, "/etc/nixos/image/fleet-agent.nix");
});

test("runtimeOptionsFromEnv fails closed on a missing required var", () => {
  assert.throws(() => runtimeOptionsFromEnv(DEFAULTS, {}), /FLEET_CATALOG is required/);
});

test("containerName is short and sanitised", () => {
  assert.equal(containerName("84"), "c84");
  assert.ok(containerName("weird/id#1234567890").length <= 11);
});

test("createRuntime wires a loop from a catalog file", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-runtime-"));
  const catalogPath = join(dir, "catalog.json");
  writeFileSync(catalogPath, JSON.stringify({ servers: {} }));
  const runtime = createRuntime(
    runtimeOptionsFromEnv(DEFAULTS, { ...fullEnv, FLEET_CATALOG: catalogPath }),
  );
  assert.ok(runtime.loop);
  assert.equal(typeof runtime.runAttempt, "function");
});
