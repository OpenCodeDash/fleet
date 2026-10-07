import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AgentError,
  OpencodeAgentRunner,
  parseAuthorResult,
  parseReviewerResult,
} from "../src/agents/index.ts";
import { EventSink, MemoryEventStore, type Correlation } from "../src/observability/index.ts";
import type { AgentRunInput } from "../src/loop/index.ts";
import type { FetchLike } from "../src/provision/index.ts";

interface Call {
  url: string;
  method: string;
  body: unknown;
}

interface MessageBody {
  parts: Array<{ type: string; text: string }>;
  format: { type: string; schema: { properties: Record<string, Record<string, unknown>> } };
  model?: unknown;
  agent?: string;
}

function fakeFetch(responses: Array<{ status?: number; body?: unknown }>): {
  impl: FetchLike;
  calls: Call[];
} {
  const calls: Call[] = [];
  let index = 0;
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: typeof input === "string" ? input : input.toString(),
      method: init?.method ?? "GET",
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    const response = responses[Math.min(index, responses.length - 1)] ?? {};
    index += 1;
    return new Response(response.body === undefined ? "" : JSON.stringify(response.body), {
      status: response.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as FetchLike;
  return { impl, calls };
}

const correlation: Correlation = {
  taskId: "#1",
  containerId: "c1",
  sessionId: "s1",
  role: "author",
  capabilityHash: "h",
};

const runInput = (role: "author" | "reviewer"): AgentRunInput => ({
  address: "http://10.0.0.9:4096",
  role,
  prompt: role === "author" ? "do it" : "review it",
  sessionTitle: "#1",
  sink: new EventSink({ store: new MemoryEventStore(), correlation }),
});

const AUTHOR = { status: "done", branch: "feat/x", head_sha: "a", base_sha: "b", summary: "s" };
const REVIEWER = { verdict: "approve", note: "ok", merge_sha: "m" };

test("runs an author turn and parses the structured result", async () => {
  const { impl, calls } = fakeFetch([
    { body: { id: "ses_1" } },
    { body: { info: { structured_output: AUTHOR } } },
  ]);
  const result = await new OpencodeAgentRunner({ fetchImpl: impl }).run(runInput("author"));

  assert.deepEqual(result, { kind: "author", result: AUTHOR });
  assert.equal(calls[0]?.url, "http://10.0.0.9:4096/session");
  assert.equal(calls[1]?.url, "http://10.0.0.9:4096/session/ses_1/message");
  const body = calls[1]?.body as MessageBody;
  assert.equal(body.parts[0]?.text, "do it");
  assert.equal(body.format.type, "json_schema");
  assert.equal(body.format.schema.properties.status?.const, "done");
});

test("runs a reviewer turn with the reviewer schema", async () => {
  const { impl, calls } = fakeFetch([
    { body: { id: "ses_2" } },
    { body: { info: { structured_output: REVIEWER } } },
  ]);
  const result = await new OpencodeAgentRunner({ fetchImpl: impl }).run(runInput("reviewer"));

  assert.deepEqual(result, { kind: "reviewer", result: REVIEWER });
  const body = calls[1]?.body as MessageBody;
  assert.deepEqual(body.format.schema.properties.verdict?.enum, ["approve", "changes"]);
});

test("passes model and agent when configured", async () => {
  const { impl, calls } = fakeFetch([
    { body: { id: "ses" } },
    { body: { info: { structured_output: AUTHOR } } },
  ]);
  await new OpencodeAgentRunner({
    fetchImpl: impl,
    model: { providerID: "anthropic", modelID: "claude" },
    agent: "author",
  }).run(runInput("author"));

  const body = calls[1]?.body as MessageBody;
  assert.deepEqual(body.model, { providerID: "anthropic", modelID: "claude" });
  assert.equal(body.agent, "author");
});

test("records lifecycle events on the sink", async () => {
  const store = new MemoryEventStore();
  const input: AgentRunInput = {
    address: "http://x:1",
    role: "author",
    prompt: "p",
    sessionTitle: "#1",
    sink: new EventSink({ store, correlation }),
  };
  const { impl } = fakeFetch([
    { body: { id: "ses" } },
    { body: { info: { structured_output: AUTHOR } } },
  ]);
  await new OpencodeAgentRunner({ fetchImpl: impl }).run(input);
  assert.deepEqual(
    store.events.map((event) => event.type),
    ["session-created", "agent-result"],
  );
});

test("throws AgentError on a non-ok response", async () => {
  const { impl } = fakeFetch([{ status: 500, body: { message: "nope" } }]);
  await assert.rejects(
    () => new OpencodeAgentRunner({ fetchImpl: impl }).run(runInput("author")),
    AgentError,
  );
});

test("throws AgentError when structured output is missing or invalid", async () => {
  const missing = fakeFetch([{ body: { id: "ses" } }, { body: { info: {} } }]);
  await assert.rejects(
    () => new OpencodeAgentRunner({ fetchImpl: missing.impl }).run(runInput("author")),
    AgentError,
  );

  const invalid = fakeFetch([
    { body: { id: "ses" } },
    { body: { info: { structured_output: { status: "done" } } } },
  ]);
  await assert.rejects(
    () => new OpencodeAgentRunner({ fetchImpl: invalid.impl }).run(runInput("author")),
    AgentError,
  );
});

test("streams agent events to the log", async () => {
  const logged: string[] = [];
  const sse =
    'data: {"type":"message.part.updated","properties":{"tool":"bash"}}\n\n' +
    'data: {"type":"session.idle","properties":{}}\n\n';
  const impl = (async () => new Response(sse, { status: 200 })) as FetchLike;
  const runner = new OpencodeAgentRunner({ fetchImpl: impl, log: (m) => logged.push(m) });
  await runner.streamEvents("http://x", "s1", new AbortController().signal);
  assert.ok(logged.some((m) => /agent message\.part\.updated tool=bash/.test(m)));
  assert.ok(logged.some((m) => /agent session\.idle/.test(m)));
});

test("auto-approves permission requests", async () => {
  const calls: Call[] = [];
  const sse = 'data: {"type":"permission.asked","properties":{"id":"per_1"}}\n\n';
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: typeof input === "string" ? input : input.toString(),
      method: init?.method ?? "GET",
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    return new Response(sse, { status: 200 });
  }) as FetchLike;
  const runner = new OpencodeAgentRunner({ fetchImpl: impl, autoApprove: true });
  await runner.streamEvents("http://x", "s1", new AbortController().signal);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const approval = calls.find((call) => call.method === "POST");
  assert.equal(approval?.url, "http://x/session/s1/permissions/per_1");
  assert.deepEqual(approval?.body, { response: "always" });
});

test("parse helpers validate their fields", () => {
  assert.deepEqual(parseAuthorResult(AUTHOR), AUTHOR);
  assert.deepEqual(parseReviewerResult(REVIEWER), REVIEWER);
  assert.throws(() => parseAuthorResult({ status: "done" }), AgentError);
  assert.throws(() => parseReviewerResult({ verdict: "maybe", note: "x" }), AgentError);
});
