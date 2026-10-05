# Architecture

## Control plane / data plane

The **orchestrator** is the control plane. It owns the capability catalog, credentials,
scheduling, and the source of truth for task state (the board). It never sends raw
commands to an agent.

A **container** is the data plane: one `systemd-nspawn` instance, one `opencode serve`,
disposable, with no durable state of its own.

The orchestrator makes exactly four moves:

1. **Compile** — render a task's capability set to an immutable `opencode.json` plus
   scoped credentials.
2. **Provision** — start an nspawn container (`.ephemeral = true`) with that config
   mounted read-only (or injected inline via `OPENCODE_CONFIG_CONTENT` /
   `OPENCODE_PERMISSION`).
3. **Drive** — over the SDK: `session.create`, `session.promptAsync`, then watch `/event`.
4. **Collect + destroy** — verify the handoff happened, then tear the container down.

## Lifecycle

```
claim → compile → provision → boot-serve → prompt → observe → complete → collect → destroy
```

State that survives teardown is exactly: git branches, the board, and whatever the
orchestrator streamed out. Nothing else.

## Contracts

### Capability compiler

```
(task, role) → { mcp set, permission tree, credentials }
```

- Deterministic and hashable, so `config-hash ↔ container-id ↔ task-id` is auditable.
- Uses `permission` (not the deprecated `tools` map), default-deny with wildcard
  allowlists. MCP tools are prefixed by server name, so `"kanban_*"` gates a server's
  tools.
- Server-level vs tool-level: omit a server from `mcp` to remove the process, credentials,
  and context cost entirely; register it but gate tools when only some tools should be
  reachable.

### Event sink

`containers.<name>.ephemeral` does **not** link the container journal to the host, so
in-container logs vanish on teardown. The orchestrator MUST continuously stream `/event`
SSE (and stderr) to durable storage, or all forensic data is lost. This is a hard
requirement, not a nicety.

### Credential broker

Per-container, short-lived, least-privilege tokens minted at provision, injected via
env/credential (systemd credentials or env), revoked at destroy. No shared kanban/GitHub
token across agents.

## Roles and handoff

Container == task attempt, so author and reviewer are always separate containers. The
role difference is enforced by the capability compiler, not by prompt text:

| | edit/commit | push `feat/*` | run tests | merge `main` | delete branch |
| --- | --- | --- | --- | --- | --- |
| author | yes | yes | yes | no | no |
| reviewer | no | no | yes | yes | yes |

Handoff (author → reviewer):

- author commits + pushes the branch, records `head_sha`, moves the task to `Code Review`
- orchestrator **verifies the remote ref exists** before accepting completion — completion
  is verifiable, not self-reported
- reviewer gets a fresh container and a fresh clone checked out at `head_sha` (not the
  branch tip, which can move)

Handoff payload:

```
{ task_id, branch, head_sha, base_sha, pr_url?, acceptance_criteria, author_note }
```

Reviewer returns:

```
{ verdict: "approve" | "changes", note, pr_review_comments?, merge_sha? }
```

`approve` → merge, delete branch, move to `Done`. `changes` → move to `Changes Requested`
with the note.

Reverse handoff (`Changes Requested`): a new author container clones the branch at
`head_sha`, injects the reviewer's note + PR comments, fixes, pushes, returns to
`Code Review`. Iterations are bounded; after N rounds escalate to `Need Help`.

## Footguns

- **Subagent escalation.** A restricted primary agent can spawn `general`, which has full
  tool access. Gate `permission.task` or tool restrictions are cosmetic.
- **`bash` collapses tool-level control.** Pair capability gating with default-deny egress.
- **No `DELETE /mcp`.** Change capabilities by recreating the container, not patching it.
- **Test integrity.** The reviewer must diff test files against `base_sha` (never allow
  weakened tests) and confirm a clean tree after the test run.
