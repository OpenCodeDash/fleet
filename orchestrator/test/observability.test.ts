import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EventSink,
  MemoryEventStore,
  SseParser,
  redactSecrets,
  type EventStore,
  type StoredEvent,
} from "../src/observability/index.ts";

class FlakyStore implements EventStore {
  readonly events: StoredEvent[] = [];
  flushes = 0;
  private failures: number;

  constructor(failures: number) {
    this.failures = failures;
  }

  async append(event: StoredEvent): Promise<void> {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error("store unavailable");
    }
    this.events.push(event);
  }

  async flush(): Promise<void> {
    this.flushes += 1;
  }
}

const correlation = {
  taskId: "#1",
  containerId: "c1",
  sessionId: "s1",
  role: "author",
  capabilityHash: "abc",
};

test("redacts known secrets in strings, arrays and nested objects", () => {
  assert.equal(redactSecrets("token is abc123", ["abc123"]), "token is [REDACTED]");
  assert.deepEqual(redactSecrets({ a: "abc123", b: ["abc123"] }, ["abc123"]), {
    a: "[REDACTED]",
    b: ["[REDACTED]"],
  });
  assert.deepEqual(redactSecrets({ x: 1 }, []), { x: 1 });
});

test("blanks credential headers and never mutates the input", () => {
  const input = { Authorization: "Bearer abc123", host: "x" };
  const output = redactSecrets(input, []) as Record<string, unknown>;
  assert.equal(output.Authorization, "[REDACTED]");
  assert.equal(input.Authorization, "Bearer abc123");
});

test("SseParser parses frames, multi-line data, comments, and split chunks", () => {
  const parser = new SseParser();
  const frames = parser.push('event: hello\ndata: {"x":1}\n\ndata: line1\ndata: line2\n\n');
  assert.equal(frames.length, 2);
  assert.equal(frames[0]?.event, "hello");
  assert.equal(frames[0]?.data, '{"x":1}');
  assert.equal(frames[1]?.data, "line1\nline2");

  const split = new SseParser();
  assert.deepEqual(split.push("data: ab"), []);
  assert.equal(split.push("c\n\n")[0]?.data, "abc");
  assert.deepEqual(split.push(": keepalive\n\n"), []);
});

test("SseParser.end flushes a trailing unterminated frame", () => {
  const parser = new SseParser();
  assert.deepEqual(parser.push("data: trailing"), []);
  assert.equal(parser.end()[0]?.data, "trailing");
});

test("records correlation, sequence and a redacted payload", async () => {
  const store = new MemoryEventStore();
  const sink = new EventSink({
    store,
    correlation,
    secrets: ["sekret"],
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });
  await sink.record({ source: "lifecycle", type: "provisioned", data: { token: "sekret" } });
  await sink.record({ source: "sse", type: "message", data: null });

  assert.equal(store.events.length, 2);
  assert.equal(store.events[0]?.seq, 0);
  assert.equal(store.events[1]?.seq, 1);
  assert.equal(store.events[0]?.timestamp, "2026-01-01T00:00:00.000Z");
  assert.equal(store.events[0]?.taskId, "#1");
  assert.equal(store.events[0]?.capabilityHash, "abc");
  assert.deepEqual(store.events[0]?.data, { token: "[REDACTED]" });
});

test("ingestSse records one event per frame", async () => {
  const store = new MemoryEventStore();
  const sink = new EventSink({ store, correlation });
  async function* chunks(): AsyncGenerator<string> {
    yield 'event: message\ndata: {"a":1}\n\n';
    yield "data: second\n\n";
  }
  const count = await sink.ingestSse(chunks());
  assert.equal(count, 2);
  assert.equal(store.events.length, 2);
  assert.deepEqual(store.events[0]?.data, { a: 1 });
  assert.equal(store.events[0]?.type, "message");
  assert.equal(store.events[1]?.data, "second");
});

test("buffers on a store failure and drains on flush", async () => {
  const store = new FlakyStore(1);
  const sink = new EventSink({ store, correlation });
  await sink.record({ source: "lifecycle", type: "provisioned" });
  assert.equal(store.events.length, 0);
  assert.equal(sink.bufferedCount(), 1);

  await sink.flush();
  assert.equal(store.events.length, 1);
  assert.equal(sink.bufferedCount(), 0);
  assert.equal(store.flushes, 1);
});

test("flush surfaces a sustained store failure", async () => {
  const store = new FlakyStore(Number.POSITIVE_INFINITY);
  const sink = new EventSink({ store, correlation });
  await sink.record({ source: "lifecycle", type: "provisioned" });
  await assert.rejects(() => sink.flush(), /store unavailable/);
  assert.equal(store.flushes, 0);
});
