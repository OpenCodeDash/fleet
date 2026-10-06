import type { GitVerifier } from "../loop/types.ts";
import type { CommandRunner } from "../provision/types.ts";

export interface GitVerifierOptions {
  /** Local clone the orchestrator uses for verification. */
  repoDir: string;
  runner: CommandRunner;
  /** Remote name (default `origin`). */
  remote?: string;
  /** Ref the reviewer merges into (default `refs/heads/main`). */
  mainRef?: string;
}

/** Verifies author/reviewer handoffs against the git remote. See docs/handoff.md. */
export class CommandGitVerifier implements GitVerifier {
  private readonly repoDir: string;
  private readonly runner: CommandRunner;
  private readonly remote: string;
  private readonly mainRef: string;

  constructor(options: GitVerifierOptions) {
    this.repoDir = options.repoDir;
    this.runner = options.runner;
    this.remote = options.remote ?? "origin";
    this.mainRef = options.mainRef ?? "refs/heads/main";
  }

  async remoteRefExists(branch: string, sha: string): Promise<boolean> {
    const result = await this.runner.run("git", [
      "-C",
      this.repoDir,
      "ls-remote",
      this.remote,
      `refs/heads/${branch}`,
    ]);
    if (result.code !== 0) return false;
    // `ls-remote` prints "<sha>\t<ref>"; the ref must still point at the reviewed commit.
    return result.stdout
      .split("\n")
      .some((line) => line.split("\t")[0] === sha);
  }

  async isAncestorOfMain(sha: string): Promise<boolean> {
    const result = await this.runner.run("git", [
      "-C",
      this.repoDir,
      "merge-base",
      "--is-ancestor",
      sha,
      this.mainRef,
    ]);
    return result.code === 0;
  }

  async branchDeleted(branch: string): Promise<boolean> {
    const result = await this.runner.run("git", [
      "-C",
      this.repoDir,
      "ls-remote",
      "--heads",
      this.remote,
      `refs/heads/${branch}`,
    ]);
    return result.code === 0 && result.stdout.trim().length === 0;
  }
}
