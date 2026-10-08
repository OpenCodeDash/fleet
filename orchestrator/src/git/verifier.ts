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
  /** Token for a private `https://` remote; injected as `x-access-token:<token>@`. */
  token?: string;
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
  private readonly token: string | undefined;

  constructor(options: GitVerifierOptions) {
    this.remote = options.remote;
    this.runner = options.runner;
    this.repoDir = options.repoDir;
    this.mainRef = options.mainRef ?? "refs/heads/main";
    this.token = options.token;
  }

  private withRepo(args: string[]): string[] {
    return this.repoDir === undefined ? args : ["-C", this.repoDir, ...args];
  }

  /** The remote URL, with the token embedded for a private `https://` remote. */
  private remoteUrl(): string {
    if (this.token === undefined || this.token.length === 0 || !this.remote.startsWith("https://")) {
      return this.remote;
    }
    return this.remote.replace(/^https:\/\//, `https://x-access-token:${this.token}@`);
  }

  async remoteRefExists(branch: string, sha: string): Promise<boolean> {
    const result = await this.runner.run(
      "git",
      this.withRepo(["ls-remote", this.remoteUrl(), `refs/heads/${branch}`]),
    );
    if (result.code !== 0) return false;
    // `ls-remote` prints "<sha>\t<ref>"; the ref must still point at the reviewed commit.
    return result.stdout.split("\n").some((line) => line.split("\t")[0] === sha);
  }

  async isAncestorOfMain(sha: string): Promise<boolean> {
    if (this.repoDir === undefined) {
      throw new Error("CommandGitVerifier: isAncestorOfMain requires a local clone (repoDir)");
    }
    // Fetch the current main tip, then check ancestry against it (a local clone's refs go
    // stale once the reviewer merges upstream).
    await this.runner.run("git", [
      "-C",
      this.repoDir,
      "fetch",
      "--quiet",
      this.remoteUrl(),
      this.mainRef,
    ]);
    const result = await this.runner.run("git", [
      "-C",
      this.repoDir,
      "merge-base",
      "--is-ancestor",
      sha,
      "FETCH_HEAD",
    ]);
    return result.code === 0;
  }

  async branchDeleted(branch: string): Promise<boolean> {
    const result = await this.runner.run(
      "git",
      this.withRepo(["ls-remote", "--heads", this.remoteUrl(), `refs/heads/${branch}`]),
    );
    return result.code === 0 && result.stdout.trim().length === 0;
  }
}
