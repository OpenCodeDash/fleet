import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { EventStore, StoredEvent } from "./store.ts";

/**
 * Durable JSONL event store: one event per line, appended synchronously so records survive
 * a crash. Good enough for a single control-plane process; swap for a database later.
 * See docs/observability.md.
 */
export class JsonlEventStore implements EventStore {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async append(event: StoredEvent): Promise<void> {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(event)}\n`);
  }

  async flush(): Promise<void> {
    // Writes are synchronous (appendFileSync), so there is nothing buffered to flush.
  }
}
