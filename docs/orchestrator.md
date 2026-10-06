# Orchestrator

Read when working on the control-plane loop: claiming tasks, provisioning, driving a
session, detecting completion, and tearing down.

The orchestrator is the control plane and the **only actor that writes board state**. Agents
propose a result; the orchestrator validates and commits the transition. See
[ADR 0003](adr/0003-orchestrator-owns-board.md).

## States

| State | Meaning |
| ----- | ------- |
| `IDLE` | No task in flight |
| `CLAIMED` | Task claimed from a queue column (`Todo` / `Changes Requested`) |
| `COMPILED` | Capability set compiled; `capabilityHash` recorded (see [capability-compiler](capability-compiler.md)) |
| `PROVISIONING` | Container being started |
| `READY` | `opencode serve` healthy |
| `RUNNING` | Session created; prompt sent; agent working |
| `VERIFYING` | Agent returned a completion result; handoff being validated |
| `COLLECTING` | Flushing events, storing audit |
| `DESTROYING` | Tearing the container down |
| `DONE` | Terminal success |
| `FAILED` | Terminal for the attempt; the task is requeued or escalated |

## Transitions

| From | Trigger | To | Action |
| ---- | ------- | -- | ------ |
| `IDLE` | Task available in a queue column | `CLAIMED` | Claim task |
| `CLAIMED` | Compiler returns | `COMPILED` | Record `capabilityHash` |
| `CLAIMED` | `CapabilityError` | `FAILED` | Task → `Need Help` |
| `COMPILED` | Credentials minted | `PROVISIONING` | Create ephemeral container |
| `COMPILED` | Mint failure | `FAILED` | Requeue |
| `PROVISIONING` | `/global/health` ok | `READY` | Create session |
| `PROVISIONING` | Timeout / crash | `FAILED` | Destroy; retry ≤ N |
| `READY` | Session created | `RUNNING` | `promptAsync` |
| `RUNNING` | Completion result received | `VERIFYING` | Validate handoff |
| `RUNNING` | No event for `idleTimeout` | `FAILED` | Nudge, then abort → destroy → requeue |
| `RUNNING` | Container exits | `FAILED` | Destroy; requeue |
| `VERIFYING` | Valid | `COLLECTING` | Commit board transition |
| `VERIFYING` | Invalid | `RUNNING` | Prompt agent to fix (bounded) |
| `COLLECTING` | Events flushed, audit stored | `DESTROYING` | Destroy container |
| `DESTROYING` | Done | `DONE` | Release claim |

## Completion detection

An agent **never** moves its own task. It returns a structured result; the orchestrator
validates it against the git remote before transitioning. `session.idle` is explicitly
*not* a completion signal — it fires between steps.

```
author result:   { status: "done", branch, head_sha, base_sha, pr_url?, summary }
reviewer result: { verdict: "approve" | "changes", note, pr_review_comments?, merge_sha? }
```

Validation:

- **author** — the remote ref for `branch` exists at `head_sha` (`git ls-remote`).
- **reviewer / approve** — `merge_sha` is an ancestor of `origin/main` and the feature
  branch is deleted.
- **reviewer / changes** — no remote check; transition to `Changes Requested`.

On failure the orchestrator stays in `RUNNING`, tells the agent what is missing, and
re-validates — bounded; after N attempts → `Need Help`.

## Board ownership

The orchestrator is the **sole writer** of board state (create / move / update). Agents get
read-only board tools; the capability compiler denies `kanban_move_task`,
`kanban_update_task`, and the create/delete tools. Notes and summaries are written by the
orchestrator from the agent's structured result.

## Failure semantics

Classify the failure, then either retry or escalate (bounds in
[configuration.md](configuration.md)):

| Class | Example | Action |
| ----- | ------- | ------ |
| Transient infra | provision timeout, proxy blip | retry ≤ `provision.retries`, then `Need Help` |
| Agent stuck | no event for `run.idleTimeout` | nudge; then abort → destroy → requeue (once) |
| Container death | OOM, crash | destroy → requeue (once), then `Need Help` |
| Verification failure | missing remote ref | re-prompt author ≤ `verify.retries`, then `Need Help` |
| Budget exceeded | `task.budget` | destroy → `Need Help` |

Requeue is safe because durable state is external: the board holds the task and git holds
any pushed branch. A requeued task restarts from its branch `head_sha` if one exists, else
from base.

**Push early.** Agents must push progress frequently — anything unpushed is lost when the
container dies. A requeued task with no pushed commits restarts from scratch.

Retries and requeues are bounded and recorded on the durable task record, so a crash-loop
cannot spin forever.

## Crash recovery

On orchestrator restart, reconcile board `In Progress` tasks against running containers by
`capabilityHash` + container id:

- orphan containers (no matching task) → destroy.
- `In Progress` tasks with no container → requeue.
- `VERIFYING` steps are idempotent: "verify remote ref, then transition" can be safely
  retried.
