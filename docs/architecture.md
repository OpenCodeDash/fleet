# Architecture

A control plane provisions one disposable NixOS `systemd-nspawn` container per task
attempt, each running a headless `opencode serve`, and drives it over the SDK. Durable
state lives outside containers, in git and the kanban board.

## Modules / boundaries

Paths marked **(TBD)** do not exist yet — this is design phase.

| Area | Where | Responsibility |
| ---- | ----- | -------------- |
| Orchestrator (control plane) | `./orchestrator/` (TBD) | Compile capabilities, provision containers, drive sessions, stream events, tear down |
| Container image (data plane) | `./image/` (TBD) | NixOS closure + `opencode`; boots `opencode serve` |
| Capability compiler | `./orchestrator/` (TBD) | `(task, role) -> { mcp, permission, creds }`, deterministic + hashable |

## Data flow

1. Orchestrator claims a task from the board.
2. Compiles the capability set → immutable `opencode.json` + scoped credentials.
3. Provisions an nspawn container (`.ephemeral = true`), config mounted read-only.
4. Drives `session.create` / `session.promptAsync`; consumes the `/event` SSE stream.
5. On verified handoff, tears the container down.

Surviving state = git branches + board + streamed events. Nothing else.

## Contracts

- **Capability compiler** — `(task, role) -> { mcp set, permission tree, credentials }`.
  Deterministic + hashable for audit. Uses `permission` (not the deprecated `tools` map),
  default-deny with wildcard allowlists; MCP tools are prefixed by server name
  (`"kanban_*"` gates a server's tools).
- **Event sink** — `.ephemeral` does not link the container journal to the host, so
  in-container logs vanish on teardown. The orchestrator MUST continuously stream `/event`
  + stderr to durable storage, or all forensics are lost.
- **Credential broker** — per-container, short-lived, least-privilege tokens minted at
  provision and revoked at destroy. No shared tokens across agents.

## Roles and handoff

Container == task attempt, so author and reviewer are always separate containers. The role
difference is enforced by the capability compiler, not by prompt text.

| Role | edit/commit | push `feat/*` | run tests | merge `main` | delete branch |
| ---- | ----------- | ------------- | --------- | ------------ | ------------- |
| author | yes | yes | yes | no | no |
| reviewer | no | no | yes | yes | yes |

Handoff: the author pushes the branch and records `head_sha`; the orchestrator **verifies
the remote ref exists** before accepting completion. The reviewer gets a fresh container
with a clean clone at `head_sha` (not the branch tip, which can move).

```
author → reviewer: { task_id, branch, head_sha, base_sha, pr_url?, acceptance_criteria, author_note }
reviewer → board:  { verdict: "approve" | "changes", note, pr_review_comments?, merge_sha? }
```

Reverse (`Changes Requested`): a new author container clones the branch at `head_sha`,
injects the reviewer's note, fixes, and pushes. Iterations are bounded; after N rounds
escalate to `Need Help`.

## Cautions (must not get wrong)

- Subagents: a restricted primary agent can spawn `general`, which has full tool access —
  gate `permission.task` or tool restrictions are cosmetic.
- `bash` collapses tool-level control — pair capability gating with default-deny egress.
- No `DELETE /mcp` — change capabilities by recreating the container, not patching it.
- The reviewer must diff test files against `base_sha` (never allow weakened tests) and
  confirm a clean tree after the test run.
