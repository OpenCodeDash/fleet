export class EgressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EgressError";
  }
}

/** What the provisioner needs from an egress admin; lets tests stub it without a host. */
export interface EgressAdmin {
  register(client: string, hosts: string[]): Promise<void>;
  unregister(client: string): Promise<void>;
}

export interface EgressRegistrarOptions {
  /** Base URL of the host-side egress admin API (e.g. `http://10.0.0.1:3129`). */
  adminUrl: string;
  fetchImpl?: typeof fetch;
}

/**
 * Client for the host-side egress admin API (docs/egress.md, ADR 0008). The orchestrator
 * registers a container's allowlist the moment it learns the container's address, and drops
 * it at teardown — so revoking a container revokes its network path.
 */
export class EgressRegistrar implements EgressAdmin {
  private readonly adminUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: EgressRegistrarOptions) {
    this.adminUrl = options.adminUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Register `client` (a container's veth address) with the hosts it may reach. */
  async register(client: string, hosts: string[]): Promise<void> {
    const response = await this.fetchImpl(`${this.adminUrl}/allowlist`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client, hosts }),
    });
    if (!response.ok) {
      throw new EgressError(
        `egress admin rejected allowlist for ${client} (${response.status})`,
      );
    }
  }

  /** Drop a container's allowlist. A missing entry is not an error. */
  async unregister(client: string): Promise<void> {
    const response = await this.fetchImpl(
      `${this.adminUrl}/allowlist/${encodeURIComponent(client)}`,
      { method: "DELETE" },
    );
    if (!response.ok && response.status !== 404) {
      throw new EgressError(
        `egress admin failed to drop allowlist for ${client} (${response.status})`,
      );
    }
  }
}
