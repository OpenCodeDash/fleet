# Egress policy

Read when working on container networking or network isolation.

Tool-level permission gating is **not** a security boundary: a granted `bash` can reach any
host it can name. Egress is therefore default-deny and enforced at the network layer. See
[ADR 0008](adr/0008-egress-default-deny.md).

## Model

- Each container gets a private network namespace with **no default route**.
- All outbound HTTP(S) goes through a **proxy** that allows only an explicit host allowlist.
- DNS resolves only through the proxy (no direct resolver).

## Allowlist

Built only from:

1. the orchestrator endpoint (container ↔ control plane);
2. the endpoints of **granted** MCP servers (see [capability-compiler.md](capability-compiler.md));
3. `egress.allow` additions (default `[]`);
4. the LLM provider endpoint(s) required by the task's model.

Nothing else. A host is reachable only if it is on this list — never merely because a tool
could construct its URL.

## Config

Overridable — see [configuration.md](configuration.md):

| Key | Default | Meaning |
| --- | ------- | ------- |
| `egress.mode` | `deny` | `allow` is a floor violation and is rejected |
| `egress.allow` | `[]` | extra allowlist hosts |
| `egress.proxy` | required | enforcing HTTP(S) proxy |

## Enforcement

- nspawn network config: veth whose only gateway is the proxy.
- The proxy is the sole egress path and logs connections per container.
- A `soft` capability set (one that allows bash at all) MUST have egress enforced — this is
  the [capability-compiler](capability-compiler.md) invariant that makes tool gating
  meaningful.

## Invariants

- No container has direct internet egress.
- The allowlist derives from grants, so revoking a capability removes its network path.
- Egress denials are logged and correlated to the container/task.
