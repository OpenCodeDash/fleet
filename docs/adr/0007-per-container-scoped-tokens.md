# 0007. Per-container, short-lived, scoped tokens; broker separated from compiler

Status: accepted
Task: #90

## Context

Ten concurrent agents need git and MCP credentials. A shared long-lived token would allow
lateral movement between containers and would make the capability hash depend on secrets.

## Decision

The broker mints a **per-provider, per-container token** with a role-derived scope and a
short TTL (`1h` default), injected via systemd credential / env, and revoked at destroy
(after the event flush). The capability compiler stays **pure and secret-free** — it emits
requirements only.

## Consequences

- Blast radius of a leaked token is one container and at most `ttl`.
- Author tokens can never push `main`; reviewer tokens are the only ones with merge rights
  (reinforces [ADR 0006](0006-role-privileges-are-data.md)).
- The capability hash is stable across environments (no secrets in the hashed input).
- Revocation depends on teardown completing, so it inherits the "flush before destroy"
  ordering from [ADR 0005](0005-stream-events-out.md).

## Alternatives rejected

- **One shared token** — no isolation; a single leak compromises every agent.
- **Long-lived tokens** — TTL backstop lost; revocation gaps become permanent.
- **Secrets inside `opencode.json`** — breaks hash stability and leaks into config/events.
