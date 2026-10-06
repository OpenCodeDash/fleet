import { readFileSync } from "node:fs";
import type { Config } from "./config.ts";
import { compile, type Catalog } from "./capability/index.ts";
import { CredentialBroker, envCredentialProviders } from "./credentials/index.ts";
import { BoardClient } from "./board/client.ts";
import { createBoardPort } from "./board/port.ts";
import { CommandGitVerifier } from "./git/index.ts";
import { NodeExecutor, SshCommandRunner, makeSshTunnelFactory } from "./remote/index.ts";
import { NixosContainerBackend } from "./provision/backend.ts";
import { ContainerProvisioner } from "./provision/provisioner.ts";
import type { CommandRunner } from "./provision/types.ts";
import { OpencodeAgentRunner } from "./agents/index.ts";
import { EventSink, JsonlEventStore } from "./observability/index.ts";
import { TaskLoop } from "./loop/loop.ts";
import type { AttemptOutcome, LoopDeps, TaskAttempt } from "./loop/types.ts";

export interface RuntimeOptions {
  config: Config;
  env: Record<string, string | undefined>;
  catalogPath: string;
  boardUrl: string;
  boardId: string;
  /** Bearer token for the board API when it is locked down. */
  boardToken?: string;
  sshHost?: string;
  sshUser?: string;
  /** Path to the SSH private key for the fleet host (else ssh uses its defaults). */
  sshKey?: string;
  /** Git remote URL agents clone/push and the verifier checks (e.g. the repo URL). */
  repo: string;
  /** Local clone; only needed for the reviewer's ancestry check. */
  repoDir?: string;
  modulePath: string;
  eventsPath: string;
  model?: { providerID: string; modelID: string };
  agent?: string;
  /** Extra env injected into every container (provider keys, git token, ...). */
  injectEnv?: Record<string, string>;
}

export interface Runtime {
  loop: TaskLoop;
  board: BoardClient;
  runAttempt(attempt: TaskAttempt): Promise<AttemptOutcome>;
}

function providerNames(catalog: Catalog): string[] {
  const names = new Set<string>();
  for (const entry of Object.values(catalog.servers)) {
    if (entry.credential !== undefined) names.add(entry.credential.provider);
  }
  return [...names].sort();
}

/** Wire the real adapters into a `TaskLoop` — the off-box orchestrator's composition root. */
export function createRuntime(options: RuntimeOptions): Runtime {
  const catalog = JSON.parse(readFileSync(options.catalogPath, "utf8")) as Catalog;
  const board = new BoardClient({
    url: options.boardUrl,
    ...(options.boardToken === undefined
      ? {}
      : { headers: { authorization: `Bearer ${options.boardToken}` } }),
  });
  const localExecutor = new NodeExecutor();
  // When no SSH host is configured the orchestrator runs commands locally (co-located with
  // the container host); otherwise it drives nixos-container over SSH, and reaches each
  // container's host-private port through an SSH tunnel.
  const remote = options.sshHost !== undefined && options.sshHost.length > 0;
  const sshHost = options.sshHost ?? "";
  const sshExtraArgs =
    options.sshKey === undefined ? [] : ["-i", options.sshKey, "-o", "IdentitiesOnly=yes"];
  const commandRunner: CommandRunner = remote
    ? new SshCommandRunner({
        host: sshHost,
        user: options.sshUser,
        extraArgs: sshExtraArgs,
        executor: localExecutor,
      })
    : localExecutor;
  const tunnel = remote
    ? makeSshTunnelFactory({
        target: options.sshUser === undefined ? sshHost : `${options.sshUser}@${sshHost}`,
        extraArgs: sshExtraArgs,
      })
    : undefined;
  const provisioner = new ContainerProvisioner(
    new NixosContainerBackend(commandRunner, tunnel === undefined ? {} : { tunnel }),
  );
  // Verification uses the remote URL directly (no clone needed for author handoffs).
  const git = new CommandGitVerifier({
    remote: options.repo,
    ...(options.repoDir === undefined ? {} : { repoDir: options.repoDir }),
    runner: localExecutor,
  });
  const agentRunner = new OpencodeAgentRunner({ model: options.model, agent: options.agent });
  const broker = new CredentialBroker({
    providers: envCredentialProviders(providerNames(catalog), options.env),
    ttl: options.config.credentials.ttl,
    revokeOnDestroy: options.config.credentials.revokeOnDestroy,
  });
  const inject = options.injectEnv ?? {};

  const deps: LoopDeps = {
    compile: (request) => compile(request, catalog),
    mintCredentials: async (containerId, requirements) => {
      const minted = await broker.mint(containerId, requirements);
      return { env: { ...minted.env, ...inject } };
    },
    revokeCredentials: (containerId) => broker.revoke(containerId),
    provision: (spec) => provisioner.provision(spec),
    destroy: (handle) => provisioner.destroy(handle),
    runAgent: (input) => agentRunner.run(input),
    git,
    board: createBoardPort(board, options.boardId),
    sinkFor: (correlation, secrets) =>
      new EventSink({ store: new JsonlEventStore(options.eventsPath), correlation, secrets }),
    modulePath: options.modulePath,
    port: 4096,
    verifyRetries: options.config.verify.retries,
  };

  const loop = new TaskLoop(deps);
  return { loop, board, runAttempt: (attempt) => loop.run(attempt) };
}

export function containerName(taskId: string): string {
  return `c${taskId.replace(/[^A-Za-z0-9]/g, "")}`.slice(0, 11);
}

function required(env: Record<string, string | undefined>, key: string): string {
  const value = env[key];
  if (value === undefined || value.length === 0) throw new Error(`${key} is required`);
  return value;
}

/** Parse the runtime composition from `FLEET_*` env vars. */
export function runtimeOptionsFromEnv(
  config: Config,
  env: Record<string, string | undefined>,
): RuntimeOptions {
  const injectEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("FLEET_INJECT_") && value !== undefined) {
      injectEnv[key.slice("FLEET_INJECT_".length)] = value;
    }
  }
  const provider = env.FLEET_MODEL_PROVIDER;
  const modelId = env.FLEET_MODEL_ID;
  return {
    config,
    env,
    catalogPath: required(env, "FLEET_CATALOG"),
    boardUrl: required(env, "FLEET_BOARD_URL"),
    boardId: required(env, "FLEET_BOARD_ID"),
    boardToken: env.FLEET_BOARD_TOKEN,
    sshHost: env.FLEET_SSH_HOST,
    sshUser: env.FLEET_SSH_USER,
    sshKey: env.FLEET_SSH_KEY,
    repo: required(env, "FLEET_REPO"),
    repoDir: env.FLEET_REPO_DIR,
    modulePath: env.FLEET_MODULE_PATH ?? "/etc/nixos/image/fleet-agent.nix",
    eventsPath: env.FLEET_EVENTS_PATH ?? "fleet-events.jsonl",
    model:
      provider !== undefined && modelId !== undefined
        ? { providerID: provider, modelID: modelId }
        : undefined,
    agent: env.FLEET_AGENT,
    injectEnv,
  };
}
