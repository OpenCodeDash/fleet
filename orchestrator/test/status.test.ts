import assert from "node:assert/strict";
import { test } from "node:test";
import { FleetDaemon, startStatusServer, type DaemonDeps } from "../src/daemon/index.ts";
import type { RuntimeConfig } from "../src/runtime-config.ts";

function config(): RuntimeConfig {
  return {
    boards: [{ url: "b", id: "b1", queues: { author: [], reviewer: [] }, done: "Done", blocked: [] }],
    catalog: "c",
    hosts: [],
    repos: { default: { url: "u", dir: "d" } },
    container: { modulePath: "m", dns: [], port: 4096 },
    model: { provider: "p", id: "i" },
    agents: { default: "build" },
    limits: { maxContainers: 1, providerConcurrency: 1, mcpConcurrency: 1 },
    review: { maxRounds: 1 },
    observability: { eventsPath: "e", statusPort: 0 },
  };
}

function deps(): DaemonDeps {
  return {
    config: config(),
    snapshot: async () => ({ id: "b1", name: "B", tags: [], columns: [] }),
    claim: async () => {},
    release: async () => {},
    moveTo: async () => {},
    note: async () => {},
    admit: async () => () => {},
    runAttempt: async () => ({ status: "completed", action: "code-review" }),
    state: { get: () => ({ round: 0, attempts: 0 }), save: () => {} },
    log: () => {},
  };
}

test("status server exposes /health and /tasks", async () => {
  const server = await startStatusServer(0, new FleetDaemon(deps()), "127.0.0.1");
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  try {
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.deepEqual(await health.json(), { healthy: true, inFlight: 0 });
    const tasks = await fetch(`http://127.0.0.1:${port}/tasks`);
    assert.deepEqual(await tasks.json(), []);
    const missing = await fetch(`http://127.0.0.1:${port}/nope`);
    assert.equal(missing.status, 404);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
