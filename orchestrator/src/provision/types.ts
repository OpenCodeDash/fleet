export interface ContainerConfigFile {
  /** Path relative to `/etc/fleet/opencode` inside the container. */
  path: string;
  contents: string;
}

export interface ContainerSpec {
  /** Container name; ≤ 11 chars (nixos-container / veth name limit). */
  name: string;
  /** Absolute path on the host of the NixOS module that defines the container. */
  modulePath: string;
  /** Files baked into `/etc/fleet/opencode/<path>` when the container is created. */
  configFiles: ContainerConfigFile[];
  /** Port the in-container `opencode serve` listens on. */
  port: number;
}

export interface ContainerHandle {
  name: string;
  spec: ContainerSpec;
  /** Base URL the orchestrator uses to reach this container's opencode server. */
  address: string;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs an external command; injected so lifecycle logic is testable without a host. */
export interface CommandRunner {
  run(command: string, args: string[], options?: { input?: string }): Promise<CommandResult>;
}

export type FetchLike = typeof fetch;

export class ProvisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProvisionError";
  }
}
