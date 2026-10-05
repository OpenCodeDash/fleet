# Global limiters

Read when working on concurrency, provider rate limits, or fairness across containers.

Provider rate limits, shared MCP endpoints, and the host itself are cross-container
contention points. A per-container limit cannot see the whole fleet, so limiting lives in the
control plane. See [ADR 0011](adr/0011-central-limiters.md).

## Limiters

Overridable — see [configuration.md](configuration.md):

| Limiter | Default | Scope |
| ------- | ------- | ----- |
| `limits.maxContainers` | `10` | fleet-wide concurrent containers |
| `limits.providerConcurrency` | `4` | concurrent LLM calls per provider |
| `limits.mcpConcurrency` | `5` | concurrent calls per MCP endpoint |

## Model

- A **scheduler** admits a task only when container, provider, and MCP slots are free;
  otherwise the task stays queued (`CLAIMED` / `PROVISIONING`).
- **Token buckets** in the control plane smooth bursts per provider and per MCP endpoint.
  Containers reach providers/MCPs only through the egress proxy (see
  [egress.md](egress.md)), which is the shared choke point.
- Limits are **global**, not per container, so ten agents cannot each independently saturate
  a provider.

## Why central

- MCP endpoints are shared state; concurrent mutation must be serialized.
- Provider 429s cost retries; smoothing upstream is cheaper than per-container backoff.
- The host has finite CPU/memory; `maxContainers` protects it.

## Failure interaction

- Admission wait counts against `task.budget` (see
  [orchestrator.md](orchestrator.md#failure-semantics)).
- A limiter that never frees a slot is surfaced (metric → `Need Help`), never a silent hang.
