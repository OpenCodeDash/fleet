import type { AgentRunInput, AuthorResult, CompletionResult, ReviewerResult } from "../loop/types.ts";
import type { FetchLike } from "../provision/types.ts";

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
  if (typeof info === "object" && info !== null && "structured_output" in info) {
    return (info as Record<string, unknown>).structured_output;
  }
  if ("structured_output" in record) return record.structured_output;
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

  constructor(options: OpencodeAgentRunnerOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.model = options.model;
    this.agent = options.agent;
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
