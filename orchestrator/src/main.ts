import { loadConfig } from "./config.ts";
import { createRuntime, containerName, runtimeOptionsFromEnv } from "./runtime.ts";
import type { Role } from "./capability/types.ts";

export async function run(argv: string[], env: Record<string, string | undefined>): Promise<number> {
  const [command, taskId, roleArg] = argv;
  if (command !== "run" || taskId === undefined) {
    console.error(
      "usage: run <taskId> <author|reviewer>\n" +
        "env: FLEET_CATALOG FLEET_BOARD_URL FLEET_BOARD_ID FLEET_SSH_HOST FLEET_REPO_DIR FLEET_REPO FLEET_PROMPT\n" +
        "     FLEET_MODULE_PATH FLEET_EVENTS_PATH FLEET_MODEL_PROVIDER FLEET_MODEL_ID FLEET_AGENT\n" +
        "     FLEET_INJECT_<NAME>=... (injected into the container)",
    );
    return 2;
  }
  const config = loadConfig({ filePath: env.FLEET_CONFIG, env, strictEnv: false });
  const runtime = createRuntime({
    ...runtimeOptionsFromEnv(config, env),
    onProgress: (message) => {
      process.stdout.write(`[fleet] ${message}\n`);
    },
  });
  const outcome = await runtime.runAttempt({
    taskId,
    repo: env.FLEET_REPO ?? "",
    role: (roleArg ?? "author") as Role,
    prompt: env.FLEET_PROMPT ?? `Work on task ${taskId}.`,
    containerId: containerName(taskId),
    branch: env.FLEET_BRANCH,
  });
  console.log(JSON.stringify(outcome, null, 2));
  return outcome.status === "completed" ? 0 : 1;
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
