# Orchestrator configuration

Read when adding, changing, or overriding an orchestrator setting.

Every tunable has a built-in sane default. Set them in `orchestrator.yaml` (path via
`FLEET_CONFIG`, default `./orchestrator.yaml`; see `orchestrator/orchestrator.example.yaml`).
Secrets are written as `${env:NAME}` and resolved from the environment. Config is
schema-validated at startup; an invalid or floor-violating value aborts startup.

## Precedence

```
built-in defaults  <  orchestrator.yaml  <  ${env:NAME} substitution
```

**Security floors are not overridable** — not by config, env, CLI, or the per-repo manifest:

- default-deny capabilities (see [capability-compiler](capability-compiler.md)),
- default-deny egress (see [egress](egress.md)),
- orchestrator board ownership (see [ADR 0003](adr/0003-orchestrator-owns-board.md)),
- secret redaction on ingest (see [observability](observability.md)).

A value that would loosen a floor is rejected at startup, not silently clamps.

## Tunables

| Key | Default | Meaning | Detail |
| --- | ------- | ------- | ------ |
| `credentials.ttl` | `1h` | minted token lifetime | [credentials.md](credentials.md) |
| `credentials.revokeOnDestroy` | `true` | revoke tokens at teardown | [credentials.md](credentials.md) |
| `hosts[].egress.adminUrl` | — | host egress admin the orchestrator registers allowlists with | [egress.md](egress.md) |
| `hosts[].egress.proxyUrl` | — | proxy URL the container's opencode/git use | [egress.md](egress.md) |
| `hosts[].egress.base` | `[]` | static allowlist hosts (orchestrator + model provider) | [egress.md](egress.md) |
| `hosts[].egress.noProxy` | `[localhost, 127.0.0.1]` | hosts that bypass the proxy | [egress.md](egress.md) |
| `review.maxRounds` | `3` | review iterations before `Need Help` | [handoff.md](handoff.md#iteration-bound) |
| `provision.retries` | `2` | provision attempts before `Need Help` | [orchestrator.md](orchestrator.md#failure-semantics) |
| `verify.retries` | `2` | handoff re-validations before `Need Help` | [orchestrator.md](orchestrator.md#failure-semantics) |
| `run.idleTimeout` | `10m` | no-event window before nudge, then abort | [orchestrator.md](orchestrator.md#failure-semantics) |
| `task.budget` | `60m` | wall-clock cap per task | [orchestrator.md](orchestrator.md#failure-semantics) |
| `limits.maxContainers` | `10` | concurrent containers | [limiters.md](limiters.md) |
| `limits.providerConcurrency` | `4` | concurrent LLM calls per provider | [limiters.md](limiters.md) |
| `limits.mcpConcurrency` | `5` | concurrent calls per MCP endpoint | [limiters.md](limiters.md) |
| `observability.flushTimeout` | `30s` | max wait to flush events before destroy | [observability.md](observability.md) |
| `observability.retention` | `30d` | event/audit retention | [observability.md](observability.md) |

Role policies are **not** config keys — they live in the
[capability compiler](capability-compiler.md#role-base-policies).

## Per-repo manifest vs orchestrator config

`.fleet/capabilities.json` (per repo) may **request capabilities** only. It cannot change
roles, limits, egress, or any floor — the [capability compiler](capability-compiler.md)
validates requests against policy and rejects over-reach.
