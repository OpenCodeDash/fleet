import { createServer, type Server } from "node:http";
import type { EgressProxy } from "./proxy.ts";

async function readJson(req: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text.length === 0 ? null : JSON.parse(text);
}

/**
 * Admin API the orchestrator uses to register a container's egress allowlist when it
 * provisions (and to drop it at teardown). Not exposed to containers.
 */
export function startEgressAdmin(
  proxy: EgressProxy,
  port: number,
  host = "0.0.0.0",
): Promise<Server> {
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
      try {
        if (req.method === "GET" && segments.length === 1 && segments[0] === "clients") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(proxy.clients()));
          return;
        }
        if (req.method === "POST" && segments.length === 1 && segments[0] === "allowlist") {
          const body = (await readJson(req)) as { client?: unknown; hosts?: unknown } | null;
          const client = body?.client;
          const hosts = body?.hosts;
          if (
            typeof client !== "string" ||
            !Array.isArray(hosts) ||
            !hosts.every((entry) => typeof entry === "string")
          ) {
            res.writeHead(400).end("expected { client, hosts: string[] }");
            return;
          }
          proxy.register(client, hosts as string[]);
          res.writeHead(204).end();
          return;
        }
        if (req.method === "DELETE" && segments.length === 2 && segments[0] === "allowlist") {
          proxy.unregister(segments[1] ?? "");
          res.writeHead(204).end();
          return;
        }
        res.writeHead(404).end("not found");
      } catch (error) {
        res.writeHead(500).end(error instanceof Error ? error.message : String(error));
      }
    })();
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}
