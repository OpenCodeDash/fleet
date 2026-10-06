export interface RecoveryTask {
  taskId: string;
  /** Container the task was assigned to, if any. */
  containerId: string | null;
  /** Capability hash recorded when the container was provisioned. */
  capabilityHash: string | null;
}

export interface RunningContainer {
  containerId: string;
  capabilityHash: string | null;
}

export interface RecoveryDeps {
  inProgressTasks(): Promise<RecoveryTask[]>;
  runningContainers(): Promise<RunningContainer[]>;
  destroyContainer(containerId: string): Promise<void>;
  revokeCredentials(containerId: string): Promise<void>;
  requeue(taskId: string): Promise<void>;
}

export interface ReconcileReport {
  destroyed: string[];
  revoked: string[];
  requeued: string[];
  kept: string[];
}
