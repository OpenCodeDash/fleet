import type { CapabilityRequest, CompiledCapabilities, Role } from "../capability/types.ts";
import type { Correlation, EventSink } from "../observability/index.ts";
import type { ContainerHandle, ContainerSpec } from "../provision/types.ts";

export interface AuthorResult {
  status: "done";
  branch: string;
  head_sha: string;
  base_sha: string;
  pr_url?: string;
  summary: string;
}

export interface ReviewerResult {
  verdict: "approve" | "changes";
  note: string;
  pr_review_comments?: string[];
  merge_sha?: string;
}

export type CompletionResult =
  | { kind: "author"; result: AuthorResult }
  | { kind: "reviewer"; result: ReviewerResult };

export interface AgentRunInput {
  address: string;
  role: Role;
  prompt: string;
  sessionTitle: string;
  sink: EventSink;
}

export interface GitVerifier {
  remoteRefExists(branch: string, sha: string): Promise<boolean>;
  isAncestorOfMain(sha: string): Promise<boolean>;
  branchDeleted(branch: string): Promise<boolean>;
}

/** The board operations the loop needs; a thin adapter over BoardClient (orchestrator owns writes). */
export interface BoardPort {
  moveTo(taskId: string, columnName: string): Promise<void>;
  appendNote(taskId: string, note: string): Promise<void>;
}

export interface TaskAttempt {
  taskId: string;
  repo: string;
  role: Role;
  prompt: string;
  containerId: string;
  /** Feature branch under review — required for the reviewer role. */
  branch?: string;
  grants?: CapabilityRequest["grants"];
}

export type AttemptOutcome =
  | { status: "completed"; action: "code-review" | "done" | "changes-requested" }
  | { status: "failed"; reason: string; escalate: boolean };

export interface LoopDeps {
  compile(request: CapabilityRequest): CompiledCapabilities;
  mintCredentials(
    containerId: string,
    requirements: CompiledCapabilities["credentials"],
  ): Promise<{ env: Record<string, string> }>;
  revokeCredentials(containerId: string): Promise<void>;
  provision(spec: ContainerSpec): Promise<ContainerHandle>;
  destroy(handle: ContainerHandle): Promise<void>;
  runAgent(input: AgentRunInput): Promise<CompletionResult>;
  git: GitVerifier;
  board: BoardPort;
  sinkFor(correlation: Correlation, secrets: string[]): EventSink;
  /** Host path of the container module (e.g. /etc/nixos/image/fleet-agent.nix). */
  modulePath: string;
  port: number;
  verifyRetries: number;
}
