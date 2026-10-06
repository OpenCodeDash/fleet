export interface TokenBucketOptions {
  capacity: number;
  /** Tokens added per millisecond. */
  refillPerMs: number;
  now?: () => number;
}

/** Classic token bucket for smoothing bursts (per provider / per MCP endpoint). */
export class TokenBucket {
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly now: () => number;
  private tokens: number;
  private last: number;

  constructor(options: TokenBucketOptions) {
    if (options.capacity < 1) throw new Error("TokenBucket: capacity must be >= 1");
    this.capacity = options.capacity;
    this.refillPerMs = options.refillPerMs;
    this.now = options.now ?? (() => Date.now());
    this.tokens = options.capacity;
    this.last = this.now();
  }

  tryAcquire(cost = 1): boolean {
    this.refill();
    if (this.tokens >= cost) {
      this.tokens -= cost;
      return true;
    }
    return false;
  }

  get available(): number {
    this.refill();
    return this.tokens;
  }

  private refill(): void {
    const now = this.now();
    const elapsed = now - this.last;
    if (elapsed > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
      this.last = now;
    }
  }
}
