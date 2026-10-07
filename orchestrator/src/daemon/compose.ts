import { readFileSync } from "node:fs";
import { compile, type Catalog } from "../capability/index.ts";
import type { Role } from "../capability/types.ts";
import { CredentialBroker, envCredentialProviders } from "../credentials/index.ts";
import { BoardClient } from "../board/client.ts";
import { createBoardPort } from "../board/port.ts";
import { findTask } from "../board/client.ts";
import type { Task } from "../board/types.ts";
import { CommandGitVerifier } from "../git/index.ts";
import { Scheduler } from "../limits/index.ts";
import { TaskLoop } from "../loop/index.ts";
import type { AttemptOutcome, LoopDeps, TaskAttempt } from "../loop/types.ts";
import { OpencodeAgentRunner } from "../agents/index.ts";
import { EventSink, JsonlEventStore } from "../observability/index.ts";
import { NodeExecutor, SshCommandRunner, makeSshTunnelFactory } from "../remote/index.ts";
import { NixosContainerBackend } from "../provision/backend.ts";
import { ContainerProvisioner } from "../provision/provisioner.ts";
import type { HostConfig, RepoConfig, RuntimeConfig } from "../runtime-config.ts";
import { FleetDaemon } from "./daemon.ts";
import { SqliteStateStore } from "./state.ts";
import type { Candidate, DaemonDeps } from "./types.ts";

export interface DaemonHandle {
  daemon: FleetDaemon;
  state: SqliteStateStore;
  /** Run a single attempt for a task id (the `once` debug command). */
  runOnce(taskId: number, role: Role): Promise<void>;
  close(): void;
}

/** The repo a task targets: a `repo:<name>` tag, else the default. */
export function repoForTask(task: Task, config: RuntimeConfig): RepoConfig {
  for (const tag of task.tags) {
    if (tag.name.startsWith("repo:")) {
      const repo = config.repos[tag.name.slice("repo:".length)];
      if (repo !== undefined) return repo;
    }
  }
  const fallback = config.repos.default ?? Object.values(config.repos)[0];
  if (fallback === undefined) throw new Error("no repo configured");
  return fallback;
}

/** Deterministic branch per task so the reviewer knows what to check out. */
export function branchForTask(task: Task): string {
  return `feat/task-${task.id}`;
}

export function promptForTask(task: Task, role: Role): string {
  const spec = task.description ? `${task.name}\n\n${task.description}` : task.name;
  const branch = branchForTask(task);
  return role === "author"
    ? `Task: ${spec}\n\nClone the repository, create the branch ${branch}, do the work, commit, and push ${branch} to origin.`
    : `Task: ${spec}\n\nReview the change on branch ${branch}: clone the repository, check out ${branch}, verify it satisfies the task, and run any tests. If it passes, merge ${branch} into main, push main, and delete the remote branch ${branch}.`;
}

function providerNames(catalog: Catalog): string[] {
  const names = new Set<string>();
  for (const entry of Object.values(catalog.servers)) {
    if (entry.credential !== undefined) names.add(entry.credential.provider);
  }
  return [...names].sort();
}

function injectEnvFromEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("FLEET_INJECT_") && value !== undefined) {
      out[key.slice("FLEET_INJECT_".length)] = value;
    }
  }
  return out;
}

function containerName(taskId: number, role: Role): string {
  return `c${taskId}${role === "reviewer" ? "r" : "a"}`.slice(0, 11);
}

/** Build the daemon and its collaborators from `RuntimeConfig`. */
export function createDaemon(
  config: RuntimeConfig,
  env: Record<string, string | undefined>,
  log: (message: string) => void = (message) => process.stdout.write(`[daemon] ${message}\n`),
): DaemonHandle {
  const catalog = JSON.parse(readFileSync(config.catalog, "utf8")) as Catalog;
  const board = new BoardClient({
    url: config.board.url,
    ...(config.board.token === undefined
      ? {}
      : { headers: { authorization: `Bearer ${config.board.token}` } }),
  });
  const boardPort = createBoardPort(board, config.board.id);
  const state = new SqliteStateStore(env.FLEET_STATE_PATH ?? "fleet-state.sqlite");
  const scheduler = new Scheduler({
    maxContainers: config.limits.maxContainers,
    providerConcurrency: config.limits.providerConcurrency,
    mcpConcurrency: config.limits.mcpConcurrency,
  });
  const broker = new CredentialBroker({
    providers: envCredentialProviders(providerNames(catalog), env),
    ttl: "1h",
  });
  const agentRunner = new OpencodeAgentRunner({
    model: { providerID: config.model.provider, modelID: config.model.id },
    agent: config.agents.default,
    autoApprove: true,
    log,
  });
  const inject = injectEnvFromEnv(env);

  const provisioners = new Map<string, ContainerProvisioner>();
  for (const host of config.hosts) {
    const local = new NodeExecutor();
    const sshExtra = host.ssh.key === undefined ? [] : ["-i", host.ssh.key, "-o", "IdentitiesOnly=yes"];
    const runner = new SshCommandRunner({
      host: host.ssh.host,
      user: host.ssh.user,
      extraArgs: sshExtra,
      executor: local,
    });
    const tunnel = makeSshTunnelFactory({
      target: host.ssh.user === undefined ? host.ssh.host : `${host.ssh.user}@${host.ssh.host}`,
      extraArgs: sshExtra,
    });
    provisioners.set(
      host.name,
      new ContainerProvisioner(
        new NixosContainerBackend(runner, { tunnel, dns: config.container.dns }),
      ),
    );
  }

  const runAttempt = async (candidate: Candidate, host: HostConfig): Promise<AttemptOutcome> => {
    const provisioner = provisioners.get(host.name);
    if (provisioner === undefined) throw new Error(`unknown host ${host.name}`);
    const repo = repoForTask(candidate.task, config);
    const role = candidate.role;
    const git = new CommandGitVerifier({
      remote: repo.url,
      ...(repo.dir.length === 0 ? {} : { repoDir: repo.dir }),
      runner: new NodeExecutor(),
    });
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
      board: boardPort,
      sinkFor: (correlation, secrets) =>
        new EventSink({ store: new JsonlEventStore(config.observability.eventsPath), correlation, secrets }),
      modulePath: config.container.modulePath,
      port: config.container.port,
      verifyRetries: 0,
      onProgress: log,
    };
    const attempt: TaskAttempt = {
      taskId: String(candidate.task.id),
      repo: repo.url,
      role,
      prompt: promptForTask(candidate.task, role),
      containerId: containerName(candidate.task.id, role),
      ...(role === "reviewer" ? { branch: branchForTask(candidate.task) } : {}),
    };
    return new TaskLoop(deps).run(attempt);
  };

  const deps: DaemonDeps = {
    config,
    snapshot: () => board.getBoard(config.board.id),    claim: async (candidate) => {
      await board.claim(config.board.id, candidate.column.id, candidate.task.id, "fleet-daemon");
    },
    release: async (candidate) => {
      await board.release(config.board.id, candidate.column.id, candidate.task.id);
    },
    moveTo: (taskId, columnName) => boardPort.moveTo(String(taskId), columnName),
    note: (taskId, note) => boardPort.appendNote(String(taskId), note),
    admit: (input) => scheduler.admit(input),
    runAttempt,
    state,
    log,
  };

  const daemon = new FleetDaemon(deps);
  const runOnce = async (taskId: number, role: Role): Promise<void> => {
    const snapshot = await board.getBoard(config.board.id);
    const found = findTask(snapshot, taskId);
    if (found === undefined) throw new Error(`task ${taskId} not found on board`);
    const host = config.hosts[0];
    if (host === undefined) throw new Error("no hosts configured");
    await daemon.runCandidate({ task: found.task, column: found.column, role }, host);
  };

  return { daemon, state, runOnce, close: () => state.close() };
}
