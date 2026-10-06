# Commands

Prereqs: Nix with flakes enabled. Enter the dev shell first: `nix develop` (provides node 24,
git, opencode).

## Repo (flake)

| Action | Command |
| ------ | ------- |
| Dev shell | `nix develop` |
| Evaluate / verify flake | `nix flake check --no-build` |
| Build the agent container system | `nix build .#nixosConfigurations.fleet-agent.config.system.build.toplevel` |
| Run the dedicated host VM | `nix run .#fleet-host-vm` |
| Show pinned inputs | `nix flake metadata` |

## Orchestrator (`orchestrator/`)

Node/TS ESM. Dependencies are pinned in `package-lock.json`; install once with `npm ci`.
Tests run on Node's built-in test runner against `.ts` via native type stripping.

| Action | Command | Where |
| ------ | ------- | ----- |
| Install deps | `npm ci` | `orchestrator/` |
| Typecheck | `npm run typecheck` | `orchestrator/` |
| Lint | `npm run lint` | `orchestrator/` |
| Test | `npm test` | `orchestrator/` |
