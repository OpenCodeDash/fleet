import type { CommandResult, CommandRunner } from "../provision/types.ts";
import type { Executor } from "./executor.ts";

export interface SshRunnerOptions {
  /** Host, or host from the SSH config (e.g. `agents.bigbox`). */
  host: string;
  /** Optional login user (e.g. `root`). */
  user?: string;
  /** ssh binary (default `ssh`). */
  ssh?: string;
  /** Extra ssh options, e.g. `["-o", "BatchMode=yes"]`. */
  extraArgs?: string[];
  executor: Executor;
}

/**
 * A `CommandRunner` that drives the container host over SSH — the off-box control plane's
 * path to `nixos-container` (create/start/terminate/destroy). Commands and args are passed
 * as separate argv entries and run through the remote login shell, so callers must pass
 * shell-safe values (container names and paths, which they do). See ADR 0012.
 */
export class SshCommandRunner implements CommandRunner {
  private readonly target: string;
  private readonly ssh: string;
  private readonly extraArgs: string[];
  private readonly executor: Executor;

  constructor(options: SshRunnerOptions) {
    this.target = options.user === undefined ? options.host : `${options.user}@${options.host}`;
    this.ssh = options.ssh ?? "ssh";
    this.extraArgs = options.extraArgs ?? [];
    this.executor = options.executor;
  }

  run(command: string, args: string[], options?: { input?: string }): Promise<CommandResult> {
    return this.executor.exec(this.ssh, [...this.extraArgs, this.target, command, ...args], options);
  }
}
