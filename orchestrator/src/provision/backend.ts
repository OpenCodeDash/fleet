import { renderContainerConfig } from "./render.ts";
import {
  ProvisionError,
  type CommandRunner,
  type ContainerHandle,
  type ContainerSpec,
} from "./types.ts";

export interface ContainerBackend {
  start(spec: ContainerSpec): Promise<ContainerHandle>;
  stop(handle: ContainerHandle): Promise<void>;
}

const CONFIG_DIR = "/run/fleet";

/**
 * systemd-nspawn backend built on NixOS's own `nixos-container`, which sets up a writable
 * root and bind-mounts `/nix/store` — the raw `--directory=<toplevel>` invocation does not
 * boot (read-only root, no `/usr`). Containers are imperative and disposable: created at
 * provision time and destroyed at teardown (see docs/architecture.md, ADR 0001).
 */
export class NixosContainerBackend implements ContainerBackend {
  private readonly runner: CommandRunner;

  constructor(runner: CommandRunner) {
    this.runner = runner;
  }

  async start(spec: ContainerSpec): Promise<ContainerHandle> {
    const configPath = `${CONFIG_DIR}/${spec.name}.nix`;
    const config = renderContainerConfig(spec);

    await this.requireOk("mkdir", ["-p", CONFIG_DIR], `prepare ${CONFIG_DIR}`);
    await this.requireOk("tee", [configPath], `write ${configPath}`, config);
    await this.requireOk(
      "nixos-container",
      ["create", spec.name, "--config-file", configPath],
      `create container "${spec.name}"`,
    );
    await this.requireOk(
      "nixos-container",
      ["start", spec.name],
      `start container "${spec.name}"`,
    );

    const ipResult = await this.runner.run("nixos-container", ["show-ip", spec.name]);
    const ip = ipResult.stdout.trim();
    if (ipResult.code !== 0 || ip.length === 0) {
      throw new ProvisionError(`container "${spec.name}" started but reported no IP`);
    }
    return { name: spec.name, spec, address: `http://${ip}:${spec.port}` };
  }

  async stop(handle: ContainerHandle): Promise<void> {
    // Terminate is best-effort (the machine may already be gone); destroy removes the root.
    await this.runner.run("nixos-container", ["terminate", handle.name]);
    const destroy = await this.runner.run("nixos-container", ["destroy", handle.name]);
    if (destroy.code !== 0 && !/does not exist/i.test(destroy.stderr)) {
      throw new ProvisionError(
        `failed to destroy container "${handle.name}": ${destroy.stderr.trim() || destroy.stdout.trim()}`,
      );
    }
  }

  private async requireOk(
    command: string,
    args: string[],
    what: string,
    input?: string,
  ): Promise<void> {
    const result = await this.runner.run(
      command,
      args,
      input === undefined ? undefined : { input },
    );
    if (result.code !== 0) {
      throw new ProvisionError(
        `failed to ${what}: ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
  }
}
