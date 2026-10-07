import type { AttemptOutcome } from "../loop/types.ts";
import type { HostConfig } from "../runtime-config.ts";
import { selectCandidates } from "./select.ts";
import type { Candidate, DaemonDeps, Release } from "./types.ts";

/** Failures tolerated before a task is escalated to the blocked column. */
const MAX_ATTEMPTS = 2;

/**
 * The fleet control plane: one long-lived loop that claims eligible tasks from the board's
 * author/reviewer queues, places them across hosts, admits them via the scheduler, runs one
 * attempt each concurrently, and handles the outcome (requeue / escalate). Board transitions
 * for *successful* attempts are made by the TaskLoop; the daemon only requeues failures and
 * enforces the review-round / attempt bounds. See docs/architecture.md, ADR 0003.
 */
export class FleetDaemon {
  private readonly deps: DaemonDeps;
  private readonly running = new Map<number, { role: string; host: HostConfig }>();
  private readonly tasks = new Set<Promise<void>>();
  private stopped = false;

  constructor(deps: DaemonDeps) {
    this.deps = deps;
  }

  inFlight(): Array<{ taskId: number; role: string; host: string }> {
    return [...this.running.entries()].map(([taskId, entry]) => ({
      taskId,
      role: entry.role,
      host: entry.host.name,
    }));
  }

  stop(): void {
    this.stopped = true;
  }

  /** Resolve once every in-flight attempt has settled (for shutdown / tests). */
  async waitIdle(): Promise<void> {
    while (this.tasks.size > 0) await Promise.all([...this.tasks]);
  }

  /** One scheduling pass: pick eligible tasks and start them up to the concurrency cap. */
  async tick(): Promise<void> {
    const board = await this.deps.snapshot();
    const candidates = selectCandidates(board, this.deps.config, new Set(this.running.keys()));
    for (const candidate of candidates) {
      if (this.stopped) return;
      if (this.running.size >= this.deps.config.limits.maxContainers) return;
      const host = this.placeHost();
      // Reserve the slot synchronously so the cap holds across a whole tick.
      this.running.set(candidate.task.id, { role: candidate.role, host });
      this.track(this.execute(candidate, host));
    }
  }

  /** Run one candidate to completion on a host. Public for tests / `once` mode. */
  async runCandidate(candidate: Candidate, host: HostConfig): Promise<void> {
    this.running.set(candidate.task.id, { role: candidate.role, host });
    await this.execute(candidate, host);
  }

  private async execute(candidate: Candidate, host: HostConfig): Promise<void> {
    const release: Release = await this.deps.admit({});
    try {
      if (this.stopped) return;
      await this.deps.claim(candidate);
      this.deps.log(`claim #${candidate.task.id} (${candidate.role}) on ${host.name}`);
      const outcome = await this.deps.runAttempt(candidate, host);
      await this.settle(candidate, outcome);
    } catch (error) {
      this.deps.log(
        `#${candidate.task.id} error: ${error instanceof Error ? error.message : String(error)}`,
      );
      await this.escalate(candidate, "internal error");
    } finally {
      try {
        await this.deps.release(candidate);
      } catch {
        // best-effort
      }
      this.running.delete(candidate.task.id);
      release();
    }
  }

  private async settle(candidate: Candidate, outcome: AttemptOutcome): Promise<void> {
    if (outcome.status === "completed") {
      // The TaskLoop already moved the board. Only the review-round bound is ours to track.
      if (outcome.action === "changes-requested") {
        const state = this.deps.state.get(candidate.task.id);
        const round = state.round + 1;
        this.deps.state.save(candidate.task.id, { ...state, round });
        if (round >= this.deps.config.review.maxRounds) {
          await this.escalate(
            candidate,
            `review rounds exhausted (${round}/${this.deps.config.review.maxRounds})`,
          );
        } else {
          await this.deps.note(
            candidate.task.id,
            `round ${round}/${this.deps.config.review.maxRounds}`,
          );
        }
      }
      return;
    }

    const state = this.deps.state.get(candidate.task.id);
    const attempts = state.attempts + 1;
    if (outcome.escalate || attempts > MAX_ATTEMPTS) {
      await this.escalate(candidate, outcome.reason);
      return;
    }
    this.deps.state.save(candidate.task.id, { ...state, attempts });
    await this.deps.note(
      candidate.task.id,
      `attempt ${attempts}/${MAX_ATTEMPTS} failed: ${outcome.reason}`,
    );
    await this.deps.moveTo(candidate.task.id, this.requeueColumn(candidate.role));
  }

  private async escalate(candidate: Candidate, reason: string): Promise<void> {
    await this.deps.note(candidate.task.id, `escalated: ${reason}`);
    await this.deps.moveTo(candidate.task.id, this.deps.config.board.blocked[0] ?? "Need Help");
  }

  private requeueColumn(role: string): string {
    const queues =
      role === "reviewer" ? this.deps.config.board.queues.reviewer : this.deps.config.board.queues.author;
    return queues[0] ?? "Todo";
  }

  private placeHost(): HostConfig {
    const counts = new Map<string, number>();
    for (const host of this.deps.config.hosts) counts.set(host.name, 0);
    for (const entry of this.running.values()) {
      counts.set(entry.host.name, (counts.get(entry.host.name) ?? 0) + 1);
    }
    const sorted = [...this.deps.config.hosts].sort(
      (a, b) => (counts.get(a.name) ?? 0) - (counts.get(b.name) ?? 0),
    );
    return sorted[0] as HostConfig;
  }

  private track(promise: Promise<void>): void {
    this.tasks.add(promise);
    void promise.finally(() => this.tasks.delete(promise));
  }
}
