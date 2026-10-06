import assert from "node:assert/strict";
import { test } from "node:test";
import { ORCHESTRATOR_NAME, ORCHESTRATOR_VERSION, main } from "../src/index.ts";

test("entry point exposes package identity", () => {
  assert.equal(ORCHESTRATOR_NAME, "fleet-orchestrator");
  assert.match(ORCHESTRATOR_VERSION, /^\d+\.\d+\.\d+$/);
});

test("main is callable in the scaffold", () => {
  assert.equal(main(), 0);
});
