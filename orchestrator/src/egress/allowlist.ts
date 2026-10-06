/** Normalize a `host[:port]` to a lowercase hostname (ports are not part of the allowlist). */
export function normalizeHost(host: string): string {
  const withoutPort = host.includes(":") ? (host.split(":")[0] ?? host) : host;
  return withoutPort.toLowerCase();
}

/** Match a host against a pattern; `*` matches any run of characters (including dots). */
export function hostMatches(host: string, pattern: string): boolean {
  const target = normalizeHost(host);
  const normalized = pattern.toLowerCase();
  if (!normalized.includes("*")) return normalized === target;
  const escaped = normalized
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(target);
}

export function isAllowed(host: string, allowlist: string[]): boolean {
  return allowlist.some((pattern) => hostMatches(host, pattern));
}

export interface AllowlistParts {
  /** Orchestrator control-plane endpoint. */
  orchestrator?: string;
  /** Egress hosts of the granted MCP servers (from the capability compiler). */
  mcpEgress?: string[];
  /** `egress.allow` config additions. */
  extra?: string[];
  /** LLM provider endpoint(s) for the task's model. */
  provider?: string[];
}

/** Union, deduplicated and sorted, of every source that may be reached. */
export function buildAllowlist(parts: AllowlistParts): string[] {
  const all = [
    parts.orchestrator,
    ...(parts.mcpEgress ?? []),
    ...(parts.extra ?? []),
    ...(parts.provider ?? []),
  ].filter((host): host is string => host !== undefined && host.length > 0);
  return [...new Set(all.map((host) => host.toLowerCase()))].sort();
}
