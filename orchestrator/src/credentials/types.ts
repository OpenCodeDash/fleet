export interface CredentialProvider {
  readonly name: string;
  /** Mint a token for the given scopes. Returns a secret and an opaque revoke reference. */
  mint(input: { scopes: string[]; ttl: string }): Promise<{ secret: string; reference: string }>;
  revoke(reference: string): Promise<void>;
}

export interface MintedCredential {
  provider: string;
  reference: string;
  secret: string;
  expiresAt: string;
}

export interface ContainerCredentials {
  containerId: string;
  credentials: MintedCredential[];
  /** Env vars to inject into the container (names from `credentialEnvName`). */
  env: Record<string, string>;
}

export class BrokerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrokerError";
  }
}
