import type { Board, Column, Task } from "../board/types.ts";
import type { Role } from "../capability/types.ts";
import type { AttemptOutcome } from "../loop/types.ts";
import type { BoardConfig, HostConfig, RuntimeConfig } from "../runtime-config.ts";

export interface Candidate {
  task: Task;
  column: Column;
  role: Role;
  /** The board this task belongs to (task ids are only unique per board). */
  board: BoardConfig;
}

export interface AttemptState {
  round: number;
  attempts: number;
}

export interface TaskStateStore {
  get(boardId: string, taskId: number): AttemptState;
  save(boardId: string, taskId: number, state: AttemptState): void;
}

export type Release = () => void;

/** Composite key for a task across boards (ids are only unique per board). */
export function taskKey(boardId: string, taskId: number): string {
  return `${boardId}:${taskId}`;
}

export interface DaemonDeps {
  config: RuntimeConfig;
  /** Snapshot of one board. */
  snapshot(board: BoardConfig): Promise<Board>;
  claim(candidate: Candidate): Promise<void>;
  release(candidate: Candidate): Promise<void>;
  moveTo(board: BoardConfig, taskId: number, columnName: string): Promise<void>;
  note(board: BoardConfig, taskId: number, note: string): Promise<void>;
  /** Fleet-wide admission control (see docs/limiters.md). */
  admit(input: { provider?: string; mcp?: string }): Promise<Release>;
  /** Run one attempt on a host (wires the TaskLoop + that host's provisioner). */
  runAttempt(candidate: Candidate, host: HostConfig): Promise<AttemptOutcome>;
  state: TaskStateStore;
  log(message: string): void;
}
