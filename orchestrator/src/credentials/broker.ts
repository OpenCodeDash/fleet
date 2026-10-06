import type { CredentialRequirement } from "../capability/types.ts";
import { parseDurationMs } from "../duration.ts";
import {
  BrokerError,
  type ContainerCredentials,
  type CredentialProvider,
  type MintedCredential,
} from "./types.ts";

export interface CredentialBrokerOptions {
  /** Registered providers, keyed by provider name. */
  providers: Record<string, CredentialProvider>;
  /** Token lifetime, e.g. `1h` (from config `credentials.ttl`). */
  ttl: string;
  /** Revoke tokens at destroy (default true). When false, the TTL is the only backstop. */
  revokeOnDestroy?: boolean;
  now?: () => Date;
}

/** Env var name a provider's token is injected as, e.g. `github` → `GITHUB_TOKEN`. */
export function credentialEnvName(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_TOKEN`;
}

function byProvider(a: CredentialRequirement, b: CredentialRequirement): number {
  return a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0;
}

/**
 * Mints short-lived, role-scoped, per-container credentials from the capability compiler's
 * requirements, and revokes them at destroy. Secrets never leave this module except via the
 * returned `env`. Spec: docs/credentials.md.
 */
export class CredentialBroker {
  private readonly providers: Record<string, CredentialProvider>;
  private readonly ttl: string;
  private readonly revokeOnDestroy: boolean;
  private readonly now: () => Date;
  private readonly issued = new Map<string, MintedCredential[]>();

  constructor(options: CredentialBrokerOptions) {
    this.providers = options.providers;
    this.ttl = options.ttl;
    this.revokeOnDestroy = options.revokeOnDestroy ?? true;
    this.now = options.now ?? (() => new Date());
  }

  async mint(
    containerId: string,
    requirements: CredentialRequirement[],
  ): Promise<ContainerCredentials> {
    if (this.issued.has(containerId)) {
      throw new BrokerError(`credentials already minted for container "${containerId}"`);
    }
    const expiresAt = new Date(this.now().getTime() + parseDurationMs(this.ttl)).toISOString();
    const minted: MintedCredential[] = [];
    try {
      for (const requirement of [...requirements].sort(byProvider)) {
        const provider = this.providers[requirement.provider];
        if (provider === undefined) {
          throw new BrokerError(
            `no credential provider registered for "${requirement.provider}" (fail closed)`,
          );
        }
        const result = await provider.mint({ scopes: requirement.scopes, ttl: this.ttl });
        minted.push({
          provider: requirement.provider,
          reference: result.reference,
          secret: result.secret,
          expiresAt,
        });
      }
    } catch (error) {
      // Never leak a partially-minted set.
      await this.revokeAll(minted);
      throw error;
    }

    this.issued.set(containerId, minted);
    const env: Record<string, string> = {};
    for (const credential of minted) {
      env[credentialEnvName(credential.provider)] = credential.secret;
    }
    return { containerId, credentials: minted, env };
  }

  async revoke(containerId: string): Promise<void> {
    const minted = this.issued.get(containerId);
    if (minted === undefined) return;
    this.issued.delete(containerId);
    if (this.revokeOnDestroy) await this.revokeAll(minted);
  }

  /** Container ids with outstanding credentials — used by the crash-recovery orphan sweep. */
  issuedContainers(): string[] {
    return [...this.issued.keys()];
  }

  private async revokeAll(minted: MintedCredential[]): Promise<void> {
    for (const credential of minted) {
      const provider = this.providers[credential.provider];
      if (provider === undefined) continue;
      try {
        await provider.revoke(credential.reference);
      } catch {
        // best-effort; the TTL is the backstop
      }
    }
  }
}
