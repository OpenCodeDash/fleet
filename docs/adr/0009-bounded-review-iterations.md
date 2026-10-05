# 0009. Review iterations are bounded and escalate to `Need Help`

Status: accepted
Task: #92

## Context

Author and reviewer are independent agents in ephemeral containers. Without a limit, a
reviewer who keeps finding (or inventing) issues and an author who keeps missing them can
loop forever, burning containers and provider budget.

## Decision

Cap author↔reviewer rounds per task at `review.maxRounds` (default `3`). The counter lives
on the **durable task record** (board + audit), not in a container. On exceeding the bound,
the orchestrator moves the task to `Need Help` rather than spawning another author container.

## Consequences

- Runaway loops are impossible; stuck tasks surface to a human instead of spinning.
- The bound is tunable per repo without a code change.
- The counter must be durable (survives teardown and orchestrator restart), so it is task
  state, consistent with [ADR 0003](0003-orchestrator-owns-board.md).

## Alternatives rejected

- **Unbounded iterations** — cost blowups and indefinite loops.
- **Counter in the container** — lost on teardown, so the bound would reset every round.
- **Hard-coded bound** — no per-repo tuning; rejected in favour of a config default.
