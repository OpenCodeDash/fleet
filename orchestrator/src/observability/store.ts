export interface StoredEvent {
  seq: number;
  timestamp: string;
  taskId: string;
  containerId: string;
  sessionId: string;
  role: string;
  capabilityHash: string;
  source: "sse" | "stderr" | "lifecycle" | "audit";
  type: string;
  data: unknown;
}

export interface EventStore {
  append(event: StoredEvent): Promise<void>;
  flush(): Promise<void>;
}

/** In-memory store; the real durable store lands with the control plane. */
export class MemoryEventStore implements EventStore {
  readonly events: StoredEvent[] = [];

  async append(event: StoredEvent): Promise<void> {
    this.events.push(event);
  }

  async flush(): Promise<void> {}
}
