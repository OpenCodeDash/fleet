import type { Board, Column, Task } from "../board/types.ts";
import type { Role } from "../capability/types.ts";
import type { AttemptOutcome } from "../loop/types.ts";
import type { HostConfig, RuntimeConfig } from "../runtime-config.ts";

export interface Candidate {
  task: Task;
  column: Column;
  role: Role;
}

export interface AttemptState {
  round: number;
  attempts: number;
}

export interface TaskStateStore {
  get(taskId: number): AttemptState;
  save(taskId: number, state: AttemptState): void;
}

export type Release = () => void;

export interface DaemonDeps {
  config: RuntimeConfig;
  /** Current board snapshot. */
  snapshot(): Promise<Board>;
  claim(candidate: Candidate): Promise<void>;
  release(candidate: Candidate): Promise<void>;
  moveTo(taskId: number, columnName: string): Promise<void>;
  note(taskId: number, note: string): Promise<void>;
  /** Fleet-wide admission control (see docs/limiters.md). */
  admit(input: { provider?: string; mcp?: string }): Promise<Release>;
  /** Run one attempt on a host (wires the TaskLoop + that host's provisioner). */
  runAttempt(candidate: Candidate, host: HostConfig): Promise<AttemptOutcome>;
  state: TaskStateStore;
  log(message: string): void;
}
