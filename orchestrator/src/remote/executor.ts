import { spawn } from "node:child_process";
import type { CommandResult } from "../provision/types.ts";

/** Executes a local process. Injected so remote-command building is testable. */
export interface Executor {
  exec(file: string, args: string[], options?: { input?: string }): Promise<CommandResult>;
}

/** Real executor backed by `node:child_process`. */
export class NodeExecutor implements Executor {
  exec(file: string, args: string[], options: { input?: string } = {}): Promise<CommandResult> {
    return new Promise((resolve) => {
      const child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const done = (result: CommandResult): void => {
        if (!settled) {
          settled = true;
          resolve(result);
        }
      };
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("error", (error: Error) => {
        done({ code: 127, stdout, stderr: stderr + error.message });
      });
      child.on("close", (code: number | null) => {
        done({ code: code ?? -1, stdout, stderr });
      });
      if (options.input !== undefined) child.stdin?.write(options.input);
      child.stdin?.end();
    });
  }
}
