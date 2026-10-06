import assert from "node:assert/strict";
import { test } from "node:test";
import { Scheduler, Semaphore, TokenBucket } from "../src/limits/index.ts";

const flush = async (): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

test("Semaphore queues waiters FIFO and tracks active count", async () => {
  const sem = new Semaphore(1);
  const r1 = await sem.acquire();
  assert.equal(sem.active, 1);

  let got = false;
  const pending = sem.acquire().then((release) => {
    got = true;
    return release;
  });
  await flush();
  assert.equal(got, false);
  assert.equal(sem.waiting, 1);

  r1();
  const r2 = await pending;
  assert.equal(got, true);
  assert.equal(sem.active, 1);
  r2();
  assert.equal(sem.active, 0);
});

test("Semaphore.tryAcquire fails when exhausted", () => {
  const sem = new Semaphore(2);
  assert.equal(sem.tryAcquire(), true);
  assert.equal(sem.tryAcquire(), true);
  assert.equal(sem.tryAcquire(), false);
});

test("TokenBucket refills over time up to capacity", () => {
  let now = 0;
  const bucket = new TokenBucket({ capacity: 2, refillPerMs: 1 / 1000, now: () => now });
  assert.equal(bucket.tryAcquire(), true);
  assert.equal(bucket.tryAcquire(), true);
  assert.equal(bucket.tryAcquire(), false);
  now = 1000;
  assert.equal(bucket.tryAcquire(), true);
});

test("Scheduler admits up to maxContainers and blocks the rest", async () => {
  const scheduler = new Scheduler({ maxContainers: 1, providerConcurrency: 5, mcpConcurrency: 5 });
  const r1 = await scheduler.admit();
  assert.equal(scheduler.activeContainers, 1);

  let second = false;
  const pending = scheduler.admit().then((release) => {
    second = true;
    return release;
  });
  await flush();
  assert.equal(second, false);

  r1();
  const r2 = await pending;
  assert.equal(second, true);
  r2();
  assert.equal(scheduler.activeContainers, 0);
});

test("Scheduler serializes per-provider, not across providers", async () => {
  const scheduler = new Scheduler({ maxContainers: 10, providerConcurrency: 1, mcpConcurrency: 10 });
  const r1 = await scheduler.admit({ provider: "p" });

  let second = false;
  const pending = scheduler.admit({ provider: "p" }).then((release) => {
    second = true;
    return release;
  });
  await flush();
  assert.equal(second, false);

  const other = await scheduler.admit({ provider: "q" });
  other();

  r1();
  const r2 = await pending;
  assert.equal(second, true);
  r2();
});

test("Scheduler serializes per MCP endpoint", async () => {
  const scheduler = new Scheduler({ maxContainers: 10, providerConcurrency: 10, mcpConcurrency: 1 });
  const r1 = await scheduler.admit({ mcp: "kanban" });
  let second = false;
  const pending = scheduler.admit({ mcp: "kanban" }).then((release) => {
    second = true;
    return release;
  });
  await flush();
  assert.equal(second, false);
  r1();
  const r2 = await pending;
  assert.equal(second, true);
  r2();
});

test("Scheduler rate-limits provider admissions via a token bucket", async () => {
  let now = 0;
  const scheduler = new Scheduler({
    maxContainers: 10,
    providerConcurrency: 10,
    mcpConcurrency: 10,
    providerRate: { capacity: 1, refillPerMs: 1 / 100 },
    pollIntervalMs: 100,
    clock: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  });
  const r1 = await scheduler.admit({ provider: "p" });
  r1();
  const r2 = await scheduler.admit({ provider: "p" });
  r2();
  // the second admission had to wait for the bucket to refill
  assert.ok(now >= 100);
});

test("releasing an admission frees every slot it held", async () => {
  const scheduler = new Scheduler({ maxContainers: 1, providerConcurrency: 1, mcpConcurrency: 1 });
  const release = await scheduler.admit({ provider: "p", mcp: "m" });
  release();
  const again = await scheduler.admit({ provider: "p", mcp: "m" });
  again();
  assert.equal(scheduler.activeContainers, 0);
});
