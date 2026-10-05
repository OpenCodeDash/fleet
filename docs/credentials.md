# Credential broker

Read when working on how containers get secrets, token scopes, or revocation.

The [capability compiler](capability-compiler.md) declares **credential requirements** (no
secrets); the broker mints the actual tokens at provision and revokes them at destroy. See
[ADR 0007](adr/0007-per-container-scoped-tokens.md).

## Separation of concerns

- **Compiler** — pure; emits `{ provider, scopes, ttl }` requirements; never sees secrets.
- **Broker** — side-effecting; mints, injects, and revokes. Secrets live only in the broker
  and the container's env/credential — never in config, the capability hash, or events.

## Defaults

Overridable — see [configuration.md](configuration.md):

| Setting | Default |
| ------- | ------- |
| `credentials.ttl` | `1h` |
| `credentials.revokeOnDestroy` | `true` |

## Minting

- One token **per provider, per container** — never shared across agents.
- Scope is role-derived (see [role policies](capability-compiler.md#role-base-policies)):
  - author → push `feat/*`;
  - reviewer → push `main`, delete feature branches.
- Injection via systemd credential or env var; never written into `opencode.json`.
- MCP credentials are scoped per server; the broker mints only for granted servers.

## Revocation

- Revoke at `DESTROYING`, which is blocked until events are flushed (see
  [observability.md](observability.md)).
- TTL is a backstop: a token outlives its container by at most `ttl`.
- Crash-recovery orphan sweep revokes tokens for containers that no longer exist.

## Invariants

- No secret ever enters the capability config, its hash, or the event stream.
- A container never receives another container's token.
- A token's scope cannot exceed its role — an author can never obtain `main` push rights.
