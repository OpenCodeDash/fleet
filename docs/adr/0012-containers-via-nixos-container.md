# 0012. Containers are provisioned with `nixos-container`

Status: accepted
Task: #125

## Context

ADR 0001 chose one disposable container per task, originally via `systemd-nspawn` with the
declarative `containers.<name>.ephemeral = true`. It does not boot: `systemd-nspawn
--directory=<toplevel>` fails (`--ephemeral` cannot snapshot the read-only store, and a bare
closure has no `/usr`), and the store path cannot be the root. NixOS's supported path sets up
a writable root, bind-mounts `/nix/store`, and populates it — which is what `nixos-container`
encapsulates.

## Decision

Provision each task's container with the imperative `nixos-container` CLI:
`create <name> --config-file <generated>` → `start` → `show-ip`; teardown is `terminate` +
`destroy`. The per-task capability config and agent prompts are baked into
`/etc/fleet/opencode` via `environment.etc` in the generated config, so nothing is
bind-mounted and the container image stays fixed. Names are ≤ 11 chars (veth limit).

## Consequences

- Containers boot; the store path is never the root.
- Disposability comes from `destroy` at teardown, not the `.ephemeral` flag; nothing survives.
- `nixos-container` links the guest journal to the host for non-ephemeral containers, so
  [ADR 0005](0005-stream-events-out.md)'s "logs vanish" rationale weakens — but the event
  sink is still where records are live, redacted, and correlated (see `docs/observability.md`).
- Requires `nixos-container` on the host, driven over the SSH `CommandRunner` (#121).
- The container spec is `{ name, modulePath, configFiles, port }`; the address comes from
  `show-ip` (`http://<ip>:<port>`), so provisioning no longer assumes a fixed network zone.

## Alternatives rejected

- **Raw `systemd-nspawn --directory=<toplevel>`** — does not boot (confirmed on the host).
- **Declarative `containers.<name>.ephemeral`** — needs a host `nixos-rebuild` per container.
- **Reimplement the root + store-bind setup** — duplicates `nixos-container`.
