import { buildSystemdRunArgs } from "./args.ts";
import { ProvisionError, type CommandRunner, type ContainerHandle, type ContainerSpec } from "./types.ts";

export interface ContainerBackend {
  start(spec: ContainerSpec): Promise<ContainerHandle>;
  stop(handle: ContainerHandle): Promise<void>;
  /** Base URL the orchestrator uses to reach the container's opencode server. */
  address(handle: ContainerHandle): string;
}

/**
 * systemd-nspawn backend. Containers run as transient systemd units
 * (`systemd-run --unit=fleet-<name> systemd-nspawn ...`), so start is non-blocking; the
 * machine is reaped with `machinectl terminate`. Host networking/DNS for the veth is the
 * host's responsibility (see docs/architecture.md).
 */
export class NspawnBackend implements ContainerBackend {
  private readonly runner: CommandRunner;

  constructor(runner: CommandRunner) {
    this.runner = runner;
  }

  async start(spec: ContainerSpec): Promise<ContainerHandle> {
    const result = await this.runner.run("systemd-run", buildSystemdRunArgs(spec));
    if (result.code !== 0) {
      throw new ProvisionError(
        `failed to start container "${spec.name}": ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
    return { name: spec.name, spec };
  }

  async stop(handle: ContainerHandle): Promise<void> {
    const result = await this.runner.run("machinectl", ["terminate", handle.name]);
    // Terminating an already-gone machine is fine; anything else is a real failure.
    if (result.code !== 0 && !/not running|no such|no machine/i.test(result.stderr)) {
      throw new ProvisionError(
        `failed to stop container "${handle.name}": ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
  }

  address(handle: ContainerHandle): string {
    // systemd-nspawn with --network-veth makes the machine name resolvable on the host.
    return `http://${handle.name}:${handle.spec.port}`;
  }
}
