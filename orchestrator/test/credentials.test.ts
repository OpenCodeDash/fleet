import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BrokerError,
  CredentialBroker,
  credentialEnvName,
  type CredentialProvider,
} from "../src/credentials/index.ts";

function fakeProvider(
  name: string,
  impl: {
    mint?: CredentialProvider["mint"];
    revoke?: CredentialProvider["revoke"];
  } = {},
): {
  provider: CredentialProvider;
  minted: Array<{ scopes: string[]; ttl: string }>;
  revoked: string[];
} {
  const minted: Array<{ scopes: string[]; ttl: string }> = [];
  const revoked: string[] = [];
  let counter = 0;
  const provider: CredentialProvider = {
    name,
    mint:
      impl.mint ??
      (async (input) => {
        minted.push(input);
        counter += 1;
        return { secret: `${name}-secret-${counter}`, reference: `${name}-ref-${counter}` };
      }),
    revoke:
      impl.revoke ??
      (async (reference) => {
        revoked.push(reference);
      }),
  };
  return { provider, minted, revoked };
}

const fixedNow = (): Date => new Date("2026-01-01T00:00:00.000Z");

test("mints one token per requirement and injects env vars", async () => {
  const gh = fakeProvider("github");
  const kb = fakeProvider("kanban");
  const broker = new CredentialBroker({
    providers: { github: gh.provider, kanban: kb.provider },
    ttl: "1h",
    now: fixedNow,
  });
  const creds = await broker.mint("c1", [
    { provider: "kanban", scopes: ["boards:read"] },
    { provider: "github", scopes: ["repo:read"] },
  ]);
  assert.deepEqual(
    creds.credentials.map((credential) => credential.provider),
    ["github", "kanban"],
  );
  assert.equal(creds.env.GITHUB_TOKEN, "github-secret-1");
  assert.equal(creds.env.KANBAN_TOKEN, "kanban-secret-1");
  assert.equal(creds.credentials[0]?.expiresAt, "2026-01-01T01:00:00.000Z");
});

test("passes scopes and ttl through to the provider", async () => {
  const gh = fakeProvider("github");
  const broker = new CredentialBroker({ providers: { github: gh.provider }, ttl: "30m", now: fixedNow });
  await broker.mint("c1", [{ provider: "github", scopes: ["repo:read", "repo:write"] }]);
  assert.deepEqual(gh.minted, [{ scopes: ["repo:read", "repo:write"], ttl: "30m" }]);
});

test("fails closed on an unregistered provider and mints nothing", async () => {
  const gh = fakeProvider("github");
  const broker = new CredentialBroker({ providers: { github: gh.provider }, ttl: "1h", now: fixedNow });
  await assert.rejects(
    () => broker.mint("c1", [{ provider: "ghost", scopes: [] }]),
    (error: unknown) =>
      error instanceof BrokerError && /no credential provider/.test((error as Error).message),
  );
  assert.deepEqual(broker.issuedContainers(), []);
});

test("refuses to mint twice for the same container", async () => {
  const gh = fakeProvider("github");
  const broker = new CredentialBroker({ providers: { github: gh.provider }, ttl: "1h", now: fixedNow });
  await broker.mint("c1", [{ provider: "github", scopes: [] }]);
  await assert.rejects(
    () => broker.mint("c1", [{ provider: "github", scopes: [] }]),
    (error: unknown) =>
      error instanceof BrokerError && /already minted/.test((error as Error).message),
  );
});

test("revoke releases provider references and clears state (idempotent)", async () => {
  const gh = fakeProvider("github");
  const broker = new CredentialBroker({ providers: { github: gh.provider }, ttl: "1h", now: fixedNow });
  await broker.mint("c1", [{ provider: "github", scopes: [] }]);
  await broker.revoke("c1");
  assert.deepEqual(gh.revoked, ["github-ref-1"]);
  assert.deepEqual(broker.issuedContainers(), []);
  await broker.revoke("c1");
  assert.deepEqual(gh.revoked, ["github-ref-1"]);
});

test("revokeOnDestroy=false keeps provider references, relying on the TTL", async () => {
  const gh = fakeProvider("github");
  const broker = new CredentialBroker({
    providers: { github: gh.provider },
    ttl: "1h",
    revokeOnDestroy: false,
    now: fixedNow,
  });
  await broker.mint("c1", [{ provider: "github", scopes: [] }]);
  await broker.revoke("c1");
  assert.deepEqual(gh.revoked, []);
  assert.deepEqual(broker.issuedContainers(), []);
});

test("rolls back already-minted credentials when a later mint fails", async () => {
  const gh = fakeProvider("github");
  const boom = fakeProvider("zboom", {
    mint: async () => {
      throw new Error("mint failed");
    },
  });
  const broker = new CredentialBroker({
    providers: { github: gh.provider, zboom: boom.provider },
    ttl: "1h",
    now: fixedNow,
  });
  await assert.rejects(
    () => broker.mint("c1", [{ provider: "github", scopes: [] }, { provider: "zboom", scopes: [] }]),
    /mint failed/,
  );
  assert.deepEqual(gh.revoked, ["github-ref-1"]);
  assert.deepEqual(broker.issuedContainers(), []);
});

test("credentialEnvName sanitises provider names", () => {
  assert.equal(credentialEnvName("github"), "GITHUB_TOKEN");
  assert.equal(credentialEnvName("my-mcp"), "MY_MCP_TOKEN");
});
