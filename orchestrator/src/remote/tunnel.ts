import { spawn } from "node:child_process";

export interface TunnelHandle {
  localPort: number;
  close(): void;
}

export interface SshTunnelOptions {
  /** ssh binary (default `ssh`). */
  ssh?: string;
  /** ssh target, e.g. `root@agents.bigbox`. */
  target: string;
  extraArgs?: string[];
  /** First local port to try; incremented per tunnel. */
  firstLocalPort?: number;
}

export type TunnelFactory = (remoteHost: string, remotePort: number) => TunnelHandle;

/**
 * Opens `ssh -N -L` local port-forwards so an off-box orchestrator can reach a container's
 * host-private `10.233.x.x:<port>` at `127.0.0.1:<localPort>`. Co-located orchestrators
 * reach the container directly and need no tunnel. See ADR 0012 / docs/architecture.md.
 */
export function makeSshTunnelFactory(options: SshTunnelOptions): TunnelFactory {
  let next = options.firstLocalPort ?? 41_000;
  return (remoteHost, remotePort) => {
    const localPort = next;
    next += 1;
    const child = spawn(
      options.ssh ?? "ssh",
      [
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "BatchMode=yes",
        // Keep the connection alive across idle periods so NAT/firewalls don't drop the
        // forward while the container is thinking (a dropped tunnel surfaces as
        // "fetch failed" on the next request).
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=4",
        "-o",
        "TCPKeepAlive=yes",
        "-o",
        "ConnectTimeout=10",
        "-N",
        "-L",
        `127.0.0.1:${localPort}:${remoteHost}:${remotePort}`,
        options.target,
        ...(options.extraArgs ?? []),
      ],
      // ssh stderr goes to ours so tunnel failures are visible instead of silent.
      { stdio: ["ignore", "ignore", "inherit"] },
    );
    return { localPort, close: () => child.kill() };
  };
}
