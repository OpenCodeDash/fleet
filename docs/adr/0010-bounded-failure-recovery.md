# 0010. Failures are classified; recover by bounded retry/requeue from external state

Status: accepted
Task: #93

## Context

Containers are ephemeral and can die (OOM, crash) mid-task; infrastructure can blip. We need
a recovery policy that neither loses work nor loops forever, given that container-local
state is gone on failure.

## Decision

Classify failures (transient infra, agent stuck, container death, verification failure,
budget exceeded) and apply a **bounded** response: retry or requeue up to a configured
limit, then move the task to `Need Help`. Requeue restarts from the pushed branch
`head_sha` if one exists, else from base. Agents must **push early** so partial work
survives.

## Consequences

- Recovery leans on git + the board, never on container state — consistent with
  [ADR 0001](0001-one-container-per-task.md).
- A crash-loop is bounded by retry counters stored on the durable task record.
- Work is only recoverable if pushed; unpushed progress is lost on container death, which is
  why "push early" is a hard requirement, not advice.
- Idempotent verify-then-transition ([ADR 0003](0003-orchestrator-owns-board.md)) makes
  requeue safe to repeat.

## Alternatives rejected

- **Restart in place** — the container is gone; there is nothing to restart.
- **Unbounded retry** — masks permanent failures and burns budget.
- **Recover from container state** — none survives teardown.
