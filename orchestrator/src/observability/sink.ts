import { redactSecrets } from "./redact.ts";
import { SseParser, type SseFrame } from "./sse.ts";
import type { EventStore, StoredEvent } from "./store.ts";

export interface Correlation {
  taskId: string;
  containerId: string;
  sessionId: string;
  role: string;
  capabilityHash: string;
}

export interface EventSinkOptions {
  store: EventStore;
  correlation: Correlation;
  /** Secret values to scrub from every record (e.g. minted tokens). */
  secrets?: string[];
  now?: () => Date;
}

export interface RecordInput {
  source: StoredEvent["source"];
  type: string;
  data?: unknown;
}

function parseData(data: string): unknown {
  if (data.length === 0) return null;
  try {
    return JSON.parse(data);
  } catch {
    return data;
  }
}

/**
 * Streams a container's `/event` SSE (and stderr/lifecycle/audit records) into durable
 * storage, redacted and correlated. Teardown must call `flush()` and only proceed if it
 * resolves — otherwise forensics are lost. See docs/observability.md and ADR 0005.
 */
export class EventSink {
  private readonly store: EventStore;
  private readonly correlation: Correlation;
  private readonly secrets: string[];
  private readonly now: () => Date;
  private readonly buffer: StoredEvent[] = [];
  private seq = 0;

  constructor(options: EventSinkOptions) {
    this.store = options.store;
    this.correlation = options.correlation;
    this.secrets = options.secrets ?? [];
    this.now = options.now ?? (() => new Date());
  }

  async record(input: RecordInput): Promise<void> {
    const event: StoredEvent = {
      seq: this.seq,
      timestamp: this.now().toISOString(),
      ...this.correlation,
      source: input.source,
      type: input.type,
      data: redactSecrets(input.data ?? null, this.secrets),
    };
    this.seq += 1;
    this.buffer.push(event);
    try {
      await this.drain();
    } catch {
      // stay buffered; a sustained failure surfaces from flush()
    }
  }

  /** Parse an SSE stream and record each frame. Returns the number of frames recorded. */
  async ingestSse(chunks: AsyncIterable<string | Uint8Array>): Promise<number> {
    const parser = new SseParser();
    const decoder = new TextDecoder();
    let count = 0;
    const handle = async (frames: SseFrame[]): Promise<void> => {
      for (const frame of frames) {
        await this.record({
          source: "sse",
          type: frame.event ?? "message",
          data: parseData(frame.data),
        });
        count += 1;
      }
    };
    for await (const chunk of chunks) {
      const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      await handle(parser.push(text));
    }
    await handle(parser.end());
    return count;
  }

  /** Drain the buffer and flush the store; throws if the store is still unavailable. */
  async flush(): Promise<void> {
    await this.drain();
    await this.store.flush();
  }

  bufferedCount(): number {
    return this.buffer.length;
  }

  private async drain(): Promise<void> {
    while (this.buffer.length > 0) {
      await this.store.append(this.buffer[0] as StoredEvent);
      this.buffer.shift();
    }
  }
}
