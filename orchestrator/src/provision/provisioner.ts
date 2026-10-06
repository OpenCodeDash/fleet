import type { ContainerBackend } from "./backend.ts";
import {
  ProvisionError,
  type ContainerHandle,
  type ContainerSpec,
  type FetchLike,
} from "./types.ts";

export interface ProvisionerOptions {
  fetchImpl?: FetchLike;
  /** Total time to wait for `/global/health` before giving up. */
  readyTimeoutMs?: number;
  pollIntervalMs?: number;
  /** Injected for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Owns a container's runtime lifecycle: start it, wait until the opencode server answers,
 * and tear it down. The capability/credential work happens before this (compiler + broker)
 * and is baked into the container image by the backend. See docs/orchestrator.md.
 */
export class ContainerProvisioner {
  private readonly backend: ContainerBackend;
  private readonly fetchImpl: FetchLike;
  private readonly readyTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(backend: ContainerBackend, options: ProvisionerOptions = {}) {
    this.backend = backend;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.readyTimeoutMs = options.readyTimeoutMs ?? 30_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
    this.sleep = options.sleep ?? defaultSleep;
  }

  async provision(spec: ContainerSpec): Promise<ContainerHandle> {
    const handle = await this.backend.start(spec);
    await this.waitReady(handle);
    return handle;
  }

  async destroy(handle: ContainerHandle): Promise<void> {
    await this.backend.stop(handle);
  }

  private async waitReady(handle: ContainerHandle): Promise<void> {
    const attempts = Math.max(1, Math.ceil(this.readyTimeoutMs / this.pollIntervalMs));
    const url = `${handle.address}/global/health`;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (await this.isHealthy(url)) return;
      if (attempt < attempts - 1) await this.sleep(this.pollIntervalMs);
    }
    throw new ProvisionError(
      `container "${handle.name}" did not become ready within ${this.readyTimeoutMs}ms`,
    );
  }

  private async isHealthy(url: string): Promise<boolean> {
    try {
      const response = await this.fetchImpl(url);
      return response.ok;
    } catch {
      return false;
    }
  }
}
