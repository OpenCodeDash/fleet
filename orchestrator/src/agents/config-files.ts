import type { CompiledCapabilities, Role } from "../capability/types.ts";
import type { ContainerConfigFile } from "../provision/types.ts";
import { roleConfigFiles } from "./prompts.ts";

/**
 * The files baked into `/etc/fleet/opencode` for a task's container: the compiled opencode
 * config (mcp + permission + agent, including the role prompt reference) and the role prompt
 * files themselves. See docs/capability-compiler.md, docs/architecture.md.
 */
export function renderConfigFiles(
  compiled: CompiledCapabilities,
  role: Role,
): ContainerConfigFile[] {
  const opencode = {
    mcp: compiled.config.mcp,
    permission: compiled.config.permission,
    agent: compiled.config.agent,
  };
  return [
    { path: "opencode.json", contents: `${JSON.stringify(opencode, null, 2)}\n` },
    ...roleConfigFiles(role),
  ];
}
