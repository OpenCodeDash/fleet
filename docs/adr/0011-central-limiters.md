# 0011. Cross-container limiters live in the control plane

Status: accepted
Task: #94

## Context

With ~10 concurrent agents sharing provider quotas, MCP endpoints, and one host, per-container
limits cannot prevent the fleet from collectively overrunning a shared resource.

## Decision

All cross-container limiting lives in the orchestrator: a fleet-wide scheduler plus token
buckets per provider and per MCP endpoint. Containers reach providers/MCPs only through the
egress proxy, which enforces the shared limits. Defaults: `maxContainers 10`,
`providerConcurrency 4`, `mcpConcurrency 5`.

## Consequences

- No single agent can saturate a provider; 429 storms are avoided by smoothing centrally.
- Admission is a queue, so tasks can wait — that wait counts against `task.budget`.
- The egress proxy doubles as the enforcement and observation point (see
  [ADR 0008](0008-egress-default-deny.md), [observability](../observability.md)).
- Limiter state is control-plane state, independent of any container lifecycle.

## Alternatives rejected

- **Per-container limits** — cannot see fleet-wide load; the sum can still exceed the quota.
- **No limits, rely on provider 429 backoff** — expensive retries and uneven fairness.
- **Limits baked into each container** — changes require rebuilding containers, not config.
