import type { Board, BoardSummary, Column, MoveTaskInput, Task, UpdateTaskInput } from "./types.ts";

export class BoardError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = "BoardError";
    this.status = status;
    this.body = body;
  }
}

export interface BoardClientOptions {
  /** Base URL of the backdash server, e.g. `http://localhost:3000`. */
  url: string;
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
}

/**
 * Client for the backdash kanban REST API. The orchestrator is the sole board writer
 * (ADR 0003), so every mutating method here is used only by the control plane.
 */
export class BoardClient {
  readonly url: string;
  private readonly fetchImpl: typeof fetch;
  private readonly headers: Record<string, string>;

  constructor(options: BoardClientOptions) {
    if (!options.url) throw new Error("BoardClient: url is required");
    this.url = options.url.replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.headers = { "Content-Type": "application/json", ...options.headers };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const doFetch = this.fetchImpl;
    const response = await doFetch(`${this.url}${path}`, {
      method,
      headers: this.headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let data: unknown = null;
    if (text.length > 0) {
      try {
        data = JSON.parse(text);
      } catch {
        // a non-JSON body (e.g. an HTML error page) must not mask the HTTP status
        data = text;
      }
    }
    if (!response.ok) {
      const message =
        data !== null && typeof data === "object" && "message" in data && data.message
          ? String((data as { message: unknown }).message)
          : `request failed: ${response.status} ${response.statusText}`;
      throw new BoardError(response.status, message, data);
    }
    return data as T;
  }

  listBoards(): Promise<BoardSummary[]> {
    return this.request<BoardSummary[]>("GET", "/kanban");
  }

  getBoard(id: string): Promise<Board> {
    return this.request<Board>("GET", `/kanban/${id}`);
  }

  claim(boardId: string, columnId: number, taskId: number, actor?: string): Promise<Task> {
    return this.request<Task>(
      "POST",
      `/kanban/${boardId}/columns/${columnId}/tasks/${taskId}/claim`,
      { actor },
    );
  }

  release(boardId: string, columnId: number, taskId: number): Promise<Task> {
    return this.request<Task>(
      "POST",
      `/kanban/${boardId}/columns/${columnId}/tasks/${taskId}/release`,
      {},
    );
  }

  move(boardId: string, taskId: number, input: MoveTaskInput): Promise<Task> {
    return this.request<Task>("POST", `/kanban/${boardId}/tasks/${taskId}/move`, input);
  }

  update(boardId: string, columnId: number, taskId: number, input: UpdateTaskInput): Promise<Task> {
    return this.request<Task>(
      "PUT",
      `/kanban/${boardId}/columns/${columnId}/tasks/${taskId}`,
      input,
    );
  }
}

export function columnByName(board: Board, name: string): Column | undefined {
  return board.columns.find((column) => column.name === name);
}

export function tasksInColumn(board: Board, name: string): Task[] {
  return columnByName(board, name)?.tasks ?? [];
}

export function findTask(board: Board, taskId: number): { task: Task; column: Column } | undefined {
  for (const column of board.columns) {
    const task = column.tasks.find((entry) => entry.id === taskId);
    if (task !== undefined) return { task, column };
  }
  return undefined;
}
