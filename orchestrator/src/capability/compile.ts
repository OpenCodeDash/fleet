import { canonicalJson, sha256Hex } from "./canonical.ts";
import { BOARD_READ_RULES, HARD_DENY_RULES, ROLE_POLICIES } from "./policy.ts";
import { promptReference } from "../agents/prompts.ts";
import {
  CapabilityError,
  type CapabilityRequest,
  type Catalog,
  type CompiledCapabilities,
  type CredentialRequirement,
  type Grant,
  type McpCatalogEntry,
  type Permission,
  type PermissionValue,
  type Role,
} from "./types.ts";

export const POLICY_VERSION = "1";

function isGlob(value: string): boolean {
  return value.includes("*") || value.includes("?");
}

interface ResolvedGrant {
  name: string;
  entry: McpCatalogEntry;
  allows: string[];
}

function resolveGrant(grant: Grant, catalog: Catalog): ResolvedGrant {
  const entry = catalog.servers[grant.mcp];
  if (entry === undefined) {
    throw new CapabilityError(`unknown MCP server "${grant.mcp}" (fail closed)`);
  }
  if (entry.toolPrefix.length === 0) {
    throw new CapabilityError(
      `catalog entry "${grant.mcp}" has no toolPrefix; cannot gate its tools (fail closed)`,
    );
  }

  if (grant.tools === undefined) {
    return { name: grant.mcp, entry, allows: [`${entry.toolPrefix}_*`] };
  }

  const deny = new Set(entry.denyTools ?? []);
  const allows: string[] = [];
  for (const tool of grant.tools) {
    if (isGlob(tool)) {
      allows.push(tool);
      continue;
    }
    if (entry.tools === undefined) {
      throw new CapabilityError(
        `catalog entry "${grant.mcp}" lists no tools; cannot validate explicit tool "${tool}" (fail closed)`,
      );
    }
    if (!entry.tools.includes(tool)) {
      throw new CapabilityError(
        `unknown tool "${tool}" for MCP server "${grant.mcp}" (fail closed)`,
      );
    }
    if (deny.has(tool)) {
      throw new CapabilityError(
        `tool "${tool}" for MCP server "${grant.mcp}" is denied and cannot be granted (fail closed)`,
      );
    }
    allows.push(tool);
  }
  return { name: grant.mcp, entry, allows };
}

function renderMcpEntry(name: string, entry: McpCatalogEntry): Record<string, unknown> {
  if (entry.type === "local" && (entry.command === undefined || entry.command.length === 0)) {
    throw new CapabilityError(`catalog entry "${name}" is local but has no command (fail closed)`);
  }
  if (entry.type === "remote" && (entry.url === undefined || entry.url.length === 0)) {
    throw new CapabilityError(`catalog entry "${name}" is remote but has no url (fail closed)`);
  }
  const rendered: Record<string, unknown> = { type: entry.type, enabled: true };
  if (entry.type === "local") rendered.command = entry.command;
  if (entry.type === "remote") rendered.url = entry.url;
  if (entry.environment !== undefined) rendered.environment = entry.environment;
  return rendered;
}

function buildPermission(role: Role, allows: string[], denies: string[]): Permission {
  const rules: Array<[string, PermissionValue]> = [["*", "deny"]];
  rules.push(...ROLE_POLICIES[role]);
  rules.push(...BOARD_READ_RULES);
  for (const pattern of allows) rules.push([pattern, "allow"]);
  for (const pattern of denies) rules.push([pattern, "deny"]);
  rules.push(...HARD_DENY_RULES);

  const permission: Permission = {};
  for (const [pattern, value] of rules) permission[pattern] = value;
  return permission;
}

export interface CompileOptions {
  policyVersion?: string;
}

/**
 * Compile a `(task, role)` request into an immutable opencode config plus credential
 * requirements and a stable audit hash. Pure and secret-free; throws `CapabilityError`
 * (fail closed) on any unknown MCP, tool pattern, or catalog gap.
 * Spec: docs/capability-compiler.md.
 */
export function compile(
  request: CapabilityRequest,
  catalog: Catalog,
  options: CompileOptions = {},
): CompiledCapabilities {
  const policyVersion = options.policyVersion ?? POLICY_VERSION;
  const resolved = (request.grants ?? []).map((grant) => resolveGrant(grant, catalog));
  resolved.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const mcp: Record<string, unknown> = {};
  const allows: string[] = [];
  const denies: string[] = [];
  const credentialScopes = new Map<string, Set<string>>();
  const egress = new Set<string>();

  for (const resolvedGrant of resolved) {
    const { name, entry } = resolvedGrant;
    if (mcp[name] !== undefined) {
      throw new CapabilityError(`duplicate grant for MCP server "${name}"`);
    }
    mcp[name] = renderMcpEntry(name, entry);
    allows.push(...resolvedGrant.allows);
    denies.push(...(entry.denyTools ?? []));
    if (entry.credential !== undefined) {
      const scopes = credentialScopes.get(entry.credential.provider) ?? new Set<string>();
      for (const scope of entry.credential.scopes) scopes.add(scope);
      credentialScopes.set(entry.credential.provider, scopes);
    }
    for (const host of entry.egress ?? []) egress.add(host);
  }

  const credentials: CredentialRequirement[] = [...credentialScopes.entries()]
    .map(([provider, scopes]) => ({ provider, scopes: [...scopes].sort() }))
    .sort((a, b) => (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0));

  const permission = buildPermission(request.role, allows, denies);
  const agent = {
    [request.role]: {
      description: `${request.role} agent`,
      mode: "primary" as const,
      prompt: promptReference(request.role),
      permission,
    },
  };
  const config = { mcp, permission, agent };

  // Conservative: any available bash makes tool gating advisory (auto-approve may be on),
  // so the set is "soft" and must be paired with enforced egress.
  const soft = permission.bash !== "deny";

  const egressList = [...egress].sort();
  const capabilityHash = sha256Hex(
    canonicalJson({ policyVersion, config, credentials, egress: egressList }),
  );

  const denyPatterns = [...new Set([...denies, ...HARD_DENY_RULES.map(([pattern]) => pattern)])].sort();

  return {
    capabilityHash,
    config,
    credentials,
    egress: egressList,
    soft,
    audit: {
      capabilityHash,
      taskId: request.taskId,
      repo: request.repo,
      role: request.role,
      policyVersion,
      servers: Object.keys(mcp).sort(),
      grantPatterns: [...new Set(allows)].sort(),
      denyPatterns,
      credentialRefs: credentials.map((entry) => entry.provider),
    },
  };
}
