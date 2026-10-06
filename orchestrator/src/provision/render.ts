import { ProvisionError, type ContainerSpec } from "./types.ts";

const MAX_NAME_LENGTH = 11;
const SAFE_NAME = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;
const SAFE_PATH = /^[A-Za-z0-9._/-]+$/;

function nixString(value: string): string {
  // JSON string escaping is valid Nix string escaping for double-quoted strings.
  return JSON.stringify(value);
}

function nixPath(value: string): string {
  if (!value.startsWith("/") || !SAFE_PATH.test(value)) {
    throw new ProvisionError(`modulePath must be an absolute, simple path: "${value}"`);
  }
  return value;
}

/**
 * Render the per-container NixOS config `nixos-container create --config-file` consumes.
 * It imports the container module and bakes the task's capability config (and agent prompts)
 * into `/etc/fleet/opencode` via `environment.etc`, so nothing has to be bind-mounted.
 */
export function renderContainerConfig(spec: ContainerSpec): string {
  if (spec.name.length > MAX_NAME_LENGTH) {
    throw new ProvisionError(
      `container name "${spec.name}" exceeds ${MAX_NAME_LENGTH} chars (nixos-container limit)`,
    );
  }
  if (!SAFE_NAME.test(spec.name)) {
    throw new ProvisionError(`container name "${spec.name}" has invalid characters`);
  }
  const etc = spec.configFiles
    .map(
      (file) =>
        `    ${nixString(`fleet/opencode/${file.path}`)}.text = ${nixString(file.contents)};`,
    )
    .join("\n");
  return [
    "{ ... }:",
    "{",
    `  imports = [ ${nixPath(spec.modulePath)} ];`,
    "  environment.etc = {",
    etc,
    "  };",
    "}",
    "",
  ].join("\n");
}
