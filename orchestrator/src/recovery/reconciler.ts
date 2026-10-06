import type {
  ReconcileReport,
  RecoveryDeps,
  RecoveryTask,
  RunningContainer,
} from "./types.ts";

/**
 * On startup, reconcile `In Progress` tasks against running containers. This is what makes
 * failure recovery safe (ADR 0010): durable state is external, so recovery is a reconcile,
 * not a merge.
 *
 * - orphan containers (no owning task) → destroy + revoke credentials
 * - `In Progress` tasks with no live container → requeue
 * - matched task/container → keep
 *
 * See docs/orchestrator.md#crash-recovery.
 */
export class Reconciler {
  private readonly deps: RecoveryDeps;

  constructor(deps: RecoveryDeps) {
    this.deps = deps;
  }

  async reconcile(): Promise<ReconcileReport> {
    const [tasks, containers] = await Promise.all([
      this.deps.inProgressTasks(),
      this.deps.runningContainers(),
    ]);

    const owned = new Set<string>();
    const requeued: string[] = [];
    const kept: string[] = [];

    for (const task of tasks) {
      const container = this.findContainer(task, containers);
      if (container === null) {
        await this.deps.requeue(task.taskId);
        requeued.push(task.taskId);
      } else {
        owned.add(container.containerId);
        kept.push(task.taskId);
      }
    }

    const destroyed: string[] = [];
    const revoked: string[] = [];
    for (const container of containers) {
      if (!owned.has(container.containerId)) {
        await this.deps.destroyContainer(container.containerId);
        await this.deps.revokeCredentials(container.containerId);
        destroyed.push(container.containerId);
        revoked.push(container.containerId);
      }
    }

    return { destroyed, revoked, requeued, kept };
  }

  private findContainer(
    task: RecoveryTask,
    containers: RunningContainer[],
  ): RunningContainer | null {
    if (task.containerId !== null) {
      return containers.find((container) => container.containerId === task.containerId) ?? null;
    }
    if (task.capabilityHash !== null) {
      return (
        containers.find((container) => container.capabilityHash === task.capabilityHash) ?? null
      );
    }
    return null;
  }
}
