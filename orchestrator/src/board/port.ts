import type { BoardPort } from "../loop/types.ts";
import { BoardError, columnByName, findTask, type BoardClient } from "./client.ts";

function toTaskId(taskId: string): number {
  const id = Number(taskId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new BoardError(400, `task id "${taskId}" is not a valid numeric id`, null);
  }
  return id;
}

/**
 * Adapts the backdash REST client to the loop's `BoardPort`. The orchestrator is the sole
 * board writer (ADR 0003), so this is the only way tasks move. Column targets are given by
 * name (e.g. `Code Review`); notes append to the task description.
 */
export function createBoardPort(client: BoardClient, boardId: string): BoardPort {
  return {
    async moveTo(taskId, columnName) {
      const id = toTaskId(taskId);
      const board = await client.getBoard(boardId);
      if (findTask(board, id) === undefined) {
        throw new BoardError(404, `task "${taskId}" not found on board "${boardId}"`, null);
      }
      const column = columnByName(board, columnName);
      if (column === undefined) {
        throw new BoardError(404, `column "${columnName}" not on board "${boardId}"`, null);
      }
      await client.move(boardId, id, { columnId: column.id });
    },

    async appendNote(taskId, note) {
      const id = toTaskId(taskId);
      const board = await client.getBoard(boardId);
      const found = findTask(board, id);
      if (found === undefined) {
        throw new BoardError(404, `task "${taskId}" not found on board "${boardId}"`, null);
      }
      const description =
        found.task.description === null || found.task.description.length === 0
          ? note
          : `${found.task.description}\n\n${note}`;
      await client.update(boardId, found.column.id, id, { description });
    },
  };
}
