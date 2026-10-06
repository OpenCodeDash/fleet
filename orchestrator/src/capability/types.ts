export type Role = "author" | "reviewer";
export type Action = "allow" | "ask" | "deny";

/** opencode permission tree: tool-name pattern → action (or nested command map for bash). */
export type PermissionValue = Action | Record<string, Action>;
export type Permission = Record<string, PermissionValue>;

export interface Grant {
  /** Catalog key of the MCP server. */
  mcp: string;
  /** Explicit tool names or globs. Omitted → the catalog entry's default set. */
  tools?: string[];
}

export interface CapabilityRequest {
  taskId: string;
  repo: string;
  role: Role;
  grants?: Grant[];
}

export interface CredentialRequirement {
  provider: string;
  scopes: string[];
}

export interface McpCatalogEntry {
  type: "local" | "remote";
  /** Required for `type: "local"`. */
  command?: string[];
  /** Required for `type: "remote"`. */
  url?: string;
  environment?: Record<string, string>;
  /** Required. Tool names are `${toolPrefix}_*`; used to gate the server's tools. */
  toolPrefix: string;
  /** Known tool names; required to validate an explicit `grant.tools`. */
  tools?: string[];
  /** Tool names never allowed, even when the server is granted. */
  denyTools?: string[];
  credential?: CredentialRequirement;
  /** Egress hosts this server needs; feeds the network allowlist. */
  egress?: string[];
}

export interface Catalog {
  servers: Record<string, McpCatalogEntry>;
}

export interface AuditManifest {
  capabilityHash: string;
  taskId: string;
  repo: string;
  role: Role;
  policyVersion: string;
  servers: string[];
  grantPatterns: string[];
  denyPatterns: string[];
  credentialRefs: string[];
}

export interface CompiledCapabilities {
  capabilityHash: string;
  config: {
    mcp: Record<string, unknown>;
    permission: Permission;
    agent: Record<string, { description: string; mode: "primary"; permission: Permission }>;
  };
  credentials: CredentialRequirement[];
  egress: string[];
  /** True when bash is available — tool gating is then advisory, so egress must be enforced. */
  soft: boolean;
  audit: AuditManifest;
}

export class CapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapabilityError";
  }
}
