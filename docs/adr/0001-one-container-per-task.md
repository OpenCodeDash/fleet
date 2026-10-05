# 0001. One container per task attempt

Status: accepted
Task: #84

## Context

The fleet runs ~10 concurrent agents. We must fix the unit of container lifecycle:
a container per task attempt, a warm worker that handles several tasks, or one long-lived
container hosting many sessions.

## Decision

One container per task attempt: container == `opencode serve` == opencode session.
Cold spawn via `systemd-nspawn` with `containers.<name>.ephemeral = true`; no warm pool
in v1.

## Consequences

- Fresh rootfs per attempt → no cross-task contamination. `config-hash ↔ container-id ↔
  task-id` is 1:1 and auditable.
- No pool state machine and no per-task capability re-render.
- A `Changes Requested` fix is always a new container resuming from the pushed branch.
- All progress must be pushed to survive teardown.

## Alternatives rejected

- **Warm worker handling multiple tasks** — residual state, capability set would need
  re-rendering per task (contradicts immutable-at-creation), weaker audit trail.
- **Long-lived container with multiple sessions** — same problems.
- **MicroVM (Firecracker/Kata)** — stronger isolation, deferred.

## Revisit triggers

- Spawn latency dominates session length → add a warm pool of pre-booted, capability-less
  containers whose config is mounted at claim time. Pooling is additive; the compiler
  contract does not change.
- Threat model requires container-escape resistance → move to microVMs behind the same
  provisioner interface.
