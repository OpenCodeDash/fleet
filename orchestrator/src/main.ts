import { loadRuntimeConfig } from "./runtime-config.ts";
import { createDaemon } from "./daemon/index.ts";
import type { Role } from "./capability/types.ts";

const USAGE = `fleet orchestrator
usage:
  run                      run the daemon (polls the board)
  once <taskId> <role>     run one attempt (author|reviewer)
  status                   print in-flight attempts
env:
  FLEET_CONFIG             path to orchestrator.yaml (default ./orchestrator.yaml)
  FLEET_STATE_PATH         path to the state db (default ./fleet-state.sqlite)
  FLEET_POLL_MS            poll interval in ms (default 15000)
  FLEET_INJECT_<NAME>      env injected into every container`;

export async function run(
  argv: string[],
  env: Record<string, string | undefined>,
): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined) {
    console.error(USAGE);
    return 2;
  }

  const config = loadRuntimeConfig({ filePath: env.FLEET_CONFIG ?? "orchestrator.yaml", env });
  const handle = createDaemon(config, env);

  if (command === "status") {
    console.log(JSON.stringify(handle.state.running(), null, 2));
    handle.close();
    return 0;
  }

  if (command === "once") {
    const taskId = Number(rest[0]);
    const role = (rest[1] ?? "author") as Role;
    if (!Number.isInteger(taskId)) {
      console.error("usage: once <taskId> <author|reviewer>");
      handle.close();
      return 2;
    }
    try {
      await handle.runOnce(taskId, role);
      return 0;
    } finally {
      handle.close();
    }
  }

  if (command === "run") {
    const interval = Number(env.FLEET_POLL_MS ?? "15000");
    let running = true;
    const stop = (): void => {
      running = false;
      handle.daemon.stop();
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    console.error(`[daemon] polling the board every ${interval}ms (ctrl-c to stop)`);
    while (running) {
      try {
        await handle.daemon.tick();
      } catch (error) {
        console.error(`[daemon] tick error: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!running) break;
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
    await handle.daemon.waitIdle();
    handle.close();
    console.error("[daemon] stopped");
    return 0;
  }

  console.error(USAGE);
  handle.close();
  return 2;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "");
if (invokedDirectly) {
  run(process.argv.slice(2), process.env)
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
