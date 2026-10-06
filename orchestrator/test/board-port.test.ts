import assert from "node:assert/strict";
import { test } from "node:test";
import { BoardClient, BoardError, createBoardPort, type Board, type Task } from "../src/board/index.ts";
import type { FetchLike } from "../src/provision/index.ts";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 84,
    columnId: 10,
    name: "t",
    description: null,
    position: 0,
    claimedBy: null,
    priority: null,
    estimate: null,
    assignee: null,
    dueAt: null,
    createdAt: "",
    updatedAt: "",
    tags: [],
    dependsOn: [],
    dependents: [],
    ...overrides,
  };
}

function board(): Board {
  return {
    id: "b1",
    name: "B",
    tags: [],
    columns: [
      {
        id: 10,
        name: "Todo",
        position: 0,
        isQueue: true,
        pushDescription: null,
        pullDescription: null,
        tasks: [task({ description: "existing" })],
      },
      {
        id: 11,
        name: "Code Review",
        position: 1,
        isQueue: true,
        pushDescription: null,
        pullDescription: null,
        tasks: [],
      },
    ],
  };
}

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function fakeFetch(): { impl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    calls.push({
      url,
      method,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    const payload = method === "GET" ? board() : { ok: true };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as FetchLike;
  return { impl, calls };
}

test("moveTo resolves the target column by name", async () => {
  const { impl, calls } = fakeFetch();
  const port = createBoardPort(new BoardClient({ url: "http://b", fetchImpl: impl }), "b1");
  await port.moveTo("84", "Code Review");
  const move = calls.find((call) => call.method === "POST");
  assert.equal(move?.url, "http://b/kanban/b1/tasks/84/move");
  assert.deepEqual(move?.body, { columnId: 11 });
});

test("appendNote appends to the task description", async () => {
  const { impl, calls } = fakeFetch();
  const port = createBoardPort(new BoardClient({ url: "http://b", fetchImpl: impl }), "b1");
  await port.appendNote("84", "done");
  const put = calls.find((call) => call.method === "PUT");
  assert.equal(put?.url, "http://b/kanban/b1/columns/10/tasks/84");
  assert.deepEqual(put?.body, { description: "existing\n\ndone" });
});

test("fails on an unknown column or a non-numeric id", async () => {
  const { impl } = fakeFetch();
  const port = createBoardPort(new BoardClient({ url: "http://b", fetchImpl: impl }), "b1");
  await assert.rejects(() => port.moveTo("84", "Nope"), BoardError);
  await assert.rejects(() => port.moveTo("#84", "Todo"), BoardError);
});
