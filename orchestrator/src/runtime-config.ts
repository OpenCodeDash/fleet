import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

export class RuntimeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeConfigError";
  }
}

export interface SshConfig {
  host: string;
  user?: string;
  key?: string;
}

export interface HostEgressConfig {
  /** Admin API the orchestrator calls to register/drop a container's allowlist. */
  adminUrl: string;
  /** Proxy URL the container's HTTP(S) clients use (host-reachable, e.g. `http://10.233.0.1:3128`). */
  proxyUrl: string;
  /** Static allowlist hosts: orchestrator, model provider, `egress.allow`. */
  base: string[];
  /** Hosts that bypass the proxy; defaults to localhost/127.0.0.1. */
  noProxy?: string[];
}

export interface HostConfig {
  name: string;
  /** Co-located host: run `nixos-container` locally (no SSH, no tunnel). */
  local?: boolean;
  /** Required unless `local` is true. */
  ssh?: SshConfig;
  maxContainers: number;
  egress?: HostEgressConfig;
}

export interface RepoConfig {
  url: string;
  dir: string;
}

export interface BoardConfig {
  url: string;
  id: string;
  token?: string;
  queues: { author: string[]; reviewer: string[] };
  /** Column a claimed author task moves to while an attempt runs (empty to leave in place). */
  inProgress: string;
  done: string;
  blocked: string[];
}

export interface RuntimeConfig {
  /** Boards the daemon works; each defines its own queues/columns. */
  boards: BoardConfig[];
  /** Path to the MCP capability catalog (see docs/capability-compiler.md). */
  catalog: string;
  hosts: HostConfig[];
  /** Repos keyed by board tag (`repo:<name>`), plus `default`. */
  repos: Record<string, RepoConfig>;
  container: { modulePath: string; dns: string[]; port: number };
  model: { provider: string; id: string };
  agents: { default: string };
  limits: { maxContainers: number; providerConcurrency: number; mcpConcurrency: number };
  review: { maxRounds: number };
  observability: { eventsPath: string; statusPort: number };
}

export interface LoadRuntimeConfigOptions {
  filePath: string;
  env?: Record<string, string | undefined>;
}

type Raw = Record<string, unknown>;

function isObject(value: unknown): value is Raw {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(path: string, message: string): never {
  throw new RuntimeConfigError(`${path}: ${message}`);
}

function section(raw: Raw, key: string): Raw {
  const value = raw[key];
  if (value === undefined) return {};
  if (!isObject(value)) fail(key, "expected a mapping");
  return value;
}

function requiredString(record: Raw, key: string, path: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) fail(`${path}.${key}`, "expected a non-empty string");
  return value;
}

function optionalString(record: Raw, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") fail(key, "expected a string");
  return value;
}

function integer(record: Raw, key: string, path: string, fallback: number, min = 1): number {
  const value = record[key];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
    fail(`${path}.${key}`, `expected an integer >= ${min}`);
  }
  return value;
}

function stringList(record: Raw, key: string, path: string, fallback: string[]): string[] {
  const value = record[key];
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    fail(`${path}.${key}`, "expected a list of strings");
  }
  return value as string[];
}

/** Replace `${env:NAME}` in every string value; fail if the variable is unset. */
function substituteEnv(value: unknown, env: Record<string, string | undefined>): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
      const resolved = env[name];
      if (resolved === undefined) {
        throw new RuntimeConfigError(`environment variable ${name} is not set`);
      }
      return resolved;
    });
  }
  if (Array.isArray(value)) return value.map((entry) => substituteEnv(entry, env));
  if (isObject(value)) {
    const out: Raw = {};
    for (const [key, entry] of Object.entries(value)) out[key] = substituteEnv(entry, env);
    return out;
  }
  return value;
}

function parseHosts(raw: Raw): HostConfig[] {
  const value = raw.hosts;
  if (value === undefined) fail("hosts", "at least one host is required");
  if (!Array.isArray(value) || value.length === 0) fail("hosts", "expected a non-empty list");
  return value.map((entry, index) => {
    if (!isObject(entry)) fail(`hosts[${index}]`, "expected a mapping");
    const path = `hosts[${index}]`;
    const host: HostConfig = {
      name: requiredString(entry, "name", path),
      maxContainers: integer(entry, "maxContainers", path, 10),
    };
    if (entry.local === true) {
      host.local = true;
    } else {
      const sshRaw = section(entry, "ssh");
      const ssh: SshConfig = { host: requiredString(sshRaw, "host", `${path}.ssh`) };
      const user = optionalString(sshRaw, "user");
      if (user !== undefined) ssh.user = user;
      const key = optionalString(sshRaw, "key");
      if (key !== undefined) ssh.key = key;
      host.ssh = ssh;
    }
    const egressRaw = entry.egress;
    if (egressRaw !== undefined) {
      if (!isObject(egressRaw)) fail(`${path}.egress`, "expected a mapping");
      const egressPath = `${path}.egress`;
      const noProxy = egressRaw.noProxy;
      host.egress = {
        adminUrl: requiredString(egressRaw, "adminUrl", egressPath),
        proxyUrl: requiredString(egressRaw, "proxyUrl", egressPath),
        base: stringList(egressRaw, "base", egressPath, []),
        ...(noProxy === undefined
          ? {}
          : { noProxy: stringList(egressRaw, "noProxy", egressPath, []) }),
      };
    }
    return host;
  });
}

function parseRepos(raw: Raw): Record<string, RepoConfig> {
  const value = raw.repos;
  if (!isObject(value) || Object.keys(value).length === 0) fail("repos", "at least one repo is required");
  const repos: Record<string, RepoConfig> = {};
  for (const [tag, entry] of Object.entries(value)) {
    if (!isObject(entry)) fail(`repos.${tag}`, "expected a mapping");
    repos[tag] = {
      url: requiredString(entry, "url", `repos.${tag}`),
      // Optional local clone dir; the verifier lazily clones under /var/lib/fleet/repos when absent.
      dir: optionalString(entry, "dir") ?? "",
    };
  }
  return repos;
}

function parseBoard(raw: Raw, path: string): BoardConfig {
  const queues = section(raw, "queues");
  const token = optionalString(raw, "token");
  return {
    url: requiredString(raw, "url", path),
    id: requiredString(raw, "id", path),
    ...(token === undefined ? {} : { token }),
    queues: {
      author: stringList(queues, "author", `${path}.queues`, ["Todo", "Changes Requested"]),
      reviewer: stringList(queues, "reviewer", `${path}.queues`, ["Code Review"]),
    },
    inProgress: optionalString(raw, "inProgress") ?? "In Progress",
    done: optionalString(raw, "done") ?? "Done",
    blocked: stringList(raw, "blocked", path, ["Need Help"]),
  };
}

/** `boards: [...]`, or a single `board: {...}` wrapped as a one-element list. */
function parseBoards(raw: Raw): BoardConfig[] {
  if (raw.boards !== undefined) {
    const value = raw.boards;
    if (!Array.isArray(value) || value.length === 0) fail("boards", "expected a non-empty list");
    return value.map((entry, index) => {
      if (!isObject(entry)) fail(`boards[${index}]`, "expected a mapping");
      return parseBoard(entry, `boards[${index}]`);
    });
  }
  if (raw.board !== undefined) {
    if (!isObject(raw.board)) fail("board", "expected a mapping");
    return [parseBoard(raw.board, "board")];
  }
  return fail("boards", "at least one board is required");
}

function validate(raw: Raw): RuntimeConfig {
  const container = section(raw, "container");
  const model = section(raw, "model");
  const agents = section(raw, "agents");
  const limits = section(raw, "limits");
  const review = section(raw, "review");
  const observability = section(raw, "observability");

  return {
    boards: parseBoards(raw),
    catalog: requiredString(raw, "catalog", "config"),
    hosts: parseHosts(raw),
    repos: parseRepos(raw),
    container: {
      modulePath: requiredString(container, "modulePath", "container"),
      dns: stringList(container, "dns", "container", ["1.1.1.1", "8.8.8.8"]),
      port: integer(container, "port", "container", 4096),
    },
    model: {
      provider: requiredString(model, "provider", "model"),
      id: requiredString(model, "id", "model"),
    },
    agents: { default: optionalString(agents, "default") ?? "build" },
    limits: {
      maxContainers: integer(limits, "maxContainers", "limits", 10),
      providerConcurrency: integer(limits, "providerConcurrency", "limits", 4),
      mcpConcurrency: integer(limits, "mcpConcurrency", "limits", 5),
    },
    review: { maxRounds: integer(review, "maxRounds", "review", 3) },
    observability: {
      eventsPath: optionalString(observability, "eventsPath") ?? "fleet-events.jsonl",
      statusPort: integer(observability, "statusPort", "observability", 4000),
    },
  };
}

/** Load and validate `orchestrator.yaml`, substituting `${env:NAME}` references. */
export function loadRuntimeConfig(options: LoadRuntimeConfigOptions): RuntimeConfig {
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(options.filePath, "utf8"));
  } catch (error) {
    throw new RuntimeConfigError(
      `failed to read ${options.filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isObject(parsed)) throw new RuntimeConfigError(`${options.filePath} must contain a mapping`);
  const substituted = substituteEnv(parsed, options.env ?? process.env);
  return validate(substituted as Raw);
}
