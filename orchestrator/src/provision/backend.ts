import { renderContainerConfig } from "./render.ts";
import type { EgressAdmin } from "../egress/registrar.ts";
import type { TunnelFactory } from "../remote/tunnel.ts";
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

export interface ContainerBackendOptions {
  /**
   * Opens a host-side tunnel to the container. Required for an off-box orchestrator, which
   * cannot reach the container's host-private address directly.
   */
  tunnel?: TunnelFactory;
  /**
   * Nameservers to write into the container's /etc/resolv.conf. `nixos-container` copies the
   * host's resolv.conf (the host's resolved stub 127.0.0.53), which is unreachable from the
   * container; this overrides it so DNS works.
   */
  dns?: string[];
  /**
   * Registers each container's egress allowlist with the host proxy at provision and drops
   * it at teardown. Required for containers to reach anything (default-deny).
   */
  registrar?: EgressAdmin;
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
  private readonly tunnel: TunnelFactory | undefined;
  private readonly dns: string[];
  private readonly registrar: EgressAdmin | undefined;

  constructor(runner: CommandRunner, options: ContainerBackendOptions = {}) {
    this.runner = runner;
    this.tunnel = options.tunnel;
    this.dns = options.dns ?? [];
    this.registrar = options.registrar;
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

    try {
      if (this.dns.length > 0) {
        // Best-effort: give the container a reachable resolver.
        await this.runner.run(
          "nixos-container",
          ["run", spec.name, "--", "tee", "/etc/resolv.conf"],
          { input: `${this.dns.map((server) => `nameserver ${server}`).join("\n")}\n` },
        );
      }

      const ipResult = await this.runner.run("nixos-container", ["show-ip", spec.name]);
      const ip = ipResult.stdout.trim();
      if (ipResult.code !== 0 || ip.length === 0) {
        throw new ProvisionError(`container "${spec.name}" started but reported no IP`);
      }
      if (this.registrar !== undefined && spec.egress !== undefined) {
        // Register before returning: the allowlist must be in place before the agent runs.
        await this.registrar.register(ip, spec.egress.allowlist);
      }
      const handle: ContainerHandle = {
        name: spec.name,
        spec,
        address: `http://${ip}:${spec.port}`,
        client: ip,
      };
      if (this.tunnel === undefined) {
        return handle;
      }
      const tunnel = this.tunnel(ip, spec.port);
      return {
        ...handle,
        address: `http://127.0.0.1:${tunnel.localPort}`,
        close: () => tunnel.close(),
      };
    } catch (error) {
      // The container exists as soon as it is created, so never leave it behind if anything
      // after `start` fails (e.g. the egress admin is unreachable). Best-effort cleanup.
      await this.runner.run("nixos-container", ["terminate", spec.name]);
      await this.runner.run("nixos-container", ["destroy", spec.name]);
      throw error;
    }
  }

  async stop(handle: ContainerHandle): Promise<void> {
    handle.close?.();
    try {
      // Terminate is best-effort (the machine may already be gone); destroy removes the root.
      await this.runner.run("nixos-container", ["terminate", handle.name]);
      const destroy = await this.runner.run("nixos-container", ["destroy", handle.name]);
      if (destroy.code !== 0 && !/does not exist/i.test(destroy.stderr)) {
        throw new ProvisionError(
          `failed to destroy container "${handle.name}": ${destroy.stderr.trim() || destroy.stdout.trim()}`,
        );
      }
    } finally {
      // Drop the allowlist even if the container teardown failed: a stale grant is a live
      // network path. Best-effort — teardown must not fail because the proxy is already gone.
      if (
        this.registrar !== undefined &&
        handle.spec.egress !== undefined &&
        handle.client !== undefined
      ) {
        try {
          await this.registrar.unregister(handle.client);
        } catch {
          // ignore
        }
      }
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
