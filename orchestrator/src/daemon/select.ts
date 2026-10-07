import type { Board } from "../board/types.ts";
import type { RuntimeConfig } from "../runtime-config.ts";
import type { Candidate } from "./types.ts";

const PRIORITY_ORDER: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

/** Whether a task's prerequisites (dependsOn) are all in the done column. */
function depsSatisfied(task: { dependsOn: number[] }, doneIds: Set<number>): boolean {
  return task.dependsOn.every((id) => doneIds.has(id));
}

function compare(a: Candidate, b: Candidate): number {
  const pa = PRIORITY_ORDER[a.task.priority ?? "low"] ?? 3;
  const pb = PRIORITY_ORDER[b.task.priority ?? "low"] ?? 3;
  if (pa !== pb) return pa - pb;
  return a.task.position - b.task.position;
}

/**
 * Eligible work: tasks in an author or reviewer queue that are unclaimed, not already
 * running, and whose prerequisites are Done — ordered by priority then board position.
 */
export function selectCandidates(
  board: Board,
  config: RuntimeConfig,
  running: Set<number>,
): Candidate[] {
  const doneIds = new Set<number>();
  for (const column of board.columns) {
    if (column.name === config.board.done) {
      for (const task of column.tasks) doneIds.add(task.id);
    }
  }
  const authorQueues = new Set(config.board.queues.author);
  const reviewerQueues = new Set(config.board.queues.reviewer);
  const blocked = new Set(config.board.blocked);

  const candidates: Candidate[] = [];
  for (const column of board.columns) {
    if (blocked.has(column.name)) continue;
    const role = authorQueues.has(column.name)
      ? "author"
      : reviewerQueues.has(column.name)
        ? "reviewer"
        : undefined;
    if (role === undefined) continue;
    for (const task of column.tasks) {
      if (task.claimedBy !== null) continue;
      if (running.has(task.id)) continue;
      if (!depsSatisfied(task, doneIds)) continue;
      candidates.push({ task, column, role });
    }
  }
  return candidates.sort(compare);
}
