import { CapabilityError, type Grant } from "../capability/types.ts";

/** A target repository's capability manifest (`.fleet/capabilities.json`). */
export interface RepoManifest {
  grants: Grant[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse and validate a repo manifest; throws `CapabilityError` (fail closed) on any issue. */
export function parseRepoManifest(value: unknown): RepoManifest {
  if (!isPlainObject(value)) {
    throw new CapabilityError("repo manifest must be an object");
  }
  const grantsRaw = value.grants;
  if (grantsRaw === undefined) return { grants: [] };
  if (!Array.isArray(grantsRaw)) {
    throw new CapabilityError("repo manifest 'grants' must be an array");
  }
  const grants = grantsRaw.map((entry, index): Grant => {
    if (!isPlainObject(entry)) {
      throw new CapabilityError(`grant #${index} must be an object`);
    }
    const mcp = entry.mcp;
    if (typeof mcp !== "string" || mcp.length === 0) {
      throw new CapabilityError(`grant #${index} needs a non-empty 'mcp'`);
    }
    const tools = entry.tools;
    if (
      tools !== undefined &&
      (!Array.isArray(tools) || !tools.every((tool) => typeof tool === "string"))
    ) {
      throw new CapabilityError(`grant #${index} 'tools' must be a string array`);
    }
    return tools === undefined ? { mcp } : { mcp, tools: tools as string[] };
  });
  return { grants };
}
