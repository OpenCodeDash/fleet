import { createServer, request as httpRequest, type Server } from "node:http";
import { connect as netConnect } from "node:net";
import type { Duplex } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isAllowed, normalizeHost } from "./allowlist.ts";

export interface EgressEvent {
  host: string;
  allowed: boolean;
  method: string;
}

export interface EgressProxyOptions {
  /** Host patterns that may be reached; everything else is denied. */
  allowlist: string[];
  onEvent?: (event: EgressEvent) => void;
}

/**
 * Default-deny forward proxy. Plain HTTP requests are forwarded only for allowlisted hosts;
 * HTTPS is tunnelled via CONNECT after the same check. This is the network-layer boundary
 * that makes tool-level gating meaningful (see docs/egress.md, ADR 0008).
 */
export class EgressProxy {
  private readonly allowlist: string[];
  private readonly onEvent: ((event: EgressEvent) => void) | undefined;
  private server: Server | null = null;

  constructor(options: EgressProxyOptions) {
    this.allowlist = options.allowlist;
    this.onEvent = options.onEvent;
  }

  private decide(host: string, method: string): boolean {
    const allowed = isAllowed(host, this.allowlist);
    this.onEvent?.({ host: normalizeHost(host), allowed, method });
    return allowed;
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    let target: URL;
    try {
      target = new URL(req.url ?? "");
    } catch {
      res.writeHead(400, { "content-type": "text/plain" }).end("bad request");
      return;
    }
    if (!this.decide(target.host, req.method ?? "GET")) {
      res.writeHead(403, { "content-type": "text/plain" }).end("blocked by egress policy");
      return;
    }
    const upstream = httpRequest(
      {
        host: target.hostname,
        port: target.port === "" ? 80 : Number(target.port),
        path: `${target.pathname}${target.search}`,
        method: req.method,
        headers: req.headers,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end("upstream error");
    });
    req.pipe(upstream);
  }

  private handleConnect(req: IncomingMessage, clientSocket: Duplex, head: Buffer): void {
    const authority = req.url ?? "";
    if (!this.decide(authority, "CONNECT")) {
      clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const [hostname, port] = authority.split(":");
    const upstream = netConnect(Number(port ?? 443), hostname, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
  }

  /** Start listening; resolves with the actual bound port (0 → ephemeral). */
  listen(port = 0, host = "127.0.0.1"): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => this.handleRequest(req, res));
      server.on("connect", (req, socket, head) => this.handleConnect(req, socket, head));
      server.on("error", reject);
      server.listen(port, host, () => {
        this.server = server;
        const address = server.address();
        resolve(typeof address === "object" && address !== null ? address.port : port);
      });
    });
  }

  async close(): Promise<void> {
    const server = this.server;
    if (server === null) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.server = null;
  }
}
