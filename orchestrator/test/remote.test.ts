import assert from "node:assert/strict";
import { test } from "node:test";
import { NodeExecutor, SshCommandRunner, type Executor } from "../src/remote/index.ts";
import type { CommandResult } from "../src/provision/types.ts";

interface Call {
  file: string;
  args: string[];
  input: string | undefined;
}

function fakeExecutor(result: CommandResult = { code: 0, stdout: "", stderr: "" }): {
  executor: Executor;
  calls: Call[];
} {
  const calls: Call[] = [];
  const executor: Executor = {
    async exec(file, args, options) {
      calls.push({ file, args, input: options?.input });
      return result;
    },
  };
  return { executor, calls };
}

test("SshCommandRunner runs the command on the target host", async () => {
  const { executor, calls } = fakeExecutor();
  const runner = new SshCommandRunner({ host: "agents.bigbox", executor });
  await runner.run("nixos-container", ["start", "ctrl1"]);
  assert.deepEqual(calls[0], {
    file: "ssh",
    args: ["agents.bigbox", "nixos-container", "start", "ctrl1"],
    input: undefined,
  });
});

test("SshCommandRunner supports user, extra args and stdin", async () => {
  const { executor, calls } = fakeExecutor();
  const runner = new SshCommandRunner({
    host: "h",
    user: "root",
    ssh: "/usr/bin/ssh",
    extraArgs: ["-o", "BatchMode=yes"],
    executor,
  });
  await runner.run("tee", ["/run/fleet/x.nix"], { input: "contents" });
  assert.deepEqual(calls[0], {
    file: "/usr/bin/ssh",
    args: ["-o", "BatchMode=yes", "root@h", "tee", "/run/fleet/x.nix"],
    input: "contents",
  });
});

test("SshCommandRunner returns the executor result", async () => {
  const { executor } = fakeExecutor({ code: 1, stdout: "", stderr: "boom" });
  const runner = new SshCommandRunner({ host: "h", executor });
  assert.deepEqual(await runner.run("false", []), { code: 1, stdout: "", stderr: "boom" });
});

test("NodeExecutor captures stdout and the exit code", async () => {
  const executor = new NodeExecutor();
  const ok = await executor.exec(process.execPath, ["-e", "process.stdout.write('hi')"]);
  assert.equal(ok.code, 0);
  assert.equal(ok.stdout, "hi");

  const bad = await executor.exec(process.execPath, ["-e", "process.exit(7)"]);
  assert.equal(bad.code, 7);
});

test("NodeExecutor pipes stdin to the child", async () => {
  const executor = new NodeExecutor();
  const script =
    "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>process.stdout.write(d.toUpperCase()))";
  const out = await executor.exec(process.execPath, ["-e", script], { input: "abc" });
  assert.equal(out.code, 0);
  assert.equal(out.stdout, "ABC");
});
