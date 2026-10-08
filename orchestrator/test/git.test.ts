import assert from "node:assert/strict";
import { test } from "node:test";
import { CommandGitVerifier } from "../src/git/index.ts";
import type { CommandResult, CommandRunner } from "../src/provision/types.ts";

function runnerReturning(result: Partial<CommandResult>): {
  runner: CommandRunner;
  calls: Array<{ command: string; args: string[] }>;
} {
  const calls: Array<{ command: string; args: string[] }> = [];
  const runner: CommandRunner = {
    async run(command, args) {
      calls.push({ command, args });
      return { code: 0, stdout: "", stderr: "", ...result };
    },
  };
  return { runner, calls };
}

const options = (runner: CommandRunner) => ({ repoDir: "/work/repo", remote: "origin", runner });

test("remoteRefExists is true when the ref still points at the reviewed sha", async () => {
  const { runner, calls } = runnerReturning({
    stdout: "abc123\trefs/heads/feat/x\n",
  });
  const verifier = new CommandGitVerifier(options(runner));
  assert.equal(await verifier.remoteRefExists("feat/x", "abc123"), true);
  assert.deepEqual(calls[0]?.args, ["-C", "/work/repo", "ls-remote", "origin", "refs/heads/feat/x"]);
});

test("remoteRefExists queries the remote URL directly when there is no clone", async () => {
  const { runner, calls } = runnerReturning({ stdout: "abc123\trefs/heads/feat/x\n" });
  const verifier = new CommandGitVerifier({ remote: "https://example.com/r.git", runner });
  assert.equal(await verifier.remoteRefExists("feat/x", "abc123"), true);
  assert.deepEqual(calls[0]?.args, ["ls-remote", "https://example.com/r.git", "refs/heads/feat/x"]);
});

test("injects the token into an https remote for a private repo", async () => {
  const { runner, calls } = runnerReturning({ stdout: "abc123\trefs/heads/feat/x\n" });
  const verifier = new CommandGitVerifier({
    remote: "https://github.com/acme/app.git",
    token: "ghp_secret",
    runner,
  });
  assert.equal(await verifier.remoteRefExists("feat/x", "abc123"), true);
  assert.deepEqual(calls[0]?.args, [
    "ls-remote",
    "https://x-access-token:ghp_secret@github.com/acme/app.git",
    "refs/heads/feat/x",
  ]);
});

test("does not inject a token into a non-https remote", async () => {
  const { runner, calls } = runnerReturning({ stdout: "abc123\trefs/heads/feat/x\n" });
  const verifier = new CommandGitVerifier({ remote: "origin", token: "ghp_secret", runner });
  await verifier.remoteRefExists("feat/x", "abc123");
  assert.deepEqual(calls[0]?.args, ["ls-remote", "origin", "refs/heads/feat/x"]);
});

test("remoteRefExists is false when the ref moved or ls-remote failed", async () => {
  const moved = runnerReturning({ stdout: "deadbeef\trefs/heads/feat/x\n" });
  assert.equal(
    await new CommandGitVerifier(options(moved.runner)).remoteRefExists("feat/x", "abc123"),
    false,
  );

  const failed = runnerReturning({ code: 2 });
  assert.equal(
    await new CommandGitVerifier(options(failed.runner)).remoteRefExists("feat/x", "abc123"),
    false,
  );
});

test("isAncestorOfMain maps exit code to a boolean", async () => {
  const yes = runnerReturning({ code: 0 });
  assert.equal(await new CommandGitVerifier(options(yes.runner)).isAncestorOfMain("m1"), true);

  const no = runnerReturning({ code: 1 });
  assert.equal(await new CommandGitVerifier(options(no.runner)).isAncestorOfMain("m1"), false);
});

test("branchDeleted is true only when the remote has no such branch", async () => {
  const gone = runnerReturning({ stdout: "" });
  assert.equal(await new CommandGitVerifier(options(gone.runner)).branchDeleted("feat/x"), true);

  const present = runnerReturning({ stdout: "abc123\trefs/heads/feat/x\n" });
  assert.equal(await new CommandGitVerifier(options(present.runner)).branchDeleted("feat/x"), false);

  const failed = runnerReturning({ code: 2 });
  assert.equal(await new CommandGitVerifier(options(failed.runner)).branchDeleted("feat/x"), false);
});
