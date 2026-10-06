import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConfigError, DEFAULTS, loadConfig } from "../src/config.ts";

const withProxy = (extra: Record<string, string> = {}) => ({
  FLEET_EGRESS_PROXY: "http://proxy.internal:3128",
  ...extra,
});

function writeConfig(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "fleet-cfg-"));
  const file = join(dir, "orchestrator.toml");
  writeFileSync(file, contents);
  return file;
}

test("loads built-in defaults when only the required proxy is set", () => {
  const config = loadConfig({ env: withProxy() });
  assert.equal(config.review.maxRounds, DEFAULTS.review.maxRounds);
  assert.equal(config.limits.maxContainers, DEFAULTS.limits.maxContainers);
  assert.equal(config.egress.mode, "deny");
  assert.equal(config.egress.proxy, "http://proxy.internal:3128");
});

test("file layer overrides defaults", () => {
  const filePath = writeConfig(`
[egress]
proxy = "http://file-proxy:3128"
[review]
maxRounds = 5
`);
  const config = loadConfig({ filePath, env: {} });
  assert.equal(config.review.maxRounds, 5);
});

test("precedence is defaults < file < env < cli", () => {
  const filePath = writeConfig(`
[egress]
proxy = "http://file-proxy:3128"
[review]
maxRounds = 5
`);
  const fromFile = loadConfig({ filePath, env: {} });
  assert.equal(fromFile.review.maxRounds, 5);

  const fromEnv = loadConfig({ filePath, env: withProxy({ FLEET_REVIEW_MAX_ROUNDS: "7" }) });
  assert.equal(fromEnv.review.maxRounds, 7);

  const fromCli = loadConfig({
    filePath,
    env: withProxy({ FLEET_REVIEW_MAX_ROUNDS: "7" }),
    cli: { review: { maxRounds: 9 } },
  });
  assert.equal(fromCli.review.maxRounds, 9);
});

test("env values are coerced to their schema type", () => {
  const config = loadConfig({
    env: withProxy({
      FLEET_LIMITS_MAX_CONTAINERS: "3",
      FLEET_CREDENTIALS_REVOKE_ON_DESTROY: "false",
      FLEET_EGRESS_ALLOW: "a.example, b.example",
    }),
  });
  assert.equal(config.limits.maxContainers, 3);
  assert.equal(config.credentials.revokeOnDestroy, false);
  assert.deepEqual(config.egress.allow, ["a.example", "b.example"]);
});

test("rejects a non-deny egress mode (security floor)", () => {
  assert.throws(
    () => loadConfig({ env: withProxy({ FLEET_EGRESS_MODE: "allow" }) }),
    (error: unknown) => error instanceof ConfigError && /floor/.test((error as Error).message),
  );
});

test("rejects an unknown FLEET_ environment variable", () => {
  assert.throws(
    () => loadConfig({ env: withProxy({ FLEET_NOT_A_SETTING: "1" }) }),
    (error: unknown) => error instanceof ConfigError && /unknown FLEET_/.test((error as Error).message),
  );
});

test("ignores unknown FLEET_ vars when strictEnv is false", () => {
  const config = loadConfig({
    env: withProxy({ FLEET_BOARD_URL: "http://x", FLEET_AGENT: "build" }),
    strictEnv: false,
  });
  assert.equal(config.egress.proxy, "http://proxy.internal:3128");
});

test("rejects an unknown key in the config file", () => {
  const filePath = writeConfig(`
[egress]
proxy = "http://file-proxy:3128"
[review]
mxaRounds = 5
`);
  assert.throws(
    () => loadConfig({ filePath, env: {} }),
    (error: unknown) => error instanceof ConfigError && /unknown setting/.test((error as Error).message),
  );
});

test("rejects a malformed duration", () => {
  assert.throws(
    () => loadConfig({ env: withProxy({ FLEET_RUN_IDLE_TIMEOUT: "10 minutes" }) }),
    (error: unknown) => error instanceof ConfigError && /duration/.test((error as Error).message),
  );
});

test("requires egress.proxy", () => {
  assert.throws(
    () => loadConfig({ env: {} }),
    (error: unknown) => error instanceof ConfigError && /required/.test((error as Error).message),
  );
});

test("rejects a non-integer numeric setting", () => {
  assert.throws(
    () => loadConfig({ env: withProxy({ FLEET_LIMITS_MAX_CONTAINERS: "many" }) }),
    (error: unknown) => error instanceof ConfigError && /number/.test((error as Error).message),
  );
});
