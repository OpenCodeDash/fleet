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

- The container gets `HTTP_PROXY`/`HTTPS_PROXY` (and the lowercase forms) plus
  `NO_PROXY=localhost,127.0.0.1` in an `egress.env` `EnvironmentFile`. opencode
  ([network docs](https://opencode.ai/docs/network/)) and git both honour these, so provider,
  git and MCP traffic leaves via the proxy.
- The host does **not** NAT the container network, so the proxy is the only path off it.
  The host firewall accepts only the proxy port (`3128`) from the container subnet.
- At provision the orchestrator registers the container's veth address with its allowlist on
  the host's egress admin (`POST /allowlist`); at teardown it drops it
  (`DELETE /allowlist/<client>`). The proxy is therefore the sole egress path and logs
  connections per container.
- A `soft` capability set (one that allows bash at all) MUST have egress enforced — this is
  the [capability-compiler](capability-compiler.md) invariant that makes tool gating
  meaningful.

No nftables destination allowlist is needed: opencode's own HTTP client honours the proxy env
vars, so LLM traffic is proxied like everything else.

## Invariants

- No container has direct internet egress.
- The allowlist derives from grants, so revoking a capability removes its network path.
- Egress denials are logged and correlated to the container/task.
