# fleet

Ephemeral, per-task AI coding agents running in NixOS `systemd-nspawn` containers. One
container per task attempt runs a headless `opencode serve`; a control-plane orchestrator
compiles each task's capability set, provisions the container, drives the session, streams
events out, and tears it down.

Durable state lives only in the **git remote** and the **kanban board**.

**Agents: start at [`AGENTS.md`](AGENTS.md)** — it indexes the design docs.

## Docs

- [`AGENTS.md`](AGENTS.md) — agent entry point and index
- [`docs/architecture.md`](docs/architecture.md) — system structure, contracts, role handoff
- [`docs/adr/`](docs/adr/README.md) — design decisions (ADRs)
- [`docs/commands.md`](docs/commands.md) — dev shell / build / check

## Development

```sh
nix develop
```

Status: design phase — scaffold only.
