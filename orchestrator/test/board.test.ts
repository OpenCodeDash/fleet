import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BoardClient,
  BoardError,
  columnByName,
  findTask,
  tasksInColumn,
  type Board,
  type Task,
} from "../src/board/index.ts";

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

function fakeFetch(responses: Array<{ status?: number; body?: unknown }>): {
  impl: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
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
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { impl, calls };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 1,
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

const board: Board = {
  id: "b1",
  name: "Test",
  tags: [],
  columns: [
    {
      id: 10,
      name: "Todo",
      position: 0,
      isQueue: true,
      pushDescription: null,
      pullDescription: null,
      tasks: [makeTask({ id: 1, columnId: 10 })],
    },
    {
      id: 11,
      name: "Done",
      position: 1,
      isQueue: false,
      pushDescription: null,
      pullDescription: null,
      tasks: [],
    },
  ],
};

test("listBoards GETs /kanban", async () => {
  const { impl, calls } = fakeFetch([{ body: [{ id: "b1", name: "Test" }] }]);
  const client = new BoardClient({ url: "http://board:3000", fetchImpl: impl });
  const boards = await client.listBoards();
  assert.deepEqual(boards, [{ id: "b1", name: "Test" }]);
  assert.equal(calls[0]?.url, "http://board:3000/kanban");
  assert.equal(calls[0]?.method, "GET");
});

test("getBoard GETs /kanban/:id and normalises a trailing slash", async () => {
  const { impl, calls } = fakeFetch([{ body: board }]);
  const client = new BoardClient({ url: "http://board:3000/", fetchImpl: impl });
  const result = await client.getBoard("b1");
  assert.equal(result.id, "b1");
  assert.equal(calls[0]?.url, "http://board:3000/kanban/b1");
});

test("claim POSTs to the claim endpoint with the actor", async () => {
  const { impl, calls } = fakeFetch([{ body: makeTask({ claimedBy: "NixOS" }) }]);
  const client = new BoardClient({ url: "http://board:3000", fetchImpl: impl });
  await client.claim("b1", 10, 1, "NixOS");
  assert.equal(calls[0]?.url, "http://board:3000/kanban/b1/columns/10/tasks/1/claim");
  assert.equal(calls[0]?.method, "POST");
  assert.deepEqual(calls[0]?.body, { actor: "NixOS" });
});

test("release POSTs to the release endpoint", async () => {
  const { impl, calls } = fakeFetch([{ body: makeTask() }]);
  const client = new BoardClient({ url: "http://board:3000", fetchImpl: impl });
  await client.release("b1", 10, 1);
  assert.equal(calls[0]?.url, "http://board:3000/kanban/b1/columns/10/tasks/1/release");
  assert.deepEqual(calls[0]?.body, {});
});

test("move POSTs to the move endpoint with the target column", async () => {
  const { impl, calls } = fakeFetch([{ body: makeTask({ columnId: 11 }) }]);
  const client = new BoardClient({ url: "http://board:3000", fetchImpl: impl });
  await client.move("b1", 1, { columnId: 11 });
  assert.equal(calls[0]?.url, "http://board:3000/kanban/b1/tasks/1/move");
  assert.deepEqual(calls[0]?.body, { columnId: 11 });
});

test("update PUTs the task column endpoint", async () => {
  const { impl, calls } = fakeFetch([{ body: makeTask({ description: "note" }) }]);
  const client = new BoardClient({ url: "http://board:3000", fetchImpl: impl });
  await client.update("b1", 10, 1, { description: "note" });
  assert.equal(calls[0]?.url, "http://board:3000/kanban/b1/columns/10/tasks/1");
  assert.equal(calls[0]?.method, "PUT");
  assert.deepEqual(calls[0]?.body, { description: "note" });
});

test("throws BoardError with status and message on a non-ok response", async () => {
  const { impl } = fakeFetch([{ status: 404, body: { message: "no such board" } }]);
  const client = new BoardClient({ url: "http://board:3000", fetchImpl: impl });
  await assert.rejects(
    () => client.getBoard("ghost"),
    (error: unknown) =>
      error instanceof BoardError &&
      (error as BoardError).status === 404 &&
      /no such board/.test((error as Error).message),
  );
});

test("helpers look up columns and tasks by name/id", () => {
  assert.equal(columnByName(board, "Todo")?.id, 10);
  assert.equal(tasksInColumn(board, "Todo").length, 1);
  assert.equal(tasksInColumn(board, "Missing").length, 0);
  assert.equal(findTask(board, 1)?.column.name, "Todo");
  assert.equal(findTask(board, 999), undefined);
});
