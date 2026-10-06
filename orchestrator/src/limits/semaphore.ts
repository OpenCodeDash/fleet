/** Counting semaphore with FIFO fairness. `acquire` resolves with a release function. */
export class Semaphore {
  readonly max: number;
  private available: number;
  private readonly queue: Array<() => void> = [];

  constructor(max: number) {
    if (max < 1) throw new Error("Semaphore: max must be >= 1");
    this.max = max;
    this.available = max;
  }

  tryAcquire(): boolean {
    if (this.available > 0) {
      this.available -= 1;
      return true;
    }
    return false;
  }

  acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      const grant = (): void => {
        resolve(() => this.release());
      };
      if (this.available > 0) {
        this.available -= 1;
        grant();
      } else {
        this.queue.push(grant);
      }
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next !== undefined) {
      next();
    } else {
      this.available += 1;
    }
  }

  get active(): number {
    return this.max - this.available;
  }

  get waiting(): number {
    return this.queue.length;
  }
}
