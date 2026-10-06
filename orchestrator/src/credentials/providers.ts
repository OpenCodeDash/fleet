import { BrokerError } from "./types.ts";
import type { CredentialProvider } from "./types.ts";

export interface EnvCredentialProviderOptions {
  /** Provider name, e.g. `github` or `kanban`. */
  provider: string;
  /** Env var holding the token; defaults to `FLEET_<PROVIDER>_TOKEN`. */
  envVar?: string;
  /** Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

function defaultEnvVar(provider: string): string {
  return `FLEET_${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_TOKEN`;
}

/**
 * A credential provider backed by a static token in the environment. It does not mint
 * per-container tokens (that needs a provider API); `revoke` is a no-op because the token
 * is external. Enough to run the fleet end to end; swap for real issuance later. See
 * docs/credentials.md.
 */
export class EnvCredentialProvider implements CredentialProvider {
  readonly name: string;
  private readonly envVar: string;
  private readonly env: Record<string, string | undefined>;
  private counter = 0;

  constructor(options: EnvCredentialProviderOptions) {
    this.name = options.provider;
    this.envVar = options.envVar ?? defaultEnvVar(options.provider);
    this.env = options.env ?? process.env;
  }

  async mint(): Promise<{ secret: string; reference: string }> {
    const token = this.env[this.envVar];
    if (token === undefined || token.length === 0) {
      throw new BrokerError(`${this.envVar} is not set (credential provider "${this.name}")`);
    }
    this.counter += 1;
    return { secret: token, reference: `${this.name}-${this.counter}` };
  }

  async revoke(_reference: string): Promise<void> {
    // Static external token: nothing to revoke.
  }
}

/** Build an env-backed provider per name. */
export function envCredentialProviders(
  providers: string[],
  env: Record<string, string | undefined> = process.env,
): Record<string, CredentialProvider> {
  const result: Record<string, CredentialProvider> = {};
  for (const provider of providers) {
    result[provider] = new EnvCredentialProvider({ provider, env });
  }
  return result;
}
