import type { AgentRunInput, AuthorResult, CompletionResult, ReviewerResult } from "../loop/types.ts";
import type { FetchLike } from "../provision/types.ts";
import { SseParser, type SseFrame } from "../observability/index.ts";

export class AgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentError";
  }
}

/** opencode structured-output schema for the author handoff. */
const AUTHOR_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { const: "done" },
    branch: { type: "string" },
    head_sha: { type: "string" },
    base_sha: { type: "string" },
    pr_url: { type: "string" },
    summary: { type: "string" },
  },
  required: ["status", "branch", "head_sha", "base_sha", "summary"],
} as const;

/** opencode structured-output schema for the reviewer verdict. */
const REVIEWER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    verdict: { enum: ["approve", "changes"] },
    note: { type: "string" },
    merge_sha: { type: "string" },
    pr_review_comments: { type: "array", items: { type: "string" } },
  },
  required: ["verdict", "note"],
} as const;

export interface OpencodeAgentRunnerOptions {
  fetchImpl?: FetchLike;
  /** Provider/model to run, in opencode's `{ providerID, modelID }` shape (optional). */
  model?: { providerID: string; modelID: string };
  /** opencode agent name to run (optional; defaults to the server default). */
  agent?: string;
  /** Receives a line per container event (tool calls, steps) — for live CLI output. */
  log?: (message: string) => void;
  /** Auto-approve `permission.asked` events (headless runs have no one to approve). */
  autoApprove?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A short, readable summary of an event's `properties` (tool/name/status). */
function summarizeEvent(data: unknown): string {
  if (!isRecord(data) || !isRecord(data.properties)) return "";
  const properties = data.properties;
  const bits: string[] = [];
  for (const key of ["tool", "name", "status", "reason"]) {
    const value = properties[key];
    if (typeof value === "string" && value.length > 0) bits.push(`${key}=${value}`);
  }
  return bits.length > 0 ? ` ${bits.join(" ")}` : "";
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AgentError(`${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, key: string, what: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new AgentError(`${what}.${key} must be a non-empty string`);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new AgentError(`${key} must be a string`);
  return value;
}

function readSessionId(value: unknown): string {
  const session = asRecord(value, "session create response");
  if (typeof session.id !== "string" || session.id.length === 0) {
    throw new AgentError("session create response had no id");
  }
  return session.id;
}

function extractStructured(message: unknown): unknown {
  const record = asRecord(message, "message response");
  const info = record.info;
  if (isRecord(info)) {
    // The assistant message carries a terminal error when the turn failed.
    if (info.error !== undefined && info.error !== null) {
      const error = isRecord(info.error) ? info.error : {};
      const name = typeof error.name === "string" ? error.name : "error";
      const data = isRecord(error.data) ? error.data : {};
      const detail =
        typeof data.message === "string" ? data.message : JSON.stringify(error).slice(0, 200);
      throw new AgentError(`agent failed: ${name} — ${detail}`);
    }
    // opencode stores the schema'd result on the assistant message as `structured`.
    if (info.structured !== undefined && info.structured !== null) return info.structured;
  }
  if (record.structured !== undefined && record.structured !== null) return record.structured;
  if (record.structured_output !== undefined) return record.structured_output;
  throw new AgentError("opencode response did not include structured output");
}

export function parseAuthorResult(value: unknown): AuthorResult {
  const record = asRecord(value, "author result");
  if (record.status !== "done") throw new AgentError('author result.status must be "done"');
  const pr = optionalString(record, "pr_url");
  return {
    status: "done",
    branch: requireString(record, "branch", "author result"),
    head_sha: requireString(record, "head_sha", "author result"),
    base_sha: requireString(record, "base_sha", "author result"),
    summary: requireString(record, "summary", "author result"),
    ...(pr === undefined ? {} : { pr_url: pr }),
  };
}

export function parseReviewerResult(value: unknown): ReviewerResult {
  const record = asRecord(value, "reviewer result");
  const verdict = record.verdict;
  if (verdict !== "approve" && verdict !== "changes") {
    throw new AgentError('reviewer result.verdict must be "approve" or "changes"');
  }
  const merge = optionalString(record, "merge_sha");
  const rawComments = record.pr_review_comments;
  let comments: string[] | undefined;
  if (rawComments !== undefined) {
    if (!Array.isArray(rawComments) || !rawComments.every((c) => typeof c === "string")) {
      throw new AgentError("reviewer result.pr_review_comments must be a string array");
    }
    comments = rawComments as string[];
  }
  return {
    verdict,
    note: requireString(record, "note", "reviewer result"),
    ...(merge === undefined ? {} : { merge_sha: merge }),
    ...(comments === undefined ? {} : { pr_review_comments: comments }),
  };
}

/**
 * Drives one turn of an in-container `opencode serve` over HTTP: create a session, prompt it
 * with a JSON-schema output format, and validate the structured result. Failures throw
 * `AgentError` so the loop treats the attempt as failed. See docs/orchestrator.md.
 */
export class OpencodeAgentRunner {
  private readonly fetchImpl: FetchLike;
  private readonly model: { providerID: string; modelID: string } | undefined;
  private readonly agent: string | undefined;
  private readonly log: ((message: string) => void) | undefined;
  private readonly autoApprove: boolean;

  constructor(options: OpencodeAgentRunnerOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.model = options.model;
    this.agent = options.agent;
    this.log = options.log;
    this.autoApprove = options.autoApprove ?? false;
  }

  /** Stream the container's `/event` SSE, logging a line per frame and auto-approving. */
  async streamEvents(address: string, sessionId: string, signal: AbortSignal): Promise<void> {
    if (this.log === undefined && !this.autoApprove) return;
    try {
      const response = await this.fetchImpl(`${address}/event`, {
        headers: { accept: "text/event-stream" },
        signal,
      });
      if (!response.ok || response.body === null) return;
      const parser = new SseParser();
      const decoder = new TextDecoder();
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
        for (const frame of parser.push(text)) this.emit(frame, address, sessionId);
      }
    } catch {
      // stream ended / aborted / tunnel closed — non-fatal
    }
  }

  private emit(frame: SseFrame, address: string, sessionId: string): void {
    let data: unknown = frame.data;
    try {
      data = JSON.parse(frame.data);
    } catch {
      // leave as a raw string
    }
    const type =
      isRecord(data) && typeof data.type === "string" ? data.type : (frame.event ?? "event");
    const extra =
      type.startsWith("permission") && isRecord(data) && isRecord(data.properties)
        ? ` ${JSON.stringify(data.properties).slice(0, 200)}`
        : summarizeEvent(data);
    this.log?.(`agent ${type}${extra}`);
    if (this.autoApprove && (type === "permission.asked" || type === "permission.updated")) {
      void this.approve(address, sessionId, data);
    }
  }

  private async approve(address: string, sessionId: string, data: unknown): Promise<void> {
    if (!isRecord(data) || !isRecord(data.properties)) return;
    const properties = data.properties;
    const id =
      typeof properties.id === "string"
        ? properties.id
        : typeof properties.permissionID === "string"
          ? properties.permissionID
          : undefined;
    if (id === undefined) return;
    try {
      await this.post(`${address}/session/${sessionId}/permissions/${id}`, { response: "always" });
      this.log?.(`approved permission ${id}`);
    } catch (error) {
      this.log?.(`permission approval failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async run(input: AgentRunInput): Promise<CompletionResult> {
    const session = await this.post(`${input.address}/session`, { title: input.sessionTitle });
    const sessionId = readSessionId(session);
    await input.sink.record({
      source: "lifecycle",
      type: "session-created",
      data: { session: sessionId, role: input.role },
    });

    const schema = input.role === "author" ? AUTHOR_SCHEMA : REVIEWER_SCHEMA;
    const body: Record<string, unknown> = {
      parts: [{ type: "text", text: input.prompt }],
      format: { type: "json_schema", schema },
    };
    if (this.agent !== undefined) body.agent = this.agent;
    if (this.model !== undefined) body.model = this.model;

    // Stream the container's events while the turn runs (best-effort, for live output).
    const abort = new AbortController();
    void this.streamEvents(input.address, sessionId, abort.signal);
    try {
      const message = await this.post(`${input.address}/session/${sessionId}/message`, body);
      const structured = extractStructured(message);
      await input.sink.record({
        source: "lifecycle",
        type: "agent-result",
        data: { role: input.role, structured },
      });

      return input.role === "author"
        ? { kind: "author", result: parseAuthorResult(structured) }
        : { kind: "reviewer", result: parseReviewerResult(structured) };
    } finally {
      abort.abort();
    }
  }

  private async post(url: string, body: unknown): Promise<unknown> {
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let data: unknown = null;
    if (text.length > 0) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!response.ok) {
      throw new AgentError(
        `opencode request to ${url} failed: ${response.status} ${
          typeof data === "string" ? data : JSON.stringify(data)
        }`,
      );
    }
    return data;
  }
}
