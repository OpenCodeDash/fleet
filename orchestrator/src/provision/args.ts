import type { ContainerSpec } from "./types.ts";

const CONFIG_MOUNTPOINT = "/etc/fleet/opencode";

/**
 * `systemd-nspawn` argv for one ephemeral agent container.
 *
 * `--ephemeral` gives the disposable rootfs (ADR 0001); the capability config is bound
 * read-only; `--network-veth` is the container's private link to the host (the orchestrator
 * reaches `opencode serve` over it; egress is further constrained by the proxy — docs/egress.md).
 */
export function buildNspawnArgs(spec: ContainerSpec): string[] {
  return [
    "--quiet",
    "--ephemeral",
    `--machine=${spec.name}`,
    `--directory=${spec.systemPath}`,
    `--bind-ro=${spec.configDir}:${CONFIG_MOUNTPOINT}`,
    "--network-veth",
    `${spec.systemPath}/init`,
  ];
}

/** Wrap the nspawn invocation in a transient systemd unit so `start` returns immediately. */
export function buildSystemdRunArgs(spec: ContainerSpec): string[] {
  return ["--collect", `--unit=fleet-${spec.name}`, "systemd-nspawn", ...buildNspawnArgs(spec)];
}
