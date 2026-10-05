# Orchestrator configuration

Read when adding, changing, or overriding an orchestrator setting.

Every tunable has a built-in sane default. Override in `orchestrator.toml` at the repo root,
or with `FLEET_*` environment variables. Config is schema-validated at startup; an invalid
or floor-violating value aborts startup.

## Precedence

```
built-in defaults  <  orchestrator.toml  <  FLEET_* env  <  CLI flags
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
| `roles.*` | (built-in) | per-role permission/credential policy | [capability-compiler.md](capability-compiler.md#role-base-policies) |
| `credentials.ttl` | `1h` | minted token lifetime | [credentials.md](credentials.md) |
| `credentials.revokeOnDestroy` | `true` | revoke tokens at teardown | [credentials.md](credentials.md) |
| `egress.mode` | `deny` | default-deny; `allow` is a floor violation | [egress.md](egress.md) |
| `egress.allow` | `[]` | extra allowlist hosts (on top of orchestrator + granted MCPs) | [egress.md](egress.md) |
| `egress.proxy` | required | HTTP(S) proxy that enforces the allowlist | [egress.md](egress.md) |
| `review.maxRounds` | `3` | review iterations before `Need Help` | [failure.md](failure.md) |
| `provision.retries` | `2` | provision attempts before `Need Help` | [failure.md](failure.md) |
| `verify.retries` | `2` | handoff re-validations before `Need Help` | [failure.md](failure.md) |
| `run.idleTimeout` | `10m` | no-event window before nudge, then abort | [failure.md](failure.md) |
| `task.budget` | `60m` | wall-clock cap per task | [failure.md](failure.md) |
| `limits.maxContainers` | `10` | concurrent containers | [limiters.md](limiters.md) |
| `limits.providerConcurrency` | `4` | concurrent LLM calls per provider | [limiters.md](limiters.md) |
| `limits.mcpConcurrency` | `5` | concurrent calls per MCP endpoint | [limiters.md](limiters.md) |
| `observability.flushTimeout` | `30s` | max wait to flush events before destroy | [observability.md](observability.md) |
| `observability.retention` | `30d` | event/audit retention | [observability.md](observability.md) |

## Per-repo manifest vs orchestrator config

`.fleet/capabilities.json` (per repo) may **request capabilities** only. It cannot change
roles, limits, egress, or any floor — the [capability compiler](capability-compiler.md)
validates requests against policy and rejects over-reach.
