import type { GitVerifier } from "../loop/types.ts";
import type { CommandRunner } from "../provision/types.ts";

export interface GitVerifierOptions {
  /** Remote URL or name to verify against (e.g. a git URL, or `origin` with `repoDir`). */
  remote: string;
  runner: CommandRunner;
  /** Local clone. Only required for the ancestry check (`isAncestorOfMain`). */
  repoDir?: string;
  /** Ref the reviewer merges into (default `refs/heads/main`). */
  mainRef?: string;
}

/**
 * Verifies author/reviewer handoffs against the git remote. `remoteRefExists` and
 * `branchDeleted` run against the remote URL directly (`git ls-remote`), so an author
 * handoff needs no local clone; only the reviewer's ancestry check needs one.
 * See docs/handoff.md.
 */
export class CommandGitVerifier implements GitVerifier {
  private readonly remote: string;
  private readonly runner: CommandRunner;
  private readonly repoDir: string | undefined;
  private readonly mainRef: string;

  constructor(options: GitVerifierOptions) {
    this.remote = options.remote;
    this.runner = options.runner;
    this.repoDir = options.repoDir;
    this.mainRef = options.mainRef ?? "refs/heads/main";
  }

  private withRepo(args: string[]): string[] {
    return this.repoDir === undefined ? args : ["-C", this.repoDir, ...args];
  }

  async remoteRefExists(branch: string, sha: string): Promise<boolean> {
    const result = await this.runner.run(
      "git",
      this.withRepo(["ls-remote", this.remote, `refs/heads/${branch}`]),
    );
    if (result.code !== 0) return false;
    // `ls-remote` prints "<sha>\t<ref>"; the ref must still point at the reviewed commit.
    return result.stdout.split("\n").some((line) => line.split("\t")[0] === sha);
  }

  async isAncestorOfMain(sha: string): Promise<boolean> {
    if (this.repoDir === undefined) {
      throw new Error("CommandGitVerifier: isAncestorOfMain requires a local clone (repoDir)");
    }
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
    const result = await this.runner.run(
      "git",
      this.withRepo(["ls-remote", "--heads", this.remote, `refs/heads/${branch}`]),
    );
    return result.code === 0 && result.stdout.trim().length === 0;
  }
}
