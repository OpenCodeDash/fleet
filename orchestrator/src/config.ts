import { readFileSync } from "node:fs";
import { parse as parseToml } from "smol-toml";

/** Thrown for any invalid or floor-violating configuration. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export type Duration = string;
const DURATION_RE = /^\d+(ms|s|m|h|d)$/;

export interface Config {
  credentials: { ttl: Duration; revokeOnDestroy: boolean };
  egress: { mode: "deny"; allow: string[]; proxy: string };
  review: { maxRounds: number };
  provision: { retries: number };
  verify: { retries: number };
  run: { idleTimeout: Duration };
  task: { budget: Duration };
  limits: {
    maxContainers: number;
    providerConcurrency: number;
    mcpConcurrency: number;
  };
  observability: { flushTimeout: Duration; retention: Duration };
}

/** Sane built-in defaults. See docs/configuration.md — keep these in sync. */
export const DEFAULTS: Config = {
  credentials: { ttl: "1h", revokeOnDestroy: true },
  egress: { mode: "deny", allow: [], proxy: "" },
  review: { maxRounds: 3 },
  provision: { retries: 2 },
  verify: { retries: 2 },
  run: { idleTimeout: "10m" },
  task: { budget: "60m" },
  limits: { maxContainers: 10, providerConcurrency: 4, mcpConcurrency: 5 },
  observability: { flushTimeout: "30s", retention: "30d" },
};

/** Environment variable → dotted config path. Unknown `FLEET_*` vars are rejected. */
const ENV_MAP: Record<string, string> = {
  FLEET_CREDENTIALS_TTL: "credentials.ttl",
  FLEET_CREDENTIALS_REVOKE_ON_DESTROY: "credentials.revokeOnDestroy",
  FLEET_EGRESS_MODE: "egress.mode",
  FLEET_EGRESS_ALLOW: "egress.allow",
  FLEET_EGRESS_PROXY: "egress.proxy",
  FLEET_REVIEW_MAX_ROUNDS: "review.maxRounds",
  FLEET_PROVISION_RETRIES: "provision.retries",
  FLEET_VERIFY_RETRIES: "verify.retries",
  FLEET_RUN_IDLE_TIMEOUT: "run.idleTimeout",
  FLEET_TASK_BUDGET: "task.budget",
  FLEET_LIMITS_MAX_CONTAINERS: "limits.maxContainers",
  FLEET_LIMITS_PROVIDER_CONCURRENCY: "limits.providerConcurrency",
  FLEET_LIMITS_MCP_CONCURRENCY: "limits.mcpConcurrency",
  FLEET_OBSERVABILITY_FLUSH_TIMEOUT: "observability.flushTimeout",
  FLEET_OBSERVABILITY_RETENTION: "observability.retention",
};

type Raw = Record<string, unknown>;

export interface LoadOptions {
  /** Path to `orchestrator.toml`. Omitted → file layer skipped. */
  filePath?: string;
  /** Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Typed overrides, e.g. from CLI flags. Highest precedence. */
  cli?: Raw;
}

/** Allowed keys per section. Each key's type is validated explicitly in `assertValid`. */
const SECTION_KEYS: Record<string, string[]> = {
  credentials: ["ttl", "revokeOnDestroy"],
  egress: ["mode", "allow", "proxy"],
  review: ["maxRounds"],
  provision: ["retries"],
  verify: ["retries"],
  run: ["idleTimeout"],
  task: ["budget"],
  limits: ["maxContainers", "providerConcurrency", "mcpConcurrency"],
  observability: ["flushTimeout", "retention"],
};

function isPlainObject(value: unknown): value is Raw {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge(target: Raw, source: Raw): Raw {
  for (const [key, value] of Object.entries(source)) {
    if (isPlainObject(value) && isPlainObject(target[key])) {
      deepMerge(target[key] as Raw, value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

function setPath(root: Raw, path: string, value: unknown): void {
  const keys = path.split(".");
  let cursor: Raw = root;
  for (let i = 0; i < keys.length - 1; i += 1) {
    const key = keys[i] as string;
    if (!isPlainObject(cursor[key])) cursor[key] = {};
    cursor = cursor[key] as Raw;
  }
  cursor[keys[keys.length - 1] as string] = value;
}

function coerceEnvValue(template: unknown, raw: string, path: string): unknown {
  if (typeof template === "number") {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      throw new ConfigError(`${path}: expected a number, got "${raw}"`);
    }
    return parsed;
  }
  if (typeof template === "boolean") {
    if (raw === "true") return true;
    if (raw === "false") return false;
    throw new ConfigError(`${path}: expected true or false, got "${raw}"`);
  }
  if (Array.isArray(template)) {
    return raw
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  return raw;
}

function templateFor(path: string): unknown {
  const parts = path.split(".");
  let cursor: unknown = DEFAULTS;
  for (const part of parts) {
    cursor = isPlainObject(cursor) ? cursor[part] : undefined;
  }
  return cursor;
}

function fail(path: string, message: string): never {
  throw new ConfigError(`${path}: ${message}`);
}

function assertSection(raw: Raw, key: string): Raw {
  const value = raw[key];
  if (!isPlainObject(value)) fail(key, "expected a table");
  return value;
}

function assertKeys(section: Raw, allowed: string[], path: string): void {
  for (const key of Object.keys(section)) {
    if (!allowed.includes(key)) fail(`${path}.${key}`.replace(/^\./, ""), "unknown setting");
  }
}

function assertString(value: unknown, path: string): string {
  if (typeof value !== "string") fail(path, "expected a string");
  return value;
}

function assertBool(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, "expected a boolean");
  return value;
}

function assertInteger(value: unknown, path: string, min: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    fail(path, "expected an integer");
  }
  if (value < min) fail(path, `must be >= ${min}`);
  return value;
}

function assertDuration(value: unknown, path: string): string {
  const text = assertString(value, path);
  if (!DURATION_RE.test(text)) {
    fail(path, `expected a duration like 30s, 10m, 1h, or 30d, got "${text}"`);
  }
  return text;
}

function assertStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    fail(path, "expected a list of strings");
  }
  return value as string[];
}

function assertValid(raw: Raw): Config {
  assertKeys(raw, Object.keys(SECTION_KEYS), "");

  const credentials = assertSection(raw, "credentials");
  assertKeys(credentials, SECTION_KEYS.credentials, "credentials");
  assertDuration(credentials.ttl, "credentials.ttl");
  assertBool(credentials.revokeOnDestroy, "credentials.revokeOnDestroy");

  const egress = assertSection(raw, "egress");
  assertKeys(egress, SECTION_KEYS.egress, "egress");
  const mode = assertString(egress.mode, "egress.mode");
  if (mode !== "deny") {
    fail(
      "egress.mode",
      `"${mode}" is not allowed — default-deny egress is a non-overridable floor`,
    );
  }
  assertStringArray(egress.allow, "egress.allow");
  const proxy = assertString(egress.proxy, "egress.proxy");
  if (proxy.length === 0) fail("egress.proxy", "is required");

  const review = assertSection(raw, "review");
  assertKeys(review, SECTION_KEYS.review, "review");
  assertInteger(review.maxRounds, "review.maxRounds", 1);

  const provision = assertSection(raw, "provision");
  assertKeys(provision, SECTION_KEYS.provision, "provision");
  assertInteger(provision.retries, "provision.retries", 0);

  const verify = assertSection(raw, "verify");
  assertKeys(verify, SECTION_KEYS.verify, "verify");
  assertInteger(verify.retries, "verify.retries", 0);

  const run = assertSection(raw, "run");
  assertKeys(run, SECTION_KEYS.run, "run");
  assertDuration(run.idleTimeout, "run.idleTimeout");

  const task = assertSection(raw, "task");
  assertKeys(task, SECTION_KEYS.task, "task");
  assertDuration(task.budget, "task.budget");

  const limits = assertSection(raw, "limits");
  assertKeys(limits, SECTION_KEYS.limits, "limits");
  assertInteger(limits.maxContainers, "limits.maxContainers", 1);
  assertInteger(limits.providerConcurrency, "limits.providerConcurrency", 1);
  assertInteger(limits.mcpConcurrency, "limits.mcpConcurrency", 1);

  const observability = assertSection(raw, "observability");
  assertKeys(observability, SECTION_KEYS.observability, "observability");
  assertDuration(observability.flushTimeout, "observability.flushTimeout");
  assertDuration(observability.retention, "observability.retention");

  return raw as unknown as Config;
}

/**
 * Load configuration from built-in defaults, then `orchestrator.toml`, then `FLEET_*`
 * environment variables, then typed CLI overrides. Validates the result and enforces the
 * non-overridable security floors. See docs/configuration.md.
 */
export function loadConfig(options: LoadOptions = {}): Config {
  const raw = structuredClone(DEFAULTS) as unknown as Raw;

  if (options.filePath !== undefined) {
    let parsed: unknown;
    try {
      parsed = parseToml(readFileSync(options.filePath, "utf8"));
    } catch (error) {
      throw new ConfigError(
        `failed to read config file "${options.filePath}": ${(error as Error).message}`,
      );
    }
    if (!isPlainObject(parsed)) {
      throw new ConfigError(`config file "${options.filePath}" must contain a table`);
    }
    deepMerge(raw, parsed);
  }

  const env = options.env ?? process.env;
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith("FLEET_") || value === undefined) continue;
    const path = ENV_MAP[name];
    if (path === undefined) fail(name, "unknown FLEET_ environment variable");
    setPath(raw, path, coerceEnvValue(templateFor(path), value, path));
  }

  if (options.cli !== undefined) deepMerge(raw, options.cli);

  return assertValid(raw);
}
