import { EgressProxy } from "./proxy.ts";
import { startEgressAdmin } from "./admin.ts";

/**
 * Entrypoint for the host-side egress proxy. Runs on the fleet host as a systemd service;
 * the orchestrator registers per-container allowlists via the admin port. Config via env:
 *   FLEET_EGRESS_PORT        proxy port (default 3128)
 *   FLEET_EGRESS_ADMIN_PORT  admin port (default 3129)
 *   FLEET_EGRESS_ALLOW       base allowlist, comma-separated (orchestrator, model provider)
 */
async function main(): Promise<void> {
  const port = Number(process.env.FLEET_EGRESS_PORT ?? "3128");
  const adminPort = Number(process.env.FLEET_EGRESS_ADMIN_PORT ?? "3129");
  const baseAllow = (process.env.FLEET_EGRESS_ALLOW ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  const proxy = new EgressProxy({
    allowlist: baseAllow,
    onEvent: (event) => {
      console.log(
        `${event.allowed ? "ALLOW" : "DENY "} ${event.method} ${event.host} (${event.client})`,
      );
    },
  });

  await proxy.listen(port, "0.0.0.0");
  await startEgressAdmin(proxy, adminPort, "0.0.0.0");
  console.log(`egress proxy on :${port}, admin on :${adminPort}, base allowlist [${baseAllow.join(", ")}]`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
