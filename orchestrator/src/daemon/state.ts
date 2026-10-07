import { DatabaseSync } from "node:sqlite";
import type { AttemptState, TaskStateStore } from "./types.ts";

export interface RunningRecord {
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
 * in-flight attempt index used by the status surface and crash recovery.
 */
export class SqliteStateStore implements TaskStateStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        task_id INTEGER PRIMARY KEY,
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

  get(taskId: number): AttemptState {
    const row = this.db
      .prepare("SELECT round, attempts FROM tasks WHERE task_id = ?")
      .get(taskId) as { round: number; attempts: number } | undefined;
    return { round: row?.round ?? 0, attempts: row?.attempts ?? 0 };
  }

  save(taskId: number, state: AttemptState): void {
    this.db
      .prepare(
        `INSERT INTO tasks (task_id, round, attempts) VALUES (?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET round = excluded.round, attempts = excluded.attempts`,
      )
      .run(taskId, state.round, state.attempts);
  }

  /** Record an in-flight attempt (also the crash-recovery index). */
  startRunning(record: RunningRecord): void {
    this.db
      .prepare(
        `INSERT INTO tasks (task_id, role, host, container_id, capability_hash, session_id)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET
           role = excluded.role, host = excluded.host,
           container_id = excluded.container_id,
           capability_hash = excluded.capability_hash,
           session_id = excluded.session_id`,
      )
      .run(
        record.taskId,
        record.role,
        record.host,
        record.containerId,
        record.capabilityHash,
        record.sessionId,
      );
  }

  stopRunning(taskId: number): void {
    this.db
      .prepare(
        "UPDATE tasks SET container_id = NULL, capability_hash = NULL, session_id = NULL WHERE task_id = ?",
      )
      .run(taskId);
  }

  running(): RunningRecord[] {
    const rows = this.db
      .prepare(
        `SELECT task_id, role, host, container_id, capability_hash, session_id
         FROM tasks WHERE container_id IS NOT NULL`,
      )
      .all() as Array<{
      task_id: number;
      role: string;
      host: string;
      container_id: string | null;
      capability_hash: string | null;
      session_id: string | null;
    }>;
    return rows.map((row) => ({
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
