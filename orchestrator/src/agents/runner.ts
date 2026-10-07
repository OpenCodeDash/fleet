import type { AgentRunInput, AuthorResult, CompletionResult, ReviewerResult } from "../loop/types.ts";
import type { FetchLike } from "../provision/types.ts";
import type { Role } from "../capability/types.ts";
import { SseParser, type SseFrame } from "../observability/index.ts";

export class AgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentError";
  }
}

/** Instruction appended to the prompt: end with a fenced JSON handoff block. */
function handoffInstruction(role: Role): string {
  const shape =
    role === "author"
      ? '{"status":"done","branch":"<branch>","head_sha":"<sha>","base_sha":"<sha>","summary":"<summary>"}'
      : '{"verdict":"approve"|"changes","note":"<note>","merge_sha":"<sha when approving>"}';
  return [
    "When you are finished, end your reply with a single fenced json block and nothing after it:",
    "```json",
    shape,
    "```",
    "Fill in the real values. Do not call any more tools after this.",
  ].join("\n");
}

/** Concatenate the text of an assistant message's text parts. */
function textOf(message: unknown): string {
  if (!isRecord(message) || !Array.isArray(message.parts)) return "";
  return message.parts
    .filter(
      (part): part is { type: string; text: string } =>
        isRecord(part) && part.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("\n");
}

/** Extract and parse the fenced json handoff block from the assistant message. */
function extractHandoff(message: unknown): unknown {
  if (isRecord(message) && isRecord(message.info) && message.info.error != null) {
    const error = message.info.error;
    const name = isRecord(error) && typeof error.name === "string" ? error.name : "error";
    const detail = isRecord(error) && isRecord(error.data) && typeof error.data.message === "string"
      ? error.data.message
      : JSON.stringify(error).slice(0, 200);
    throw new AgentError(`agent failed: ${name} — ${detail}`);
  }
  const text = textOf(message);
  const match = /```json\s*([\s\S]*?)```/.exec(text) ?? /```\s*([\s\S]*?)```/.exec(text);
  if (match === null) throw new AgentError("agent did not return a ```json handoff block");
  try {
    return JSON.parse((match[1] ?? "").trim());
  } catch {
    throw new AgentError("agent returned an invalid json handoff block");
  }
}

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
  /** Abort the agent turn after this many ms (default 300000). */
  turnTimeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  private readonly turnTimeoutMs: number;
  /** partID → characters of text already logged (so updates print only the suffix). */
  private readonly partText = new Map<string, number>();

  constructor(options: OpencodeAgentRunnerOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.model = options.model;
    this.agent = options.agent;
    this.log = options.log;
    this.autoApprove = options.autoApprove ?? false;
    this.turnTimeoutMs = options.turnTimeoutMs ?? 300_000;
  }

  /** Stream the container's `/event` SSE, logging a line per frame and auto-approving. */
  async streamEvents(address: string, signal: AbortSignal): Promise<void> {
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
        for (const frame of parser.push(text)) this.emit(frame, address);
      }
    } catch {
      // stream ended / aborted / tunnel closed — non-fatal
    }
  }

  private emit(frame: SseFrame, address: string): void {
    let data: unknown = frame.data;
    try {
      data = JSON.parse(frame.data);
    } catch {
      // leave as a raw string
    }
    const type =
      isRecord(data) && typeof data.type === "string" ? data.type : (frame.event ?? "event");
    const properties = isRecord(data) && isRecord(data.properties) ? data.properties : undefined;

    if (type === "message.part.updated" && properties !== undefined && isRecord(properties.part)) {
      this.emitPart(properties.part);
      return;
    }
    if (type === "permission.asked" || type === "permission.updated") {
      this.log?.(`permission ${JSON.stringify(properties ?? {}).slice(0, 200)}`);
      if (this.autoApprove) void this.approve(address, data);
      return;
    }
    if (type === "session.idle") {
      this.log?.("idle");
      return;
    }
    if (/error/i.test(type)) {
      this.log?.(`${type} ${JSON.stringify(properties ?? {}).slice(0, 300)}`);
      return;
    }
    // session.status / session.updated / plugin.added / heartbeat / deltas are noise.
  }

  /** Render a message part: assistant text, thinking, or a tool call. */
  private emitPart(part: Record<string, unknown>): void {
    const kind = part.type;
    const id = typeof part.id === "string" ? part.id : undefined;
    if ((kind === "text" || kind === "reasoning") && typeof part.text === "string") {
      if (id === undefined) return;
      const printed = this.partText.get(id) ?? 0;
      const text = part.text;
      if (text.length > printed) {
        this.log?.(`${kind === "text" ? "assistant" : "thinking"}: ${text.slice(printed)}`);
        this.partText.set(id, text.length);
      }
      return;
    }
    if (kind === "tool") {
      const tool = typeof part.tool === "string" ? part.tool : "tool";
      const state = isRecord(part.state) ? part.state : {};
      const status = typeof state.status === "string" ? state.status : "";
      this.log?.(`tool: ${tool}${status ? ` [${status}]` : ""}`);
    }
  }

  private async approve(address: string, data: unknown): Promise<void> {
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
      await this.post(`${address}/permission/${id}/reply`, { reply: "always" });
      this.log?.(`approved permission ${id}`);
    } catch (error) {
      this.log?.(`permission approval failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async run(input: AgentRunInput): Promise<CompletionResult> {
    this.partText.clear();
    const session = await this.post(`${input.address}/session`, { title: input.sessionTitle });
    const sessionId = readSessionId(session);
    await input.sink.record({
      source: "lifecycle",
      type: "session-created",
      data: { session: sessionId, role: input.role },
    });

    const body: Record<string, unknown> = {
      parts: [{ type: "text", text: `${input.prompt}\n${handoffInstruction(input.role)}` }],
    };
    if (this.agent !== undefined) body.agent = this.agent;
    if (this.model !== undefined) body.model = this.model;

    // Stream the container's events while the turn runs (best-effort, for live output).
    const abort = new AbortController();
    void this.streamEvents(input.address, abort.signal);
    const timer = setTimeout(() => abort.abort(), this.turnTimeoutMs);
    try {
      const message = await this.post(
        `${input.address}/session/${sessionId}/message`,
        body,
        abort.signal,
      );
      const structured = extractHandoff(message);
      await input.sink.record({
        source: "lifecycle",
        type: "agent-result",
        data: { role: input.role, structured },
      });

      return input.role === "author"
        ? { kind: "author", result: parseAuthorResult(structured) }
        : { kind: "reviewer", result: parseReviewerResult(structured) };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new AgentError(`agent turn exceeded ${this.turnTimeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      abort.abort();
    }
  }

  private async post(url: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
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
