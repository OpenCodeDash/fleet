export interface SseFrame {
  event?: string;
  data: string;
  id?: string;
}

function parseFrame(raw: string): SseFrame | null {
  const frame: SseFrame = { data: "" };
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith(":")) continue; // comment / keep-alive
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") frame.event = value;
    else if (field === "id") frame.id = value;
    else if (field === "data") dataLines.push(value);
  }
  frame.data = dataLines.join("\n");
  const empty = frame.data.length === 0 && frame.event === undefined && frame.id === undefined;
  return empty ? null : frame;
}

/** Incremental `text/event-stream` parser; feed chunks, receive complete frames. */
export class SseParser {
  private buffer = "";

  push(chunk: string): SseFrame[] {
    this.buffer += chunk.replace(/\r\n/g, "\n");
    const frames: SseFrame[] = [];
    let separator = this.buffer.indexOf("\n\n");
    while (separator !== -1) {
      const raw = this.buffer.slice(0, separator);
      this.buffer = this.buffer.slice(separator + 2);
      const frame = parseFrame(raw);
      if (frame !== null) frames.push(frame);
      separator = this.buffer.indexOf("\n\n");
    }
    return frames;
  }

  /** Flush any trailing frame not terminated by a blank line. */
  end(): SseFrame[] {
    const rest = this.buffer.trim();
    this.buffer = "";
    if (rest.length === 0) return [];
    const frame = parseFrame(rest);
    return frame === null ? [] : [frame];
  }
}
