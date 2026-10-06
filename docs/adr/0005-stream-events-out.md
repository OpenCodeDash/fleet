# 0005. Stream events out continuously; never rely on the container journal

Status: accepted
Task: #89

## Context

Containers are destroyed at teardown (`nixos-container destroy`), so the rootfs is gone.
Even where the guest journal is linked to the host, it is unstructured, unredacted, and not
correlated to a task — auditing from it after the fact is impractical.

## Decision

The orchestrator **continuously streams** `/event` SSE (and container stderr) to durable
control-plane storage for the container's whole lifetime, and **blocks `DESTROYING` until
the stream is flushed**. Records are redacted on ingest and correlated by `taskId`,
`containerId`, `sessionId`, `role`, and `capabilityHash`.

## Consequences

- Forensics survive teardown; "what did this agent do" is answerable after the container is
  gone.
- Teardown depends on the sink — a sink outage stalls (or, sustained, fails) the task rather
  than silently dropping traces.
- `capabilityHash` joins the event stream to the capability audit manifest, so reachability
  and actions share one key.
- The orchestrator must redact secrets on ingest; the raw stream is never persisted as-is.

## Alternatives rejected

- **Rely on the container journal** — unstructured/unredacted and gone at destroy; not auditable.
- **Collect logs only at teardown** — a crash loses everything, which is exactly the case
  that matters most.
- **Persist the raw stream** — would store credential material.
