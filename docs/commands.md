# Commands

Before reading further: this lists how to build/check/run this project.

Prereqs: Nix with flakes enabled.

| Action | Command |
| ------ | ------- |
| Dev shell | `nix develop` |
| Evaluate / verify flake | `nix flake check --no-build` |
| Show pinned inputs | `nix flake metadata` |

Not present yet (design phase): orchestrator build, test, and lint. Add a row here when
each lands — do not document commands that do not exist.
