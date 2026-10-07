# Setup — start to finish

Read when standing the fleet up for the first time. Each step is marked **runnable today**
or **pending** the remaining integration tasks (#114, #115, #117, #121).

## Prerequisites

- Nix with flakes enabled.
- A git remote the agents can clone and push to.
- A running backdash kanban server (the board).
- An API key for the LLM provider(s) the agents use.
- The MCP servers you intend to grant — at minimum the kanban MCP.

## 1. Get the code (runnable)

```sh
git clone <fleet-url> && cd fleet
nix develop   # provides node, git, opencode
```

## 2. Stand up the host (runnable)

The host does nothing but run disposable `systemd-nspawn` containers. Two ways to get one.

### Local VM (quickest)

```sh
nix run .#fleet-host-vm
```

### Real machine, from a NixOS live USB

1. Partition and format (example: UEFI, whole disk `/dev/nvme0n1` — check `lsblk` first):

   ```sh
   parted /dev/nvme0n1 -- mklabel gpt
   parted /dev/nvme0n1 -- mkpart ESP fat32 1MiB 512MiB
   parted /dev/nvme0n1 -- set 1 esp on
   parted /dev/nvme0n1 -- mkpart root ext4 512MiB 100%
   mkfs.fat -F32 /dev/nvme0n1p1
   mkfs.ext4 -L nixos /dev/nvme0n1p2
   mount /dev/nvme0n1p2 /mnt
   mkdir -p /mnt/boot && mount /dev/nvme0n1p1 /mnt/boot
   ```

2. Fetch the flake and capture this machine's hardware config:

   ```sh
   git clone https://github.com/OpenCodeDash/fleet /tmp/fleet
   nixos-generate-config --root /mnt
   cp /mnt/etc/nixos/hardware-configuration.nix /tmp/fleet/host/hardware-configuration.nix
   ```

   Replace the committed placeholder — it exists only so the flake evaluates in CI.

3. Install:

   ```sh
   nixos-install --flake /tmp/fleet#fleet-host
   ```

The host enables `nixos-container`, preloads the agent container system into the host store,
and enables OpenSSH for the off-box orchestrator. See
[`../host/fleet-host.nix`](../host/fleet-host.nix).

**Verify a container boots** (uses the same mechanism the provisioner does):
```sh
sudo nixos-container create smoke --flake /etc/nixos#fleet-agent
sudo nixos-container start smoke
machinectl list                    # expect "smoke"
sudo nixos-container show-ip smoke
sudo nixos-container terminate smoke
sudo nixos-container destroy smoke
```
(Names must be ≤ 11 characters.)

**BIOS instead of UEFI?** Edit `host/fleet-host.nix`: drop the two `boot.loader.systemd-boot`
lines and add `boot.loader.grub = { enable = true; devices = [ "/dev/nvme0n1" ]; };`.

## 3. Create the board (runnable)

Create a board (e.g. **Ephemeral Agent Fleet**) with these columns, left to right:

```
Todo → In Progress → Changes Requested → Code Review → Need Help → Done
```

`Todo`, `Changes Requested`, and `Code Review` are **queues** (claimable). The board is the
source of truth for work; the transition rules are in [`orchestrator.md`](orchestrator.md).

## 4. Provide credentials (runnable)

- Provider API key(s) via the environment (see [`../AGENTS.md`](../AGENTS.md)).
- A git token **per role scope** — never one shared token ([`credentials.md`](credentials.md)).
- Tokens for each granted MCP server.

Secrets are injected into the container at provision time and never enter the capability
hash or the event stream.

## 5. Configure the orchestrator (runnable to validate)

Start from the defaults and set what you must:

```yaml
# orchestrator.yaml
hosts:
  - name: agents.bigbox
    ssh: { host: 192.168.68.106, user: root }
    egress:
      adminUrl: http://192.168.68.106:3129   # host egress admin (registers allowlists)
      proxyUrl: http://10.233.0.1:3128       # container-reachable proxy (host gateway)
      base: [192.168.68.51]                  # orchestrator + model provider
limits:
  maxContainers: 10
```

The orchestrator registers each container's veth address + allowlist with `adminUrl` at
provision and drops it at teardown; the container's opencode and git route through `proxyUrl`.
Invalid or floor-violating values abort startup. Full list and precedence:
[`configuration.md`](configuration.md), [`egress.md`](egress.md).

## 6. Declare repo capabilities (runnable)

In each target repo add `.fleet/capabilities.json`:

```json
{ "grants": [{ "mcp": "kanban" }, { "mcp": "github", "tools": ["github_get_pr"] }] }
```

The compiler validates these against the catalog and fails closed on anything unknown:
[`capability-compiler.md`](capability-compiler.md).

## 7. Run the orchestrator (runnable)

The entrypoint and live adapters are wired. Point it at the board, the host, and the repos,
then run one attempt:

```sh
export FLEET_BOARD_URL=http://board.internal \
       FLEET_BOARD_ID=<board-id> \
       FLEET_SSH_HOST=agents.bigbox \
       FLEET_CATALOG=/etc/fleet/catalog.json \
       FLEET_REPO=https://github.com/you/app.git \
       FLEET_PROMPT='Fix issue #12: clone the repo, implement it, and push a branch'

export FLEET_MODEL_PROVIDER=anthropic FLEET_MODEL_ID=<model>
export FLEET_INJECT_ANTHROPIC_API_KEY=sk-...     # injected into the container

node orchestrator/src/main.ts run 84 author       # one attempt
```

`FLEET_REPO` is the remote the **container** clones and pushes, and the verifier checks it
directly with `git ls-remote` — no orchestrator-side clone needed. `FLEET_REPO_DIR` is only
required for the reviewer's ancestry check.

`run` performs a single attempt: compile → mint → provision a container → drive the agent →
verify the push against the remote → move the board task. It prints the outcome as JSON.

### Off-box orchestrator (Docker)

Run the orchestrator as a plain Node container (`node` + `git` + `openssh-client`); the
`nix develop` shell is only for development. Build/run with `orchestrator/Dockerfile` and
configure entirely via `FLEET_*` env. Off-box, the orchestrator reaches each container's
host-private `:4096` through an **SSH tunnel** to `FLEET_SSH_HOST` (no tunnel is used when
`FLEET_SSH_HOST` is unset and the orchestrator is co-located). Mount the fleet host's SSH key.
The container clones/pushes `FLEET_REPO` itself; the orchestrator needs no repo clone.

Container egress is wired (#133): the container's opencode/git use the host proxy, and the
orchestrator registers/drops each container's allowlist. The host has no NAT, so the proxy is
the only path off the container network.


## 8. Verify

Run one task end to end: create a `Todo` task and watch it move `In Progress` → `Code Review`
(author) → `Done` (reviewer). A working fleet satisfies: no container outlives its session;
every `Done` task had a verified push and an independent review; credentials are revoked at
teardown.

## Status

| Piece | State |
| ----- | ----- |
| Host (VM or machine) | implemented — `host/`, `nix run .#fleet-host-vm` |
| Container image | implemented — `image/` |
| Board client, capability compiler, credential broker, provisioner, egress proxy, event sink, control loop, scheduler, reconciler, agent configs, git verifier | implemented + unit-tested |
| Process entrypoint + live adapters | implemented — #114, #115, #117, #121, #133 |
