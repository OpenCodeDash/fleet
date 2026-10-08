import { readFileSync } from "node:fs";
import { compile, type Catalog } from "../capability/index.ts";
import type { Role } from "../capability/types.ts";
import { CredentialBroker, envCredentialProviders } from "../credentials/index.ts";
import { BoardClient, findTask } from "../board/client.ts";
import { createBoardPort } from "../board/port.ts";
import type { Task } from "../board/types.ts";
import { CommandGitVerifier } from "../git/index.ts";
import { Scheduler } from "../limits/index.ts";
import { TaskLoop } from "../loop/index.ts";
import type { AttemptOutcome, BoardPort, LoopDeps, TaskAttempt } from "../loop/types.ts";
import { OpencodeAgentRunner } from "../agents/index.ts";
import { EventSink, JsonlEventStore } from "../observability/index.ts";
import {
  NodeExecutor,
  SshCommandRunner,
  makeSshTunnelFactory,
  type TunnelFactory,
} from "../remote/index.ts";
import { EgressRegistrar } from "../egress/index.ts";
import { NixosContainerBackend } from "../provision/backend.ts";
import { ContainerProvisioner } from "../provision/provisioner.ts";
import type { CommandRunner } from "../provision/types.ts";
import { Reconciler, type ReconcileReport } from "../recovery/index.ts";
import type { BoardConfig, HostConfig, RepoConfig, RuntimeConfig } from "../runtime-config.ts";
import { FleetDaemon } from "./daemon.ts";
import { SqliteStateStore } from "./state.ts";
import type { Candidate, DaemonDeps } from "./types.ts";

const MAX_NAME_LENGTH = 11;

export interface DaemonHandle {
  daemon: FleetDaemon;
  state: SqliteStateStore;
  boards: BoardClient[];
  /** Run a single attempt for a task id (the `once` debug command); searches all boards unless a board id is given. */
  runOnce(taskId: number, role: Role, boardId?: string): Promise<void>;
  /** Reconcile the boards against running containers (startup + the `reconcile` command). */
  reconcile(): Promise<ReconcileReport>;
  /** Subscribe to board events (the stream is global; one client is enough). */
  subscribeEvents(onEvent: (event: unknown) => void, signal: AbortSignal): void;
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

export function promptForTask(task: Task, role: Role, repoUrl: string): string {
  const spec = task.description ? `${task.name}\n\n${task.description}` : task.name;
  const branch = branchForTask(task);
  return role === "author"
    ? `Task: ${spec}\n\nRepository: ${repoUrl}\n\nClone the repository, create the branch ${branch}, do the work, commit, and push ${branch} to origin.`
    : `Task: ${spec}\n\nRepository: ${repoUrl}\n\nReview the change on branch ${branch}: clone the repository, check out ${branch}, verify it satisfies the task, and run any tests. If it passes, merge ${branch} into main, push main, and delete the remote branch ${branch}.`;
}

/**
 * Container name for one attempt. Must be unique per host and ≤ 11 chars (nixos-container /
 * veth limit), and task ids are only unique per board, so the board id is included. The task
 * id is base36-encoded to leave room for the board id.
 */
export function containerName(boardId: string, taskId: number, role: Role): string {
  const suffix = `${taskId.toString(36)}${role === "reviewer" ? "r" : "a"}`;
  const board = boardId.toLowerCase().replace(/[^a-z0-9]/g, "") || "x";
  const room = Math.max(1, MAX_NAME_LENGTH - 1 - suffix.length);
  return `c${board.slice(0, room)}${suffix}`;
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

/** Build the daemon and its collaborators from `RuntimeConfig`. */
export function createDaemon(
  config: RuntimeConfig,
  env: Record<string, string | undefined>,
  log: (message: string) => void = (message) => process.stdout.write(`[daemon] ${message}\n`),
): DaemonHandle {
  const catalog = JSON.parse(readFileSync(config.catalog, "utf8")) as Catalog;

  const boardClients = new Map<string, BoardClient>();
  const boardPorts = new Map<string, BoardPort>();
  for (const board of config.boards) {
    const client = new BoardClient({
      url: board.url,
      ...(board.token === undefined
        ? {}
        : { headers: { authorization: `Bearer ${board.token}` } }),
    });
    boardClients.set(board.id, client);
    boardPorts.set(board.id, createBoardPort(client, board.id));
  }
  const clientFor = (board: BoardConfig): BoardClient => {
    const client = boardClients.get(board.id);
    if (client === undefined) throw new Error(`no client for board "${board.id}"`);
    return client;
  };
  const portFor = (board: BoardConfig): BoardPort => {
    const port = boardPorts.get(board.id);
    if (port === undefined) throw new Error(`no port for board "${board.id}"`);
    return port;
  };

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
  const runners = new Map<string, CommandRunner>();
  for (const host of config.hosts) {
    const executor = new NodeExecutor();
    let runner: CommandRunner;
    let tunnel: TunnelFactory | undefined;
    if (host.local === true) {
      // Co-located: drive nixos-container directly; containers are reachable without a tunnel.
      runner = executor;
    } else {
      const ssh = host.ssh;
      if (ssh === undefined) throw new Error(`host "${host.name}" needs ssh or local: true`);
      const sshExtra = ssh.key === undefined ? [] : ["-i", ssh.key, "-o", "IdentitiesOnly=yes"];
      runner = new SshCommandRunner({
        host: ssh.host,
        user: ssh.user,
        extraArgs: sshExtra,
        executor,
      });
      tunnel = makeSshTunnelFactory({
        target: ssh.user === undefined ? ssh.host : `${ssh.user}@${ssh.host}`,
        extraArgs: sshExtra,
      });
    }
    runners.set(host.name, runner);
    const registrar =
      host.egress === undefined
        ? undefined
        : new EgressRegistrar({ adminUrl: host.egress.adminUrl });
    provisioners.set(
      host.name,
      new ContainerProvisioner(
        new NixosContainerBackend(runner, {
          ...(tunnel === undefined ? {} : { tunnel }),
          dns: config.container.dns,
          ...(registrar === undefined ? {} : { registrar }),
        }),
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
      // Private repos: verify with the same token the container pushes with.
      ...(env.FLEET_GITHUB_TOKEN === undefined ? {} : { token: env.FLEET_GITHUB_TOKEN }),
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
      board: portFor(candidate.board),
      sinkFor: (correlation, secrets) =>
        new EventSink({ store: new JsonlEventStore(config.observability.eventsPath), correlation, secrets }),
      modulePath: config.container.modulePath,
      port: config.container.port,
      verifyRetries: 0,
      columns: {
        // Derive the role transitions from the board so boards without the standard
        // columns (e.g. no Code Review) still work.
        review: candidate.board.queues.reviewer[0] ?? candidate.board.done,
        changes:
          candidate.board.queues.author[1] ?? candidate.board.queues.author[0] ?? candidate.board.done,
        done: candidate.board.done,
        blocked: candidate.board.blocked[0] ?? candidate.board.done,
      },
      onProgress: log,
      ...(host.egress === undefined
        ? {}
        : {
            egress: {
              proxyUrl: host.egress.proxyUrl,
              base: host.egress.base,
              ...(host.egress.noProxy === undefined ? {} : { noProxy: host.egress.noProxy }),
            },
          }),
    };
    const attempt: TaskAttempt = {
      taskId: String(candidate.task.id),
      repo: repo.url,
      role,
      prompt: promptForTask(candidate.task, role, repo.url),
      containerId: containerName(candidate.board.id, candidate.task.id, role),
      ...(role === "reviewer" ? { branch: branchForTask(candidate.task) } : {}),
    };
    return new TaskLoop(deps).run(attempt);
  };

  const deps: DaemonDeps = {
    config,
    snapshot: (board) => clientFor(board).getBoard(board.id),
    claim: async (candidate) => {
      await clientFor(candidate.board).claim(
        candidate.board.id,
        candidate.column.id,
        candidate.task.id,
        "fleet-daemon",
      );
    },
    release: async (candidate) => {
      // The attempt may have moved the task to another column (e.g. Code Review), so release
      // it where it currently sits, not where it was claimed.
      const client = clientFor(candidate.board);
      const snapshot = await client.getBoard(candidate.board.id);
      const found = findTask(snapshot, candidate.task.id);
      if (found !== undefined) {
        await client.release(candidate.board.id, found.column.id, candidate.task.id);
      }
    },
    moveTo: (board, taskId, columnName) => portFor(board).moveTo(String(taskId), columnName),
    note: (board, taskId, note) => portFor(board).appendNote(String(taskId), note),
    admit: (input) => scheduler.admit(input),
    runAttempt,
    state,
    log,
  };

  const daemon = new FleetDaemon(deps);

  const runOnce = async (taskId: number, role: Role, boardId?: string): Promise<void> => {
    const targets = boardId === undefined ? config.boards : config.boards.filter((b) => b.id === boardId);
    if (targets.length === 0) throw new Error(`unknown board "${boardId}"`);
    const host = config.hosts[0];
    if (host === undefined) throw new Error("no hosts configured");
    for (const board of targets) {
      const snapshot = await clientFor(board).getBoard(board.id);
      const found = findTask(snapshot, taskId);
      if (found !== undefined) {
        await daemon.runCandidate({ task: found.task, column: found.column, role, board }, host);
        return;
      }
    }
    throw new Error(`task ${taskId} not found on any configured board`);
  };

  const reconcile = async (): Promise<ReconcileReport> => {
    let hostOf = new Map<string, string>();
    const reconciler = new Reconciler({
      inProgressTasks: async () =>
        state.running().map((record) => ({
          boardId: record.boardId,
          taskId: String(record.taskId),
          containerId: record.containerId,
          capabilityHash: record.capabilityHash,
        })),
      runningContainers: async () => {
        hostOf = new Map();
        for (const [hostName, runner] of runners) {
          const result = await runner.run("nixos-container", ["list"]);
          for (const name of result.stdout
            .split("\n")
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0)) {
            hostOf.set(name, hostName);
          }
        }
        return [...hostOf.keys()].map((containerId) => ({ containerId, capabilityHash: null }));
      },
      destroyContainer: async (containerId) => {
        const runner = runners.get(hostOf.get(containerId) ?? "");
        if (runner !== undefined) {
          await runner.run("nixos-container", ["terminate", containerId]);
          await runner.run("nixos-container", ["destroy", containerId]);
        }
      },
      revokeCredentials: (containerId) => broker.revoke(containerId),
      requeue: async (boardId, taskId) => {
        const board = config.boards.find((entry) => entry.id === boardId);
        if (board !== undefined) {
          await portFor(board).moveTo(taskId, board.queues.author[0] ?? "Todo");
        }
        state.stopRunning(boardId, Number(taskId));
      },
    });
    return reconciler.reconcile();
  };

  const subscribeEvents = (onEvent: (event: unknown) => void, signal: AbortSignal): void => {
    // The server's /events stream is global, so one client covers every board.
    const first = config.boards[0];
    if (first !== undefined) void clientFor(first).subscribeEvents(onEvent, signal);
  };

  return {
    daemon,
    state,
    boards: [...boardClients.values()],
    runOnce,
    reconcile,
    subscribeEvents,
    close: () => state.close(),
  };
}
