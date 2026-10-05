# 0003. The orchestrator owns board transitions

Status: accepted
Task: #86

## Context

Agents can already reach the board through the kanban MCP. If an agent moves its own task,
it can mark work done prematurely, and the board loses a single writer — making state hard
to reconcile after a crash or a duplicated agent.

## Decision

The orchestrator is the **sole writer** of board state. Agents return a **structured
completion result**; the orchestrator validates it against the git remote and then performs
the transition. Agents receive read-only board tools; the capability compiler denies
`kanban_move_task`, `kanban_update_task`, and the create/delete tools.

`session.idle` is not a completion signal (it fires between steps); completion is the
validated structured result (see [orchestrator.md](../orchestrator.md)).

## Consequences

- Completion is **verifiable and idempotent**: verify-then-transition can be retried safely.
- Board state has a single writer, so crash recovery is a reconcile, not a merge.
- Agents must emit structured output; free-text "I'm done" cannot advance a task.
- Premature "done" is impossible — a missing remote ref keeps the task `In Progress`.

## Alternatives rejected

- **Agents move their own tasks** — premature completion, multiple writers, hard recovery.
- **`session.idle` as completion** — fires between every step; would end tasks mid-work.
