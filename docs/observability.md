# Observability / event sink

Read when working on streaming, logging, auditing, or anything that must survive container
teardown.

Containers are destroyed at teardown, so nothing in-container survives the task. Logs are
streamed out continuously and redacted rather than relied on afterwards. See
[ADR 0005](adr/0005-stream-events-out.md).

## What to capture

| Source | Data | Why |
| ------ | ---- | --- |
| `/event` SSE | bus events: session status, message parts, tool calls, permission requests | reconstruct what the agent did |
| container stderr | `opencode serve` logs | crashes, MCP startup failures |
| lifecycle | claim → provision → run → verify → destroy transitions | orchestration timeline |
| audit | `capabilityHash`, taskId, containerId, sessionId | answer "what could this container reach" |

## Correlation

Every record carries `taskId`, `containerId`, `sessionId`, `capabilityHash`, `role`, and a
timestamp. `capabilityHash` ties back to the [capability compiler](capability-compiler.md)
audit manifest.

## Sink contract

- The orchestrator subscribes to `/event` per container for the container's whole lifetime.
- Records are appended to durable control-plane storage **before** teardown; `DESTROYING`
  is blocked until the stream is flushed.
- Redact secrets on ingest: strip credential values, auth headers, tokens (mirror
  `opencode export --sanitize`).
- Backpressure: if the sink is unavailable, buffer to local disk and stall teardown; on
  sustained failure, fail the task rather than lose the trace.

## Retention and audit reconstruction

- Store the capability audit manifest keyed by `capabilityHash`, alongside the event stream.
- To answer "what did agent X do / what could it reach", join the event stream with the
  manifest for that taskId.

## Invariants

- Destroy never precedes a successful flush — otherwise forensics are lost.
- No secrets in stored records.
- Every record is correlated to a task and a capability hash.
