import { CapabilityError } from "../capability/types.ts";
import type { EventSink } from "../observability/index.ts";
import type { ContainerHandle } from "../provision/types.ts";
import type {
  AttemptOutcome,
  AuthorResult,
  LoopDeps,
  ReviewerResult,
  TaskAttempt,
} from "./types.ts";

interface VerifyCheck {
  ok: boolean;
  reason: string;
}

/**
 * Runs one task attempt through the control-plane state machine:
 *   compile → mint → provision → run agent → verify handoff → board transition → teardown.
 *
 * The orchestrator is the only board writer (ADR 0003): the agent returns a structured
 * result, the loop validates it against the git remote, and only then transitions. Teardown
 * always flushes the event sink before destroying the container (ADR 0005).
 * See docs/orchestrator.md.
 */
export class TaskLoop {
  private readonly deps: LoopDeps;

  constructor(deps: LoopDeps) {
    this.deps = deps;
  }

  async run(attempt: TaskAttempt): Promise<AttemptOutcome> {
    let handle: ContainerHandle | null = null;
    let sink: EventSink | null = null;
    let minted = false;
    try {
      const compiled = this.deps.compile({
        taskId: attempt.taskId,
        repo: attempt.repo,
        role: attempt.role,
        grants: attempt.grants,
      });
      const credentials = await this.deps.mintCredentials(
        attempt.containerId,
        compiled.credentials,
      );
      minted = true;
      sink = this.deps.sinkFor(
        {
          taskId: attempt.taskId,
          containerId: attempt.containerId,
          sessionId: attempt.containerId,
          role: attempt.role,
          capabilityHash: compiled.capabilityHash,
        },
        Object.values(credentials.env),
      );
      await sink.record({
        source: "lifecycle",
        type: "compiled",
        data: { capabilityHash: compiled.capabilityHash, servers: compiled.audit.servers },
      });

      handle = await this.deps.provision({
        name: attempt.containerId,
        modulePath: this.deps.modulePath,
        configFiles: this.deps.configFilesFor(attempt.containerId),
        port: this.deps.port,
      });
      await sink.record({
        source: "lifecycle",
        type: "provisioned",
        data: { container: attempt.containerId, address: handle.address },
      });

      const outcome =
        attempt.role === "author"
          ? await this.runAuthor(attempt, sink, handle.address)
          : await this.runReviewer(attempt, sink, handle.address);

      await sink.flush();
      await this.deps.destroy(handle);
      await this.deps.revokeCredentials(attempt.containerId);
      return outcome;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (sink !== null) {
        try {
          await sink.record({ source: "lifecycle", type: "error", data: reason });
        } catch {
          // best-effort
        }
      }
      await this.cleanup(sink, handle, attempt.containerId, minted);
      return { status: "failed", reason, escalate: error instanceof CapabilityError };
    }
  }

  private async runAuthor(
    attempt: TaskAttempt,
    sink: EventSink,
    address: string,
  ): Promise<AttemptOutcome> {
    let lastReason = "";
    for (let round = 0; round <= this.deps.verifyRetries; round += 1) {
      const prompt =
        round === 0
          ? attempt.prompt
          : `Your handoff failed verification: ${lastReason}. Fix it and return the result again.`;
      const completion = await this.deps.runAgent({
        address,
        role: "author",
        prompt,
        sessionTitle: attempt.taskId,
        sink,
      });
      const result = completion.kind === "author" ? completion.result : null;
      if (result === null) {
        lastReason = "agent returned a non-author result";
      } else {
        const check = await this.verifyAuthor(result);
        if (check.ok) {
          await this.deps.board.appendNote(attempt.taskId, result.summary);
          await this.deps.board.moveTo(attempt.taskId, "Code Review");
          return { status: "completed", action: "code-review" };
        }
        lastReason = check.reason;
      }
      await sink.record({ source: "lifecycle", type: "verify-failed", data: lastReason });
    }
    return {
      status: "failed",
      reason: lastReason || "author handoff could not be verified",
      escalate: false,
    };
  }

  private async runReviewer(
    attempt: TaskAttempt,
    sink: EventSink,
    address: string,
  ): Promise<AttemptOutcome> {
    const completion = await this.deps.runAgent({
      address,
      role: "reviewer",
      prompt: attempt.prompt,
      sessionTitle: attempt.taskId,
      sink,
    });
    const result = completion.kind === "reviewer" ? completion.result : null;
    if (result === null) {
      return { status: "failed", reason: "agent returned a non-reviewer result", escalate: false };
    }
    if (result.verdict === "changes") {
      await this.deps.board.appendNote(attempt.taskId, result.note);
      await this.deps.board.moveTo(attempt.taskId, "Changes Requested");
      return { status: "completed", action: "changes-requested" };
    }
    const check = await this.verifyReviewer(attempt, result);
    if (!check.ok) {
      await sink.record({ source: "lifecycle", type: "verify-failed", data: check.reason });
      return { status: "failed", reason: check.reason, escalate: false };
    }
    await this.deps.board.moveTo(attempt.taskId, "Done");
    return { status: "completed", action: "done" };
  }

  private async verifyAuthor(result: AuthorResult): Promise<VerifyCheck> {
    if (!result.branch || !result.head_sha) {
      return { ok: false, reason: "author result is missing branch or head_sha" };
    }
    const exists = await this.deps.git.remoteRefExists(result.branch, result.head_sha);
    return exists
      ? { ok: true, reason: "" }
      : { ok: false, reason: `remote ref ${result.branch}@${result.head_sha} not found` };
  }

  private async verifyReviewer(attempt: TaskAttempt, result: ReviewerResult): Promise<VerifyCheck> {
    if (!result.merge_sha) {
      return { ok: false, reason: "approve verdict without merge_sha" };
    }
    if (!(await this.deps.git.isAncestorOfMain(result.merge_sha))) {
      return { ok: false, reason: `merge ${result.merge_sha} is not on main` };
    }
    if (attempt.branch !== undefined && !(await this.deps.git.branchDeleted(attempt.branch))) {
      return { ok: false, reason: `branch ${attempt.branch} was not deleted` };
    }
    return { ok: true, reason: "" };
  }

  private async cleanup(
    sink: EventSink | null,
    handle: ContainerHandle | null,
    containerId: string,
    minted: boolean,
  ): Promise<void> {
    if (sink !== null) {
      try {
        await sink.flush();
      } catch {
        // best-effort
      }
    }
    if (handle !== null) {
      try {
        await this.deps.destroy(handle);
      } catch {
        // best-effort
      }
    }
    if (minted) {
      try {
        await this.deps.revokeCredentials(containerId);
      } catch {
        // best-effort
      }
    }
  }
}
