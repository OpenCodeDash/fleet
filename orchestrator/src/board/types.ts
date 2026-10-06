// Wire types mirroring the backdash kanban REST API. Keep in sync with the
// react-backdash client / the server's OpenAPI document.

export type TaskPriority = "low" | "medium" | "high" | "urgent";

export interface Tag {
  id: number;
  name: string;
  description: string | null;
  prompt: string | null;
  color: string | null;
}

export interface Task {
  id: number;
  columnId: number;
  name: string;
  description: string | null;
  position: number;
  claimedBy: string | null;
  priority: TaskPriority | null;
  estimate: number | null;
  assignee: string | null;
  dueAt: string | null;
  createdAt: string;
  updatedAt: string;
  tags: Tag[];
  dependsOn: number[];
  dependents: number[];
}

export interface Column {
  id: number;
  name: string;
  position: number;
  isQueue: boolean;
  pushDescription: string | null;
  pullDescription: string | null;
  tasks: Task[];
}

export interface BoardSummary {
  id: string;
  name: string;
}

export interface Board extends BoardSummary {
  columns: Column[];
  tags: Tag[];
}

export interface UpdateTaskInput {
  name?: string;
  description?: string;
  priority?: TaskPriority | null;
  estimate?: number | null;
  assignee?: string | null;
  dueAt?: string | null;
  tagIds?: number[];
  dependsOn?: number[];
}

export interface MoveTaskInput {
  columnId: number;
  position?: number;
}
