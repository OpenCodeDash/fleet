import { Semaphore } from "./semaphore.ts";
import { TokenBucket } from "./token-bucket.ts";

export type Release = () => void;

export interface SchedulerOptions {
  maxContainers: number;
  providerConcurrency: number;
  mcpConcurrency: number;
  /** Optional per-provider rate limit (burst smoothing on top of concurrency). */
  providerRate?: { capacity: number; refillPerMs: number };
  pollIntervalMs?: number;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface AdmitInput {
  provider?: string;
  mcp?: string;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fleet-wide admission control. A task is admitted only when container, provider and MCP
 * slots are free; per-provider token buckets further smooth bursts. Limits are global, not
 * per container, so ten agents cannot each independently saturate a provider.
 * See docs/limiters.md and ADR 0011.
 */
export class Scheduler {
  private readonly containers: Semaphore;
  private readonly providerConcurrency: number;
  private readonly mcpConcurrency: number;
  private readonly providerGates = new Map<string, Semaphore>();
  private readonly mcpGates = new Map<string, Semaphore>();
  private readonly providerBuckets = new Map<string, TokenBucket>();
  private readonly providerRate: SchedulerOptions["providerRate"];
  private readonly pollIntervalMs: number;
  private readonly clock: (() => number) | undefined;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: SchedulerOptions) {
    this.containers = new Semaphore(options.maxContainers);
    this.providerConcurrency = options.providerConcurrency;
    this.mcpConcurrency = options.mcpConcurrency;
    this.providerRate = options.providerRate;
    this.pollIntervalMs = options.pollIntervalMs ?? 50;
    this.clock = options.clock;
    this.sleep = options.sleep ?? defaultSleep;
  }

  async admit(input: AdmitInput = {}): Promise<Release> {
    const releases: Release[] = [];
    try {
      releases.push(await this.containers.acquire());
      if (input.provider !== undefined) {
        releases.push(await this.gate(this.providerGates, input.provider, this.providerConcurrency).acquire());
      }
      if (input.mcp !== undefined) {
        releases.push(await this.gate(this.mcpGates, input.mcp, this.mcpConcurrency).acquire());
      }
      if (input.provider !== undefined && this.providerRate !== undefined) {
        await this.acquireToken(input.provider);
      }
    } catch (error) {
      for (const release of releases.reverse()) release();
      throw error;
    }
    return () => {
      for (const release of releases.reverse()) release();
    };
  }

  get activeContainers(): number {
    return this.containers.active;
  }

  private gate(map: Map<string, Semaphore>, name: string, max: number): Semaphore {
    let gate = map.get(name);
    if (gate === undefined) {
      gate = new Semaphore(max);
      map.set(name, gate);
    }
    return gate;
  }

  private async acquireToken(provider: string): Promise<void> {
    let bucket = this.providerBuckets.get(provider);
    if (bucket === undefined) {
      const options = this.providerRate as { capacity: number; refillPerMs: number };
      bucket = new TokenBucket(
        this.clock === undefined
          ? { capacity: options.capacity, refillPerMs: options.refillPerMs }
          : { capacity: options.capacity, refillPerMs: options.refillPerMs, now: this.clock },
      );
      this.providerBuckets.set(provider, bucket);
    }
    while (!bucket.tryAcquire()) {
      await this.sleep(this.pollIntervalMs);
    }
  }
}
