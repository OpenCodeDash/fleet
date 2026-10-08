import { DatabaseSync } from "node:sqlite";
import { taskKey, type AttemptState, type TaskStateStore } from "./types.ts";

export interface RunningRecord {
  boardId: string;
  taskId: number;
  role: string;
  host: string;
  containerId: string | null;
  capabilityHash: string | null;
  sessionId: string | null;
}

/**
 * Durable daemon state (Node built-in `node:sqlite`). Holds the per-task review-round and
 * attempt counters (which must survive container teardown and orchestrator restarts) and the
 * in-flight attempt index used by the status surface and crash recovery. Keyed by
 * `boardId:taskId` because task ids are only unique per board.
 */
export class SqliteStateStore implements TaskStateStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    // Older builds keyed by task_id only; recreate the table when the schema predates task_key.
    const cols = this.db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    if (cols.length > 0 && !cols.some((column) => column.name === "task_key")) {
      this.db.exec("DROP TABLE tasks");
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        task_key TEXT PRIMARY KEY,
        board_id TEXT NOT NULL DEFAULT '',
        task_id INTEGER NOT NULL DEFAULT 0,
        role TEXT NOT NULL DEFAULT '',
        round INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0,
        container_id TEXT,
        capability_hash TEXT,
        session_id TEXT,
        host TEXT NOT NULL DEFAULT ''
      )
    `);
  }

  get(boardId: string, taskId: number): AttemptState {
    const row = this.db
      .prepare("SELECT round, attempts FROM tasks WHERE task_key = ?")
      .get(taskKey(boardId, taskId)) as { round: number; attempts: number } | undefined;
    return { round: row?.round ?? 0, attempts: row?.attempts ?? 0 };
  }

  save(boardId: string, taskId: number, state: AttemptState): void {
    this.db
      .prepare(
        `INSERT INTO tasks (task_key, board_id, task_id, round, attempts) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(task_key) DO UPDATE SET round = excluded.round, attempts = excluded.attempts`,
      )
      .run(taskKey(boardId, taskId), boardId, taskId, state.round, state.attempts);
  }

  /** Record an in-flight attempt (also the crash-recovery index). */
  startRunning(record: RunningRecord): void {
    this.db
      .prepare(
        `INSERT INTO tasks (task_key, board_id, task_id, role, host, container_id, capability_hash, session_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_key) DO UPDATE SET
           role = excluded.role, host = excluded.host,
           container_id = excluded.container_id,
           capability_hash = excluded.capability_hash,
           session_id = excluded.session_id`,
      )
      .run(
        taskKey(record.boardId, record.taskId),
        record.boardId,
        record.taskId,
        record.role,
        record.host,
        record.containerId,
        record.capabilityHash,
        record.sessionId,
      );
  }

  stopRunning(boardId: string, taskId: number): void {
    this.db
      .prepare(
        "UPDATE tasks SET container_id = NULL, capability_hash = NULL, session_id = NULL WHERE task_key = ?",
      )
      .run(taskKey(boardId, taskId));
  }

  running(): RunningRecord[] {
    const rows = this.db
      .prepare(
        `SELECT board_id, task_id, role, host, container_id, capability_hash, session_id
         FROM tasks WHERE container_id IS NOT NULL`,
      )
      .all() as Array<{
      board_id: string;
      task_id: number;
      role: string;
      host: string;
      container_id: string | null;
      capability_hash: string | null;
      session_id: string | null;
    }>;
    return rows.map((row) => ({
      boardId: row.board_id,
      taskId: row.task_id,
      role: row.role,
      host: row.host,
      containerId: row.container_id,
      capabilityHash: row.capability_hash,
      sessionId: row.session_id,
    }));
  }

  close(): void {
    this.db.close();
  }
}
