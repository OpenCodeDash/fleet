# Container lifecycle model

Status: **decided** (board task #84).

## Decision

One container per task attempt: container == opencode server == opencode session. No warm
pool in v1; cold spawn via `systemd-nspawn` with `containers.<name>.ephemeral = true`.

## Rationale

- **Isolation** — fresh rootfs per attempt, no cross-task contamination.
- **Auditability** — the capability-config hash maps 1:1 to container id and task id.
- **Simplicity** — no pool state machine, no per-task capability re-render.
- **State is external** — git + board already hold everything durable, so teardown loses
  nothing of value.
- **Cost** — nspawn cold start is seconds; at ~10 concurrent this is acceptable.

## Rejected alternatives

- **Warm worker handling multiple tasks** — residual state between tasks, and the
  capability set would have to be re-rendered per task, contradicting
  immutable-at-creation. Weaker audit trail.
- **Long-lived container with multiple opencode sessions** — same problems.
- **MicroVM (Firecracker/Kata)** — stronger isolation, deferred. Revisit if the threat
  model includes container escapes.

## Revisit triggers

- Spawn latency dominates session length → add a warm pool of pre-booted, capability-less
  containers whose config is mounted at claim time. The compiler is designed so pooling is
  additive, not a rewrite.
- Threat model hardens → move to microVMs behind the same provisioner interface.

## Consequences

- A `Changes Requested` fix is always a new container resuming from the pushed branch.
- All progress must be pushed to survive teardown — agents push early and often.
