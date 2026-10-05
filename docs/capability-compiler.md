# Capability compiler

Read when working on how a task gets its tools/MCPs, or on the orchestrator's provision step.

Compiles a `(task, role)` request into an immutable opencode config plus credential
requirements, with a stable hash for audit. Pure and secret-free; a separate credential
broker mints the secrets later.

See [ADR 0002](adr/0002-capability-compiler.md) for why these properties were chosen.

## Interface

```ts
type Role = "author" | "reviewer"

type CapabilityRequest = {
  taskId: string
  repo: string          // selects the repo manifest
  role: Role
  grants?: Grant[]      // optional structured task-level additions
}

type Grant = {
  mcp: string           // catalog key
  tools?: string[]      // tool names/globs; omitted = catalog default set
}

type CompiledCapabilities = {
  capabilityHash: string                  // sha256 of canonical config + policyVersion
  config: OpenCodeConfigFragment          // { mcp, permission, agent }
  credentials: CredentialRequirement[]    // refs only, never secrets
  audit: AuditManifest
}

compile(req: CapabilityRequest, catalog: Catalog, policy: PolicyVersion): CompiledCapabilities
```

Contract: pure and total for well-formed inputs; throws `CapabilityError` (fail-closed)
otherwise. Same inputs → identical `capabilityHash`.

## Inputs and resolution order

1. **Repo manifest** — `.fleet/capabilities.json` in the target repo declares the project's
   default grants (checked in, reviewed like code).
2. **Task grants** — optional structured additions; free-text board text is never parsed.
3. **Role base policy** — author/reviewer defaults (see [roles table](architecture.md#roles-and-handoff)).
4. **Global hard denials** — applied last (last match wins); cannot be overridden.

Merged to a flat permission tree with `"*": "deny"` first, then allows, then hard denials.

## Output pieces

- `config.mcp` — only the selected servers, each `enabled: true`.
- `config.permission` — default-deny tree; wildcard patterns for MCP tools (`"kanban_*"`),
  bash command globs, and `task` gates.
- `config.agent` — one primary agent per role, with the role prompt + permission overrides.
- `credentials` — declarative requirements `{ provider, scopes, ttl }`, resolved by the broker.
- `audit` — `{ capabilityHash, taskId, role, policyVersion, mcp[], grantPatterns[],
  denyPatterns[], credentialRefs[] }`.

## Determinism

- Canonicalize before hashing: recursively sort object keys, sort arrays, drop volatile
  fields, fixed separators. Hash = SHA-256 over canonical JSON **plus `policyVersion`**.
- No secrets, timestamps, hostnames, or container ids enter the hashed input.
- The hash is the capability-set id recorded in the audit manifest and on the task.

## Invariants (security)

- Default-deny; nothing is reachable unless explicitly granted.
- **Fail closed** on any unknown MCP, unknown tool pattern, or catalog entry missing a tool
  prefix. Never silently drop a requested capability.
- Hard denials always win, including over grants: `task` (subagent escape),
  `external_directory`, and `webfetch`/`websearch` unless explicitly granted.
- `bash` is flagged: a set with unrestricted `bash` is marked `soft` (tool gating is
  advisory only, because bash reaches anything). The orchestrator MUST pair `soft` sets
  with network egress enforcement.
- The compiler never sees or emits secrets.

## Enforcement split: permissions vs credentials

Tool `permission` cannot express git-remote privilege, so role asymmetry is enforced in two
places:

- `permission` — whether the shell may run `git` at all.
- `credentials` — what the token allows (author: push `feat/*` only; reviewer: push `main`).

## Tradeoffs

- **Repo manifest vs per-task grants** — the manifest is DRY and reviewable but coarse;
  task grants add precision at the cost of a structured field. Chose manifest-first.
- **Pure compiler vs inline provisioning** — purity gives determinism and testability; costs
  an extra indirection (credential resolution happens later).
- **Fail-closed vs best-effort** — fail-closed blocks a task on config errors (surfaced as
  `Need Help`) but never under-grants silently.

## Failure modes

| Failure | Behaviour |
| ------- | --------- |
| Unknown MCP or tool pattern | `CapabilityError`; task → `Need Help` |
| Catalog entry lacks a tool prefix | refuse to gate it; `CapabilityError` |
| Grant conflicts with a hard denial | denial wins; recorded in audit |
| Missing / invalid repo manifest | refuse; `CapabilityError` |
| Credential mint failure (broker) | abort provision; requeue task |
| Non-canonical ordering | impossible — canonicalization step |

## Testing (when implemented)

- Determinism: identical inputs → identical `capabilityHash` (property test).
- Fail-closed: unknown MCP / pattern throws.
- Hard-deny precedence: a grant cannot re-enable a hard denial.
- Canonicalization: key/array order does not change the hash.
- Secret-free: hash is unchanged when broker environment changes.
