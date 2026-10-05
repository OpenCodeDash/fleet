# fleet

Ephemeral, per-task AI coding agents running in NixOS `systemd-nspawn` containers.

Each task attempt gets its own disposable container (`containers.<name>.ephemeral = true`)
running a headless `opencode serve`. A control-plane **orchestrator** compiles each task's
capability set (which MCP servers + tools), provisions the container, drives a single
opencode session over the SDK, streams events out, and destroys the container once the
handoff is verified.

Durable state lives entirely outside the container:

- **git remote** — branches/PRs are the artifacts
- **the kanban board** — task state and handoff notes

Author and reviewer run in different containers and are almost never alive at the same
time, so all communication goes through the board and the PR — never a live channel.

## Docs

- [`docs/architecture.md`](docs/architecture.md) — control plane / data plane, components, contracts
- [`docs/lifecycle.md`](docs/lifecycle.md) — container lifecycle decision

## Status

Design phase. Scaffold only; no implementation yet.

## Development

```sh
nix develop
```
