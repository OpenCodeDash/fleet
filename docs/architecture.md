# Architecture

A control plane provisions one disposable NixOS `systemd-nspawn` container per task
attempt, each running a headless `opencode serve`, and drives it over the SDK. Durable
state lives outside containers, in git and the kanban board.

## Modules / boundaries

Paths marked **(TBD)** do not exist yet.

| Area | Where | Responsibility |
| ---- | ----- | -------------- |
| Orchestrator (control plane) | `./orchestrator/` | Config loader, capability compiler, board client, credential broker, container provisioner implemented; control loop, event sink TBD |
| Container image (data plane) | `./image/` | NixOS container module + `nixosConfigurations.fleet-agent`; boots `opencode serve` |
| Capability compiler | `./orchestrator/src/capability/` | `(task, role) -> { mcp, permission, creds }`, deterministic + hashable |

## Data flow

1. Orchestrator claims a task from the board.
2. Compiles the capability set → immutable `opencode.json` + scoped credentials.
3. Provisions an nspawn container (`.ephemeral = true`), config mounted read-only.
4. Drives `session.create` / `session.promptAsync`; consumes the `/event` SSE stream.
5. On verified handoff, tears the container down.

Surviving state = git branches + board + streamed events. Nothing else.
Full control loop (states, transitions, completion, recovery): [`orchestrator.md`](orchestrator.md).

## Contracts

- **Capability compiler** — `(task, role) -> { mcp set, permission tree, credentials }`.
  Deterministic + hashable for audit. Uses `permission` (not the deprecated `tools` map),
  default-deny with wildcard allowlists; MCP tools are prefixed by server name
  (`"kanban_*"` gates a server's tools). Full spec: [`capability-compiler.md`](capability-compiler.md).
- **Event sink** — `.ephemeral` does not link the container journal to the host, so
  in-container logs vanish on teardown. The orchestrator MUST continuously stream `/event`
  + stderr to durable storage, or all forensics are lost. Full spec:
  [`observability.md`](observability.md).
- **Credential broker** — per-container, short-lived, least-privilege tokens minted at
  provision and revoked at destroy. No shared tokens across agents.

## Roles and handoff

Container == task attempt, so author and reviewer are always separate containers. Role
privileges are enforced by the capability compiler (permissions + credential scope), not by
prompt text. The full contract — role table, handoff payloads, review loop, and the
reviewer checklist — is in [`handoff.md`](handoff.md).

## Cautions (must not get wrong)

- Subagents: a restricted primary agent can spawn `general`, which has full tool access —
  gate `permission.task` or tool restrictions are cosmetic.
- `bash` collapses tool-level control — pair capability gating with default-deny egress.
- No `DELETE /mcp` — change capabilities by recreating the container, not patching it.
- The reviewer must diff test files against `base_sha` (never allow weakened tests) and
  confirm a clean tree after the test run.
