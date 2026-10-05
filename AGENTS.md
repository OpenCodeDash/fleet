# fleet — agent guide

Ephemeral per-task coding agents: one disposable NixOS `systemd-nspawn` container per task
attempt, each running a headless `opencode serve`. A control-plane **orchestrator** compiles
a capability set (MCP servers + tools), provisions the container, drives one opencode
session over the SDK, streams events out, and tears it down.

**The one thing not to get wrong:** containers are disposable and hold no durable state.
Durable state lives only in the **git remote** + the **kanban board**. Anything not pushed
or written down is lost at teardown.

| You are working on… | Read |
| ------------------- | ---- |
| System structure, control/data plane, contracts, role handoff | `./docs/architecture.md` |
| A task's tools / MCPs / permissions (capability set) | `./docs/capability-compiler.md` |
| Control-plane loop: claim → provision → drive → complete → destroy | `./docs/orchestrator.md` |
| Author↔reviewer handoff, review loop, branch/PR artifacts | `./docs/handoff.md` |
| Streaming / logging / audit that must survive teardown | `./docs/observability.md` |
| Recording or changing a design decision | `./docs/adr/README.md` |
| Dev shell / build / check / test | `./docs/commands.md` |

Always true:
- Container == `opencode serve` == opencode session; one per task attempt; ephemeral rootfs.
- Durable state = git remote + kanban board. Push early; teardown loses everything else.
- Capabilities are compiled at provision time and immutable inside the container.
- `./docs` is the design source of truth. Update a doc in the same change that changes the
  behavior it describes; if it is stale, fix or delete it. A stale doc is worse than none.

Status: design phase — scaffold only.
