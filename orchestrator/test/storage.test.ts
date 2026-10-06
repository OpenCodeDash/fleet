import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  BrokerError,
  CredentialBroker,
  EnvCredentialProvider,
  envCredentialProviders,
} from "../src/credentials/index.ts";
import { JsonlEventStore, type StoredEvent } from "../src/observability/index.ts";

function event(seq: number): StoredEvent {
  return {
    seq,
    timestamp: "2026-01-01T00:00:00.000Z",
    taskId: "#1",
    containerId: "c1",
    sessionId: "s1",
    role: "author",
    capabilityHash: "h",
    source: "lifecycle",
    type: "t",
    data: { seq },
  };
}

test("JsonlEventStore appends durable JSONL lines", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-store-"));
  const path = join(dir, "nested", "events.jsonl");
  const store = new JsonlEventStore(path);
  await store.append(event(0));
  await store.append(event(1));
  await store.flush();

  const lines = readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as StoredEvent);
  assert.equal(lines.length, 2);
  assert.deepEqual(
    lines.map((line) => line.seq),
    [0, 1],
  );
});

test("EnvCredentialProvider mints the env token and fails closed when absent", async () => {
  const provider = new EnvCredentialProvider({
    provider: "github",
    env: { FLEET_GITHUB_TOKEN: "sekret" },
  });
  assert.deepEqual(await provider.mint(), { secret: "sekret", reference: "github-1" });
  await provider.revoke("github-1");

  const missing = new EnvCredentialProvider({ provider: "github", env: {} });
  await assert.rejects(() => missing.mint(), BrokerError);
});

test("broker with env providers mints and injects credentials", async () => {
  const env = { FLEET_GITHUB_TOKEN: "gh", FLEET_KANBAN_TOKEN: "kb" };
  const broker = new CredentialBroker({
    providers: envCredentialProviders(["github", "kanban"], env),
    ttl: "1h",
  });
  const creds = await broker.mint("c1", [
    { provider: "github", scopes: [] },
    { provider: "kanban", scopes: [] },
  ]);
  assert.deepEqual(creds.env, { GITHUB_TOKEN: "gh", KANBAN_TOKEN: "kb" });
});
