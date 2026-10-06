import type { ContainerSpec } from "./types.ts";

const CONFIG_MOUNTPOINT = "/etc/fleet/opencode";

/**
 * `systemd-nspawn` argv for one ephemeral agent container.
 *
 * `--ephemeral` gives the disposable rootfs (ADR 0001); the capability config is bound
 * read-only; `--network-zone=fleet` attaches the container to the `vz-fleet` nspawn zone,
 * whose bridge, DHCP and machine-name DNS are provided by nspawn on the host (so the
 * orchestrator reaches `opencode serve` at http://<machine>:4096). Egress is further
 * constrained by the proxy — docs/egress.md.
 */
export function buildNspawnArgs(spec: ContainerSpec): string[] {
  return [
    "--quiet",
    "--ephemeral",
    `--machine=${spec.name}`,
    `--directory=${spec.systemPath}`,
    `--bind-ro=${spec.configDir}:${CONFIG_MOUNTPOINT}`,
    "--network-zone=fleet",
    `${spec.systemPath}/init`,
  ];
}

/** Wrap the nspawn invocation in a transient systemd unit so `start` returns immediately. */
export function buildSystemdRunArgs(spec: ContainerSpec): string[] {
  return ["--collect", `--unit=fleet-${spec.name}`, "systemd-nspawn", ...buildNspawnArgs(spec)];
}
