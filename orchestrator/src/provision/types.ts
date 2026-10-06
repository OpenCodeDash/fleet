export interface ContainerSpec {
  /** systemd-nspawn machine name; also the fleet container id. */
  name: string;
  /** Store path of the container system (`...-nixos-system-...`). */
  systemPath: string;
  /** Host directory mounted read-only at /etc/fleet/opencode inside the container. */
  configDir: string;
  /** Port the in-container `opencode serve` listens on. */
  port: number;
}

export interface ContainerHandle {
  name: string;
  spec: ContainerSpec;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs an external command; injected so lifecycle logic is testable without a host. */
export interface CommandRunner {
  run(command: string, args: string[]): Promise<CommandResult>;
}

export type FetchLike = typeof fetch;

export class ProvisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProvisionError";
  }
}
