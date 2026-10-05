# 0008. Egress is default-deny, enforced by a proxy allowlist

Status: accepted
Task: #91

## Context

Agents may be granted `bash`. `bash` can open sockets to any host, so tool-level permission
gating does not actually bound what a container can reach. Network egress must be the real
boundary.

## Decision

Containers have **no default route**. All outbound HTTP(S) goes through a proxy that permits
only an explicit allowlist derived from: the orchestrator, granted MCP endpoints, configured
extras, and the required LLM provider. DNS goes through the proxy. `egress.mode = allow` is a
non-overridable floor violation.

## Consequences

- A capability set that includes `bash` is only "safe" when egress is enforced; the two are
  coupled.
- Revoking a capability removes both its tools and its network path.
- The proxy becomes a single point to observe egress; per-container connection logs feed
  [observability](../observability.md).
- Tasks whose model provider is not allowlisted fail closed rather than reach out silently.

## Alternatives rejected

- **Tool-level gating only** — bypassable by `bash`; not a boundary.
- **Allow-all egress** — a compromised agent can exfiltrate or reach internal services.
- **DNS-only filtering** — trivially bypassed by connecting to a literal IP.
