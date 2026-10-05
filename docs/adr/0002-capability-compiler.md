# 0002. Capability compiler: pure, fail-closed, manifest-sourced

Status: accepted
Task: #85

## Context

Every container must be born with an exact tool/MCP surface. We need a reproducible way to
derive that surface from a task + role, auditable by hash, that cannot silently grant too
much or too little.

## Decision

The capability compiler is a **pure, secret-free function**
`(task, role) -> { config, credentials, hash }`:

- default-deny permission tree; **fail closed** on any unknown MCP, tool pattern, or
  catalog gap;
- grants come from a checked-in **repo manifest** (`.fleet/capabilities.json`) plus role
  policy — never from free-text task text;
- secrets are declared as **requirements** and minted later by a separate credential broker;
- role asymmetry is enforced in both `permission` and credential scope.

## Consequences

- `capabilityHash ↔ container ↔ task` is reproducible and auditable; re-rendering is
  byte-identical.
- Config errors block provisioning (surface as `Need Help`) instead of silently
  under-granting.
- Capability changes require a new container (no `DELETE /mcp`), consistent with
  [ADR 0001](0001-one-container-per-task.md).

## Alternatives rejected

- **Best-effort / partial grants** — silent under-granting is unauditable.
- **Task descriptions as the grant source** — free text, neither reviewable nor deterministic.
- **One component that also mints secrets** — breaks purity and hash stability.
