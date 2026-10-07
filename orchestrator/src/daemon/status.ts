import { createServer, type Server } from "node:http";
import type { FleetDaemon } from "./daemon.ts";

/**
 * Small read-only status surface for the daemon: `/health` and `/tasks` (in-flight attempts).
 * Not exposed to containers. See docs/architecture.md.
 */
export function startStatusServer(
  port: number,
  daemon: FleetDaemon,
  host = "0.0.0.0",
): Promise<Server> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ healthy: true, inFlight: daemon.inFlight().length }));
      return;
    }
    if (url.pathname === "/tasks") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(daemon.inFlight()));
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}
